import { CwDecoder, DEFAULT_DECODER_CONFIG, type CwDecoderConfig, type CwDecoderState } from '~/utils/cwDecoder'
import { renderCw, SAMPLE_PRESETS, toInt16, wavHeader16, type CwSynthOptions } from '~/utils/cwSynth'

/**
 * Browser adapter for the pure CW stream decoder (utils/cwDecoder.ts).
 *
 * Owns the Web Audio graph and nothing else: PCM blocks flow from the source
 * through an optional bandpass pre-filter into an AudioWorklet that forwards
 * them to the main thread, where the decoder runs. All timing is derived
 * from sample counts inside the decoder, so main-thread jitter never touches
 * element lengths.
 *
 *   [source] → [BiquadFilter bandpass] → [AudioWorklet: PCM forwarder] → decoder
 *      └────→ [AnalyserNode] (spectrum display, unfiltered so QRM is visible)
 *
 * Sources: a microphone / line input (the radio), a synthesized sample from
 * the preset library (for testing without hardware), or an audio file.
 *
 * Module-level singleton like useKeyer: the graph survives navigation, like
 * a rig left switched on; only Stop tears it down.
 */

export type DecoderSource = 'mic' | 'sample' | 'file'

export interface DecodeSettings {
  centerHz: number
  bandwidthHz: number
  thresholdMode: 'auto' | 'manual'
  /** manual threshold in dBFS (-60 … 0) — shown to the operator in dB, converted for the engine */
  manualThresholdDb: number
  minSnrDb: number
  noiseBlankerMs: number
  speedAveraging: number
  initialWpm: number
  lockSpeed: boolean
  /** route the audio being decoded to the speakers (samples/files only — never the mic) */
  monitor: boolean
  /** apply the analog-style bandpass pre-filter before the detector */
  prefilter: boolean
  /** remembered input device (`DEFAULT_DEVICE` = let the browser choose) */
  deviceId: string
}

/** Sentinel for "browser default input" — select items may not use an empty string as a value */
export const DEFAULT_DEVICE = 'default'

const SETTINGS_KEY = 'morsey-decode-v1'

function defaultSettings(): DecodeSettings {
  return {
    centerHz: DEFAULT_DECODER_CONFIG.centerHz,
    bandwidthHz: DEFAULT_DECODER_CONFIG.bandwidthHz,
    thresholdMode: 'auto',
    manualThresholdDb: -20,
    minSnrDb: DEFAULT_DECODER_CONFIG.minSnrDb,
    noiseBlankerMs: DEFAULT_DECODER_CONFIG.noiseBlankerMs,
    speedAveraging: DEFAULT_DECODER_CONFIG.speedAveraging,
    initialWpm: DEFAULT_DECODER_CONFIG.initialWpm,
    lockSpeed: false,
    monitor: true,
    prefilter: true,
    deviceId: DEFAULT_DEVICE
  }
}

export interface SignalReport {
  /** S-units 0–9 from the in-passband signal-to-noise (noise floor ≈ S3, 36 dB over it = S9) */
  sUnits: number
  /** dB over S9 */
  plusDb: number
  /** RST readability 1–5 from recent decode quality, 0 when nothing is heard */
  r: number
  /** RST strength 1–9 */
  s: number
  /** RST tone — 9 assumed for a keyed carrier (tone quality is not assessed) */
  t: number
  /** '599' style string, or '—' with no signal */
  rst: string
  /** fraction of the recent characters that decoded to a known pattern */
  copyQuality: number
  /** decoder timing confidence 0..1 (elements clear of the dit/dah and gap boundaries) */
  confidence: number
}

/** The worklet is tiny and dependency-free, so it ships inline as a Blob — no base-URL or precache concerns. */
const WORKLET_SOURCE = `
class PcmForwarder extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(1024)
    this.pos = 0
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.pos++] = ch[i]
        if (this.pos === this.buf.length) {
          this.port.postMessage(this.buf, [this.buf.buffer])
          this.buf = new Float32Array(1024)
          this.pos = 0
        }
      }
    }
    return true
  }
}
registerProcessor('morsey-pcm-forwarder', PcmForwarder)
`

// ---- Shared state (module-level) ------------------------------------------------

const listening = ref(false)
const source = ref<DecoderSource>('sample')
const text = ref('')
const pattern = ref('')
const error = ref('')
const devices = ref<{ deviceId: string; label: string }[]>([])
const sampleId = ref(SAMPLE_PRESETS[0]!.id)
const fileName = ref('')
const playbackProgress = ref(0) // 0..1 for sample/file sources
const meter = ref<CwDecoderState>({
  magnitude: 0, floor: 0, peak: 0, threshold: 0, snrDb: 0, keyed: false,
  ditMs: 60, dahMs: 180, wpm: 20, letterGapMs: 180, wordGapMs: 420, pattern: '', timeMs: 0, calibrated: false, confidence: 1
})
/** raw-input recorder (for capturing real on-air audio to replay through the decoder tests) */
const recording = ref(false)
const recordedSeconds = ref(0)
const recordedBytes = ref(0)
/** ~10 minutes at 48 kHz, 16-bit */
const RECORD_LIMIT_BYTES = 60 * 1024 * 1024
/** recent classified elements for the element ribbon */
const elements = ref<{ el: '.' | '-'; ms: number }[]>([])
/** last decoded characters: true = known pattern (for the readability estimate) */
const recentChars = ref<boolean[]>([])

let ctx: AudioContext | null = null
let decoder: CwDecoder | null = null
let stream: MediaStream | null = null
let sourceNode: AudioNode | null = null
let bufferSource: AudioBufferSourceNode | null = null
let filterNode: BiquadFilterNode | null = null
let workletNode: AudioWorkletNode | null = null
let scriptNode: ScriptProcessorNode | null = null
let recorderNode: AudioNode | null = null
let workletLoaded = false
let recordChunks: Int16Array[] = []
let recordSampleRate = 0
let analyser: AnalyserNode | null = null
let monitorGain: GainNode | null = null
let sinkGain: GainNode | null = null
let rafHandle = 0
let playbackStart = 0
let playbackDuration = 0
let settingsLoaded = false
let watchersAttached = false
let loadedFile: AudioBuffer | null = null

function toEngineConfig(s: DecodeSettings): Partial<CwDecoderConfig> {
  return {
    centerHz: s.centerHz,
    bandwidthHz: s.bandwidthHz,
    thresholdMode: s.thresholdMode,
    manualThreshold: Math.pow(10, s.manualThresholdDb / 20),
    minSnrDb: s.minSnrDb,
    noiseBlankerMs: s.noiseBlankerMs,
    speedAveraging: s.speedAveraging,
    initialWpm: s.initialWpm,
    lockSpeed: s.lockSpeed
  }
}

/** Biquad Q for the pre-filter: Q = f / bandwidth, kept in the 5–50 range a rig's CW filter offers */
function prefilterQ(s: DecodeSettings): number {
  return Math.min(50, Math.max(5, s.centerHz / Math.max(20, s.bandwidthHz * 2)))
}

export function useCwStreamDecoder() {
  const audioOut = useMorseAudio()
  // useState needs the Nuxt instance, so it lives here rather than at module scope
  const settings = useState<DecodeSettings>('morsey-decode-settings', defaultSettings)

  // ---- settings persistence (after hydration, like useProgress) ----
  if (import.meta.client && !settingsLoaded) {
    settingsLoaded = true
    onNuxtReady(() => {
      try {
        const raw = localStorage.getItem(SETTINGS_KEY)
        if (raw) settings.value = { ...defaultSettings(), ...JSON.parse(raw) }
        if (!settings.value.deviceId) settings.value.deviceId = DEFAULT_DEVICE
      } catch { /* corrupt or unavailable storage: keep defaults */ }
    })
  }
  if (import.meta.client && !watchersAttached) {
    watchersAttached = true
    let prevPrefilter = settings.value.prefilter
    let prevDevice = settings.value.deviceId
    watch(settings, (s) => {
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)) } catch { /* storage full/unavailable */ }
      applySettings(s)
      if (s.prefilter !== prevPrefilter) {
        prevPrefilter = s.prefilter
        rewire()
      }
      if (s.deviceId !== prevDevice) {
        prevDevice = s.deviceId
        // a live radio input follows the device choice immediately
        if (listening.value && source.value === 'mic') start()
      }
    }, { deep: true })
  }

  function applySettings(s: DecodeSettings) {
    decoder?.configure(toEngineConfig(s))
    if (filterNode && ctx) {
      filterNode.frequency.setTargetAtTime(s.centerHz, ctx.currentTime, 0.02)
      filterNode.Q.setTargetAtTime(prefilterQ(s), ctx.currentTime, 0.02)
    }
    if (monitorGain) monitorGain.gain.value = s.monitor && source.value !== 'mic' ? 1 : 0
  }

  /** (re)connect source → [filter] → tap, honouring the prefilter toggle */
  function rewire() {
    if (!sourceNode || !ctx) return
    const tap: AudioNode | null = workletNode ?? scriptNode
    if (!tap) return
    try { sourceNode.disconnect() } catch { /* not connected yet */ }
    try { filterNode?.disconnect() } catch { /* not connected yet */ }
    if (analyser) sourceNode.connect(analyser)
    if (monitorGain) sourceNode.connect(monitorGain)
    if (recorderNode) sourceNode.connect(recorderNode)
    if (settings.value.prefilter && filterNode) {
      sourceNode.connect(filterNode)
      filterNode.connect(tap)
    } else {
      sourceNode.connect(tap)
    }
  }

  function makeDecoder(sampleRate: number) {
    decoder = new CwDecoder(
      { sampleRate, ...toEngineConfig(settings.value) },
      {
        onCharacter: (ch) => {
          text.value += ch
          recentChars.value.push(ch !== '*')
          if (recentChars.value.length > 20) recentChars.value.shift()
        },
        onWordGap: () => { if (text.value && !text.value.endsWith(' ')) text.value += ' ' },
        onPattern: (p) => { pattern.value = p },
        onElement: (el, ms) => {
          elements.value.push({ el, ms })
          if (elements.value.length > 40) elements.value.shift()
        }
      }
    )
  }

  /** A node that hands every 1024-sample PCM block to `onBlock` (worklet, with ScriptProcessor fallback). */
  async function buildTap(audio: AudioContext, onBlock: (block: Float32Array) => void): Promise<AudioNode> {
    if (audio.audioWorklet) {
      try {
        if (!workletLoaded) {
          const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }))
          await audio.audioWorklet.addModule(url)
          URL.revokeObjectURL(url)
          workletLoaded = true
        }
        const node = new AudioWorkletNode(audio, 'morsey-pcm-forwarder', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 })
        node.port.onmessage = (e: MessageEvent<Float32Array>) => onBlock(e.data)
        return node
      } catch {
        // fall through to ScriptProcessor (older Safari, or CSP blocking blob workers)
      }
    }
    const node = audio.createScriptProcessor(1024, 1, 1)
    node.onaudioprocess = (e) => onBlock(e.inputBuffer.getChannelData(0))
    return node
  }

  async function ensureGraph(): Promise<AudioContext> {
    if (ctx) return ctx
    const audio = new AudioContext()
    ctx = audio
    makeDecoder(audio.sampleRate)

    filterNode = audio.createBiquadFilter()
    filterNode.type = 'bandpass'
    filterNode.frequency.value = settings.value.centerHz
    filterNode.Q.value = prefilterQ(settings.value)

    analyser = audio.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0.6

    monitorGain = audio.createGain()
    monitorGain.gain.value = 0
    monitorGain.connect(audio.destination)

    // The tap runs whenever the graph does — between runs it carries silence,
    // which must not reach the decoder (it would warm up on nothing and then
    // mistake the real noise floor for signal when the source starts)
    const tap = await buildTap(audio, (block) => { if (sourceNode) decoder?.process(block) })
    if (tap instanceof AudioWorkletNode) workletNode = tap
    else scriptNode = tap as ScriptProcessorNode
    // Taps must be connected to the destination to be pulled by the graph;
    // their output is silenced so nothing leaks into the speakers.
    sinkGain = audio.createGain()
    sinkGain.gain.value = 0
    tap.connect(sinkGain).connect(audio.destination)
    // second tap on the *raw* source for the recorder (before the pre-filter)
    recorderNode = await buildTap(audio, onRecordBlock)
    recorderNode.connect(sinkGain)
    return audio
  }

  async function refreshDevices() {
    if (!import.meta.client || !navigator.mediaDevices?.enumerateDevices) return
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      devices.value = all
        .filter(d => d.kind === 'audioinput')
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Input ${i + 1}` }))
    } catch { /* permissions not granted yet: labels come after the first getUserMedia */ }
  }

  function tick() {
    if (decoder) meter.value = decoder.getState()
    if (playbackDuration > 0 && ctx) {
      playbackProgress.value = Math.min(1, (ctx.currentTime - playbackStart) / playbackDuration)
    }
    rafHandle = requestAnimationFrame(tick)
  }

  function teardownSource() {
    if (bufferSource) {
      try { bufferSource.stop() } catch { /* already stopped */ }
      bufferSource.onended = null
      bufferSource = null
    }
    if (stream) {
      for (const track of stream.getTracks()) track.stop()
      stream = null
    }
    if (sourceNode) {
      try { sourceNode.disconnect() } catch { /* ok */ }
      sourceNode = null
    }
    playbackDuration = 0
    playbackProgress.value = 0
  }

  /** Render a preset (or custom options) into an AudioBuffer at the context rate */
  function renderSample(audio: AudioContext, opts: Omit<CwSynthOptions, 'sampleRate'>): AudioBuffer {
    const { samples, sampleRate } = renderCw({ sampleRate: audio.sampleRate, ...opts })
    const buffer = audio.createBuffer(1, samples.length, sampleRate)
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0)
    return buffer
  }

  function playBuffer(audio: AudioContext, buffer: AudioBuffer) {
    bufferSource = audio.createBufferSource()
    bufferSource.buffer = buffer
    sourceNode = bufferSource
    playbackStart = audio.currentTime
    playbackDuration = buffer.duration
    bufferSource.onended = () => {
      decoder?.flush()
      if (listening.value && source.value !== 'mic') stop()
    }
    rewire()
    bufferSource.start()
  }

  /**
   * Start decoding from the selected source. Returns null on success or an
   * operator-readable error.
   */
  async function start(customSample?: Omit<CwSynthOptions, 'sampleRate'>): Promise<string | null> {
    if (!import.meta.client) return null
    error.value = ''
    try {
      const audio = await ensureGraph()
      if (audio.state === 'suspended') await audio.resume()
      teardownSource()
      decoder?.reset()
      pattern.value = ''
      elements.value = []
      recentChars.value = []

      if (source.value === 'mic') {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot capture audio input.')
        // Everything a voice-call browser does to audio is wrong for CW:
        // AGC pumps on every element, noise suppression eats the tone,
        // echo cancellation notches it.
        const constraints: MediaTrackConstraints = {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1
        }
        if (settings.value.deviceId && settings.value.deviceId !== DEFAULT_DEVICE) {
          constraints.deviceId = { exact: settings.value.deviceId }
        }
        stream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false })
        sourceNode = audio.createMediaStreamSource(stream)
        rewire()
        refreshDevices()
        // never route a live input to the speakers: that is a feedback loop
        if (monitorGain) monitorGain.gain.value = 0
        audioOut.setSidetoneMuted(true)
      } else if (source.value === 'sample') {
        const preset = SAMPLE_PRESETS.find(p => p.id === sampleId.value) ?? SAMPLE_PRESETS[0]!
        const buffer = renderSample(audio, customSample ?? preset.options)
        if (monitorGain) monitorGain.gain.value = settings.value.monitor ? 1 : 0
        playBuffer(audio, buffer)
      } else {
        if (!loadedFile) throw new Error('Choose an audio file first.')
        if (monitorGain) monitorGain.gain.value = settings.value.monitor ? 1 : 0
        playBuffer(audio, loadedFile)
      }

      listening.value = true
      cancelAnimationFrame(rafHandle)
      tick()
      return null
    } catch (err: any) {
      const msg = err?.name === 'NotAllowedError'
        ? 'Microphone access was denied. Allow it in the browser’s site settings and try again.'
        : err?.name === 'NotFoundError'
          ? 'No audio input device found.'
          : err?.message ?? 'Could not start the decoder.'
      error.value = msg
      listening.value = false
      teardownSource()
      return msg
    }
  }

  // ---- raw-input recorder -------------------------------------------------------------

  function onRecordBlock(block: Float32Array) {
    if (!recording.value || !sourceNode) return
    recordChunks.push(toInt16(block))
    recordedBytes.value += block.length * 2
    recordedSeconds.value = recordedBytes.value / 2 / recordSampleRate
    if (recordedBytes.value >= RECORD_LIMIT_BYTES) stopRecording()
  }

  /** Start capturing the raw input (pre-filter) while listening. */
  function startRecording(): boolean {
    if (!ctx || !listening.value || recording.value) return false
    recordChunks = []
    recordedBytes.value = 0
    recordedSeconds.value = 0
    recordSampleRate = ctx.sampleRate
    recording.value = true
    return true
  }

  /** Stop capturing; returns the WAV (16-bit mono at the context rate) or null if nothing was captured. */
  function stopRecording(): { blob: Blob; seconds: number; sampleRate: number } | null {
    if (!recording.value) return null
    recording.value = false
    const chunks = recordChunks
    recordChunks = []
    const numSamples = chunks.reduce((n, c) => n + c.length, 0)
    if (numSamples === 0) return null
    const parts: BlobPart[] = [wavHeader16(recordSampleRate, numSamples), ...chunks.map(c => c.buffer as ArrayBuffer)]
    return { blob: new Blob(parts, { type: 'audio/wav' }), seconds: numSamples / recordSampleRate, sampleRate: recordSampleRate }
  }

  function stop() {
    decoder?.flush()
    teardownSource()
    cancelAnimationFrame(rafHandle)
    rafHandle = 0
    listening.value = false
    audioOut.setSidetoneMuted(false)
    if (decoder) meter.value = decoder.getState()
  }

  async function loadFile(file: File): Promise<string | null> {
    try {
      const audio = await ensureGraph()
      const data = await file.arrayBuffer()
      loadedFile = await audio.decodeAudioData(data)
      fileName.value = file.name
      source.value = 'file'
      return null
    } catch (err: any) {
      error.value = `Could not decode ${file.name}: ${err?.message ?? 'unsupported format'}`
      return error.value
    }
  }

  function clear() {
    text.value = ''
    pattern.value = ''
    elements.value = []
    recentChars.value = []
  }

  /**
   * Signal report in the operator's own terms. Strength follows the S-meter
   * convention of 6 dB per S-unit with the band noise sitting around S3.
   * Readability combines how much of the recent copy decoded to known
   * characters with the decoder's own timing confidence (how far elements
   * sat from the dit/dah and gap boundaries), so a strong but sloppy fist
   * and a weak clean one read differently. Very low signal-to-noise caps it.
   */
  const report = computed<SignalReport>(() => {
    const m = meter.value
    // the meter holds its last reading after Stop, so the report does too (like an S-meter's peak hold)
    const heard = m.floor > 0 && m.snrDb >= 6
    const snr = heard ? m.snrDb : 0
    const sRaw = heard ? 3 + snr / 6 : 0
    const sUnits = Math.min(9, Math.max(0, sRaw))
    const plusDb = Math.max(0, Math.round(snr - 36))
    const recent = recentChars.value
    const copyQuality = recent.length ? recent.filter(Boolean).length / recent.length : 1
    const confidence = Math.min(1, Math.max(0, m.confidence))
    let r = 0
    if (heard || recent.length) {
      // unknown patterns weigh most; timing ambiguity trims the rest
      const score = copyQuality * (0.6 + 0.4 * confidence)
      r = score >= 0.9 ? 5 : score >= 0.75 ? 4 : score >= 0.55 ? 3 : score >= 0.35 ? 2 : 1
      if (heard && snr < 8) r = Math.min(r, 3)
      else if (heard && snr < 10) r = Math.min(r, 4)
    }
    const sReport = heard ? Math.max(1, Math.round(sUnits)) : 0
    const rst = heard ? `${r}${sReport}9` : '—'
    return { sUnits, plusDb, r, s: sReport, t: 9, rst, copyQuality, confidence }
  })

  /** Re-seed the timing tracker (e.g. after the operator changes the speed prior). */
  function resetTiming() {
    decoder?.resetTiming()
  }

  /** dB spectrum for the display: returns null when the graph isn't running */
  function spectrum(out: Float32Array): { binHz: number } | null {
    if (!analyser || !ctx || !listening.value) return null
    analyser.getFloatFrequencyData(out as Float32Array<ArrayBuffer>)
    return { binHz: ctx.sampleRate / analyser.fftSize }
  }

  function spectrumBins(): number {
    return analyser ? analyser.frequencyBinCount : 1024
  }

  function resetSettings() {
    const keepDevice = settings.value.deviceId
    settings.value = { ...defaultSettings(), deviceId: keepDevice }
  }

  return {
    // state
    listening, source, text, pattern, error, devices, sampleId, fileName, playbackProgress, meter, elements, settings, report,
    recording, recordedSeconds, recordedBytes,
    // actions
    start, stop, clear, loadFile, refreshDevices, resetTiming, resetSettings, spectrum, spectrumBins,
    startRecording, stopRecording,
    presets: SAMPLE_PRESETS
  }
}
