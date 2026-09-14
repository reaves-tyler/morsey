import { CwDecoder, DEFAULT_DECODER_CONFIG, type CwDecoderConfig, type CwDecoderState } from '~/utils/cwDecoder'
import { toInt16, wavHeader16 } from '~/utils/cwSynth'
import { MonitorAgc, MONITOR_AGC_LOOKAHEAD_MS } from '~/utils/monitorAgc'

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
 *      ├────→ [AnalyserNode] (spectrum display, unfiltered so QRM is visible)
 *      ├────→ [AudioWorklet: PCM forwarder] → recorder (raw WAV capture)
 *      └────→ [AudioWorklet: leveller (AGC)] → [GainNode: monitor] → destination (headphones)
 *
 * Sources: the rig on a line / aux input (a laptop's combo jack or a USB
 * sound card), a microphone held to the rig's speaker, or an audio file.
 * `line` and `mic` are the same browser API (getUserMedia) with separate
 * device memories — a laptop lists its jack and its built-in mic as two
 * inputs and "default" is almost always the mic, which is exactly the wrong
 * one for a cable from the radio.
 *
 * Monitor: plugging into a rig's headphone jack silences its speaker, so the
 * live input is passed straight through to the computer's output (headphones)
 * at an adjustable level. Line inputs monitor by default; a microphone into
 * speakers is a feedback loop, so the mic monitor defaults off and the UI
 * says to wear headphones. The output device can be chosen where the browser
 * supports `AudioContext.setSinkId` (Chromium). The leveller (utils/monitorAgc.ts)
 * evens out the rig's near-full-scale sidetone and its much quieter receive
 * audio so the operator stops riding the volume between over and back; the
 * monitor slider then sets the listening level of the levelled signal.
 *
 * Module-level singleton like useKeyer: the graph survives navigation, like
 * a rig left switched on; only Stop tears it down.
 */

export type DecoderSource = 'line' | 'mic' | 'file'

/** the two live (getUserMedia) sources */
export type LiveSource = Exclude<DecoderSource, 'file'>
export function isLive(src: DecoderSource): src is LiveSource {
  return src === 'line' || src === 'mic'
}

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
  /** pass the line / aux input and audio files through to the output (headphones) */
  monitor: boolean
  /** pass a live microphone through to the output — off by default (feedback through speakers) */
  monitorMic: boolean
  /** monitor gain, 0–2 (unity = 1); the rig's AF gain sets the decoder level, this sets the headphone level */
  monitorLevel: number
  /** level the monitor with the AGC so transmit sidetone and receive audio come out at the same volume */
  monitorAgc: boolean
  /** apply the analog-style bandpass pre-filter before the detector */
  prefilter: boolean
  /** remembered line / aux input device (`DEFAULT_DEVICE` = auto: the jack or USB codec if one is recognised, else the browser default) */
  lineDeviceId: string
  /** remembered microphone device (`DEFAULT_DEVICE` = browser default) */
  micDeviceId: string
  /** remembered output device for the monitor (`DEFAULT_DEVICE` = browser default; needs `setSinkId`) */
  outputDeviceId: string
}

/** Sentinel for "browser default / auto" — select items may not use an empty string as a value */
export const DEFAULT_DEVICE = 'default'

/**
 * Input labels that look like a cable input rather than a microphone. Browsers
 * expose no "line-in" kind, so this is a label heuristic: combo jacks report
 * "External Microphone" / "Headset", desktop codecs "Line In", USB sound
 * cards their product name.
 */
const LINE_LABEL = /line|aux|external|headset|jack|usb|codec|cable|sound ?card|interface/i

const SETTINGS_KEY = 'morsey-decode-v1'
/** the terminal is a log tail: it survives Stop, level resets and reloads, and only Clear empties it */
const LOG_KEY = 'morsey-decode-log-v1'
const LOG_LIMIT = 20000
/** silence this long starts a new line, so separate transmissions don't run together */
const IDLE_NEWLINE_MS = 5000

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
    monitorMic: false,
    monitorLevel: 1,
    monitorAgc: true,
    prefilter: true,
    lineDeviceId: DEFAULT_DEVICE,
    micDeviceId: DEFAULT_DEVICE,
    outputDeviceId: DEFAULT_DEVICE
  }
}

export interface AudioDevice {
  deviceId: string
  label: string
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

/**
 * The worklets are tiny and dependency-free, so they ship inline as a Blob —
 * no base-URL or precache concerns. The leveller embeds the pure MonitorAgc
 * class verbatim (it is written to be self-contained for exactly this; the
 * unit tests check that) and reports its gain to the main thread ~10×/s.
 */
const WORKLET_SOURCE = `
// bound by name here because the bundler renames the class in the source text
const MonitorAgc = ${MonitorAgc.toString()}
class MonitorLeveller extends AudioWorkletProcessor {
  constructor() {
    super()
    this.agc = new MonitorAgc(sampleRate)
    this.since = 0
    this.port.onmessage = (e) => {
      if (e.data && typeof e.data.enabled === 'boolean') this.agc.setEnabled(e.data.enabled)
      if (e.data && e.data.reset) this.agc.reset()
    }
  }
  process(inputs, outputs) {
    const inp = inputs[0] && inputs[0][0]
    const out = outputs[0] && outputs[0][0]
    if (!out) return true
    if (inp) {
      this.agc.process(inp, out)
      this.since += inp.length
      if (this.since >= sampleRate / 10) {
        this.since = 0
        this.port.postMessage(this.agc.gainDb())
      }
    } else {
      out.fill(0)
    }
    return true
  }
}
registerProcessor('morsey-monitor-leveller', MonitorLeveller)
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
const source = ref<DecoderSource>('line')
const text = ref('')
const pattern = ref('')
const error = ref('')
/** audio inputs (labels are empty until the first permission grant — see `requestDevicePermission`) */
const devices = ref<AudioDevice[]>([])
/** audio outputs — only populated where the browser can route the context (`setSinkId`) */
const outputs = ref<AudioDevice[]>([])
/** whether at least one input carries a label, i.e. permission has been granted once */
const devicesLabelled = computed(() => devices.value.some(d => d.label && !/^Input \d+$/.test(d.label)))
const fileName = ref('')
const playbackProgress = ref(0) // 0..1 for the file source
/**
 * Measured monitor delay, input → headphones, in ms (0 = unknown). Capture
 * buffer (track settings) + context base latency + output device latency.
 * The browser's shared-mode audio stack sets the floor here, not the graph:
 * for a zero-delay sidetone the operator splits the rig's headphone out.
 */
const latencyMs = ref(0)
/** gain the monitor leveller is currently applying, dB (what the AGC readout shows) */
const monitorGainDb = ref(0)
const meter = ref<CwDecoderState>({
  magnitude: 0, floor: 0, peak: 0, threshold: 0, snrDb: 0, keyed: false,
  ditMs: 60, dahMs: 180, wpm: 20, letterGapMs: 180, wordGapMs: 420, pattern: '', timeMs: 0, calibrated: false, confidence: 1
})
/**
 * Raw-input recorder (for capturing real on-air audio to replay through the
 * decoder tests). A take is independent of listening: pause keeps it, Stop
 * listening only pauses it, export downloads and ends it, discard drops it.
 * Nothing here touches the decoder or the terminal.
 */
export type RecordingState = 'idle' | 'recording' | 'paused'
const recordingState = ref<RecordingState>('idle')
const recording = computed(() => recordingState.value === 'recording')
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
/** the leveller in front of the monitor gain (null where AudioWorklet is unavailable: monitor is then unlevelled) */
let agcNode: AudioWorkletNode | null = null
let sinkGain: GainNode | null = null
let rafHandle = 0
let playbackStart = 0
let playbackDuration = 0
let settingsLoaded = false
let watchersAttached = false
/** decoder-time (ms) of the last key edge, for the idle newline */
let lastKeyMs = 0
let loadedFile: AudioBuffer | null = null
let deviceListenerAttached = false

/**
 * `AudioContext.setSinkId` is Chromium-only so far; Firefox/Safari follow the OS
 * default output. Decided after hydration (the prerendered HTML has no output
 * picker, so deciding during setup would be a hydration mismatch).
 */
const canSelectOutput = ref(false)

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
      canSelectOutput.value = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype
      try {
        const log = localStorage.getItem(LOG_KEY)
        if (log && !text.value) text.value = log
      } catch { /* unavailable storage */ }
      try {
        const raw = localStorage.getItem(SETTINGS_KEY)
        if (raw) {
          const stored = JSON.parse(raw) as Partial<DecodeSettings> & { deviceId?: string }
          // v1 had a single "Radio input" device: that was the cable from the rig
          if (stored.deviceId && !stored.lineDeviceId) stored.lineDeviceId = stored.deviceId
          delete stored.deviceId
          settings.value = { ...defaultSettings(), ...stored }
        }
        for (const k of ['lineDeviceId', 'micDeviceId', 'outputDeviceId'] as const) {
          if (!settings.value[k]) settings.value[k] = DEFAULT_DEVICE
        }
      } catch { /* corrupt or unavailable storage: keep defaults */ }
    })
  }
  if (import.meta.client && !watchersAttached) {
    watchersAttached = true
    let prevPrefilter = settings.value.prefilter
    let prevLine = settings.value.lineDeviceId
    let prevMic = settings.value.micDeviceId
    let prevOut = settings.value.outputDeviceId
    watch(text, (t) => {
      // keep the tail if the log outgrows the cap
      if (t.length > LOG_LIMIT) {
        const cut = t.indexOf('\n', t.length - LOG_LIMIT)
        text.value = t.slice(cut >= 0 ? cut + 1 : t.length - LOG_LIMIT)
        return
      }
      try { localStorage.setItem(LOG_KEY, t) } catch { /* storage full/unavailable */ }
    })
    watch(settings, (s) => {
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)) } catch { /* storage full/unavailable */ }
      applySettings(s)
      if (s.prefilter !== prevPrefilter) {
        prevPrefilter = s.prefilter
        rewire()
      }
      // a live input follows its device choice immediately
      if (s.lineDeviceId !== prevLine) {
        prevLine = s.lineDeviceId
        if (listening.value && source.value === 'line') start()
      }
      if (s.micDeviceId !== prevMic) {
        prevMic = s.micDeviceId
        if (listening.value && source.value === 'mic') start()
      }
      if (s.outputDeviceId !== prevOut) {
        prevOut = s.outputDeviceId
        applySink()
      }
    }, { deep: true })
  }
  if (import.meta.client && !deviceListenerAttached && navigator.mediaDevices?.addEventListener) {
    deviceListenerAttached = true
    // plugging a cable into a combo jack or a USB codec changes the list
    navigator.mediaDevices.addEventListener('devicechange', () => { refreshDevices() })
  }

  /** what the monitor gain should be for the current source and settings */
  function monitorTarget(s: DecodeSettings): number {
    const on = source.value === 'mic' ? s.monitorMic : s.monitor
    return on ? Math.max(0, Math.min(2, s.monitorLevel)) : 0
  }

  /** route the context to the chosen output where the browser allows it */
  async function applySink() {
    if (!ctx || !canSelectOutput.value) return
    const id = settings.value.outputDeviceId
    try {
      // an empty string means "system default" to setSinkId
      await (ctx as AudioContext & { setSinkId(id: string): Promise<void> }).setSinkId(id === DEFAULT_DEVICE ? '' : id)
    } catch {
      // device unplugged since it was remembered: fall back to the default rather than staying silent
      settings.value.outputDeviceId = DEFAULT_DEVICE
    }
  }

  function applySettings(s: DecodeSettings) {
    decoder?.configure(toEngineConfig(s))
    if (filterNode && ctx) {
      filterNode.frequency.setTargetAtTime(s.centerHz, ctx.currentTime, 0.02)
      filterNode.Q.setTargetAtTime(prefilterQ(s), ctx.currentTime, 0.02)
    }
    if (monitorGain && ctx) monitorGain.gain.setTargetAtTime(monitorTarget(s), ctx.currentTime, 0.02)
    agcNode?.port.postMessage({ enabled: s.monitorAgc })
  }

  /** (re)connect source → [filter] → tap, honouring the prefilter toggle */
  function rewire() {
    if (!sourceNode || !ctx) return
    const tap: AudioNode | null = workletNode ?? scriptNode
    if (!tap) return
    try { sourceNode.disconnect() } catch { /* not connected yet */ }
    try { filterNode?.disconnect() } catch { /* not connected yet */ }
    if (analyser) sourceNode.connect(analyser)
    if (agcNode) sourceNode.connect(agcNode)
    else if (monitorGain) sourceNode.connect(monitorGain)
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
        onWordGap: () => { if (text.value && !/[ \n]$/.test(text.value)) text.value += ' ' },
        onPattern: (p) => { pattern.value = p },
        onKey: (_down, atMs) => { lastKeyMs = atMs },
        onElement: (el, ms) => {
          elements.value.push({ el, ms })
          if (elements.value.length > 40) elements.value.shift()
        }
      }
    )
  }

  /** Load the inline worklet module once; false where AudioWorklet is unavailable or blocked. */
  async function loadWorklet(audio: AudioContext): Promise<boolean> {
    if (!audio.audioWorklet) return false
    if (workletLoaded) return true
    try {
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }))
      await audio.audioWorklet.addModule(url)
      URL.revokeObjectURL(url)
      workletLoaded = true
      return true
    } catch (err) {
      // older Safari, or CSP blocking blob workers — or a broken inline module, which must not fail silently
      console.warn('[decode] AudioWorklet unavailable, falling back to ScriptProcessor:', err)
      return false
    }
  }

  /** A node that hands every 1024-sample PCM block to `onBlock` (worklet, with ScriptProcessor fallback). */
  async function buildTap(audio: AudioContext, onBlock: (block: Float32Array) => void): Promise<AudioNode> {
    if (await loadWorklet(audio)) {
      try {
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
    // 'interactive' keeps the input → headphone passthrough latency at the hardware minimum
    const audio = new AudioContext({ latencyHint: 'interactive' })
    ctx = audio
    makeDecoder(audio.sampleRate)
    applySink()

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
    // leveller in front of the monitor gain — see utils/monitorAgc.ts
    if (await loadWorklet(audio)) {
      try {
        agcNode = new AudioWorkletNode(audio, 'morsey-monitor-leveller', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, outputChannelCount: [1] })
        agcNode.port.onmessage = (e: MessageEvent<number>) => { monitorGainDb.value = e.data }
        agcNode.port.postMessage({ enabled: settings.value.monitorAgc })
        agcNode.connect(monitorGain)
      } catch {
        agcNode = null
      }
    }

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
      // Chromium adds "default" / "communications" aliases of a real device;
      // "default" collides with our sentinel and both would list a device twice
      const real = all.filter(d => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      devices.value = real
        .filter(d => d.kind === 'audioinput')
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Input ${i + 1}` }))
      outputs.value = canSelectOutput.value
        ? real.filter(d => d.kind === 'audiooutput').map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Output ${i + 1}` }))
        : []
    } catch { /* permissions not granted yet: labels come after the first getUserMedia */ }
  }

  /**
   * Device labels are blank until the page has been granted audio capture once.
   * Ask for it (any input), release the stream immediately and re-enumerate, so
   * the operator can pick the jack by name before pressing Start.
   */
  async function requestDevicePermission(): Promise<string | null> {
    if (!import.meta.client || !navigator.mediaDevices?.getUserMedia) return 'This browser cannot capture audio input.'
    if (devicesLabelled.value) {
      await refreshDevices()
      return null
    }
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      for (const track of probe.getTracks()) track.stop()
      await refreshDevices()
      return null
    } catch (err: any) {
      const msg = describeCaptureError(err)
      error.value = msg
      return msg
    }
  }

  /** The line input the auto setting would pick: the first jack / USB-looking device, if any */
  const suggestedLineDevice = computed<AudioDevice | null>(() =>
    devices.value.find(d => LINE_LABEL.test(d.label) && !/^Input \d+$/.test(d.label)) ?? null
  )

  /** Resolve a source's device setting to what getUserMedia should be asked for (null = browser default) */
  function resolveDevice(src: LiveSource): string | null {
    const chosen = src === 'line' ? settings.value.lineDeviceId : settings.value.micDeviceId
    if (chosen && chosen !== DEFAULT_DEVICE) return chosen
    if (src === 'line') return suggestedLineDevice.value?.deviceId ?? null
    return null
  }

  /** input → output delay estimate in ms from what the browser is willing to report */
  function measureLatency(audio: AudioContext, s: MediaStream): number {
    const track = s.getAudioTracks()[0]
    const input = track ? Number((track.getSettings() as Record<string, unknown>).latency ?? 0) : 0
    const output = Number((audio as AudioContext & { outputLatency?: number }).outputLatency ?? 0)
    return Math.round((input + audio.baseLatency + output) * 1000)
  }

  function describeCaptureError(err: any): string {
    switch (err?.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'Audio capture was denied. Allow it in the browser’s site settings and try again.'
      case 'NotFoundError':
        return 'No audio input device found.'
      case 'OverconstrainedError':
      case 'NotReadableError':
        return 'The selected input isn’t available — plug it in, or pick another device.'
      default:
        return err?.message ?? 'Could not start the decoder.'
    }
  }

  /** end the current line if it has text (the terminal is a log: lines separate transmissions) */
  function newline() {
    const t = text.value.replace(/ +$/, '')
    if (t && !t.endsWith('\n')) text.value = t + '\n'
  }

  function tick() {
    if (decoder) {
      meter.value = decoder.getState()
      if (meter.value.timeMs - lastKeyMs >= IDLE_NEWLINE_MS) newline()
    }
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

  function playBuffer(audio: AudioContext, buffer: AudioBuffer) {
    bufferSource = audio.createBufferSource()
    bufferSource.buffer = buffer
    sourceNode = bufferSource
    playbackStart = audio.currentTime
    playbackDuration = buffer.duration
    bufferSource.onended = () => {
      decoder?.flush()
      if (listening.value && source.value === 'file') stop()
    }
    rewire()
    bufferSource.start()
  }

  /**
   * Start decoding from the selected source. Returns null on success or an
   * operator-readable error.
   */
  async function start(): Promise<string | null> {
    if (!import.meta.client) return null
    error.value = ''
    try {
      const audio = await ensureGraph()
      if (audio.state === 'suspended') await audio.resume()
      teardownSource()
      decoder?.reset()
      agcNode?.port.postMessage({ reset: true })
      lastKeyMs = 0
      pattern.value = ''
      elements.value = []
      recentChars.value = []
      // the terminal keeps its log across restarts; a new session starts a new line
      newline()

      const src = source.value
      if (isLive(src)) {
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
        const deviceId = resolveDevice(src)
        if (deviceId) constraints.deviceId = { exact: deviceId }
        // ask for the smallest capture buffer the device offers (Chromium honours
        // this hint; TS's lib.dom dropped it, so it goes in untyped)
        ;(constraints as Record<string, unknown>).latency = { ideal: 0 }
        stream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false })
        sourceNode = audio.createMediaStreamSource(stream)
        // the leveller's lookahead delay sits in the monitor path whether or not it is levelling
        latencyMs.value = measureLatency(audio, stream) + (agcNode ? MONITOR_AGC_LOOKAHEAD_MS : 0)
        rewire()
        refreshDevices()
        // A microphone hears the keyer sidetone from the speakers and would
        // decode it; a cable from the rig cannot, so the sidetone stays.
        audioOut.setSidetoneMuted(src === 'mic')
      } else {
        if (!loadedFile) throw new Error('Choose an audio file first.')
        latencyMs.value = 0
        audioOut.setSidetoneMuted(false)
        playBuffer(audio, loadedFile)
      }
      // headphone passthrough — see monitorTarget for the per-source policy
      if (monitorGain) monitorGain.gain.setTargetAtTime(monitorTarget(settings.value), audio.currentTime, 0.02)

      listening.value = true
      cancelAnimationFrame(rafHandle)
      tick()
      return null
    } catch (err: any) {
      const msg = describeCaptureError(err)
      error.value = msg
      listening.value = false
      teardownSource()
      return msg
    }
  }

  // ---- raw-input recorder -------------------------------------------------------------

  function onRecordBlock(block: Float32Array) {
    if (recordingState.value !== 'recording' || !sourceNode) return
    recordChunks.push(toInt16(block))
    recordedBytes.value += block.length * 2
    recordedSeconds.value = recordedBytes.value / 2 / recordSampleRate
    // full: hold the take rather than lose it — the operator exports it
    if (recordedBytes.value >= RECORD_LIMIT_BYTES) pauseRecording()
  }

  /** Start a new take, or resume a paused one, while listening. */
  function startRecording(): boolean {
    if (!ctx || !listening.value || recordingState.value === 'recording') return false
    if (recordingState.value === 'idle') {
      recordChunks = []
      recordedBytes.value = 0
      recordedSeconds.value = 0
      recordSampleRate = ctx.sampleRate
    } else if (recordedBytes.value >= RECORD_LIMIT_BYTES) {
      return false
    }
    recordingState.value = 'recording'
    return true
  }

  /** Hold the take; resume with startRecording, or export / discard it. */
  function pauseRecording() {
    if (recordingState.value === 'recording') recordingState.value = 'paused'
  }

  /** Drop the take entirely. */
  function discardRecording() {
    recordingState.value = 'idle'
    recordChunks = []
    recordedBytes.value = 0
    recordedSeconds.value = 0
  }

  /**
   * End the take and hand back the WAV (16-bit mono at the context rate), or
   * null if nothing was captured. Works while recording or paused.
   */
  function exportRecording(): { blob: Blob; seconds: number; sampleRate: number } | null {
    if (recordingState.value === 'idle') return null
    const chunks = recordChunks
    const rate = recordSampleRate
    discardRecording()
    const numSamples = chunks.reduce((n, c) => n + c.length, 0)
    if (numSamples === 0) return null
    const parts: BlobPart[] = [wavHeader16(rate, numSamples), ...chunks.map(c => c.buffer as ArrayBuffer)]
    return { blob: new Blob(parts, { type: 'audio/wav' }), seconds: numSamples / rate, sampleRate: rate }
  }

  function stop() {
    decoder?.flush()
    // the take survives a Stop: nothing is exported or dropped without the operator asking
    pauseRecording()
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

  /** Re-learn the noise floor and signal peak (after a volume or gain change). Text and timing stay. */
  function resetLevels() {
    decoder?.resetLevels()
    if (decoder) {
      lastKeyMs = decoder.getState().timeMs
      meter.value = decoder.getState()
    }
    pattern.value = ''
  }

  /** The only thing that empties the terminal. */
  function clear() {
    text.value = ''
    try { localStorage.removeItem(LOG_KEY) } catch { /* ok */ }
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

  /** Filter/threshold defaults; device choices and monitor routing are wiring, not tuning, and stay */
  function resetSettings() {
    const { lineDeviceId, micDeviceId, outputDeviceId, monitor, monitorMic, monitorLevel, monitorAgc } = settings.value
    settings.value = { ...defaultSettings(), lineDeviceId, micDeviceId, outputDeviceId, monitor, monitorMic, monitorLevel, monitorAgc }
  }

  return {
    // state
    listening, source, text, pattern, error, devices, outputs, devicesLabelled, suggestedLineDevice, canSelectOutput,
    fileName, playbackProgress, latencyMs, monitorGainDb, meter, elements, settings, report,
    recording, recordingState, recordedSeconds, recordedBytes,
    // actions
    start, stop, clear, loadFile, refreshDevices, requestDevicePermission, resetTiming, resetLevels, resetSettings, spectrum, spectrumBins,
    startRecording, pauseRecording, exportRecording, discardRecording
  }
}
