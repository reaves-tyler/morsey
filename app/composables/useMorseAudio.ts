import { MORSE, morseTimings, textToSchedule } from '~/utils/morse'

/**
 * Web Audio engine. Two paths:
 *  - playText(): schedules a full message (Koch/Farnsworth playback)
 *  - keyDown()/keyUp(): zero-latency sidetone for the sending keyer
 *
 * Uses a single shared AudioContext with a gain envelope (5 ms ramps) so tones
 * never click.
 */

const RAMP = 0.005

let ctx: AudioContext | null = null
let playbackNodes: { osc: OscillatorNode; gain: GainNode } | null = null
let playbackTimer: ReturnType<typeof setTimeout> | null = null
let playbackResolve: (() => void) | null = null
let keyNodes: { osc: OscillatorNode; gain: GainNode } | null = null
/** band-condition nodes active during the current playback */
let bandNodes: AudioNode[] = []
let noiseBuffer: AudioBuffer | null = null

function whiteNoise(audio: AudioContext): AudioBuffer {
  if (!noiseBuffer) {
    noiseBuffer = audio.createBuffer(1, audio.sampleRate * 2, audio.sampleRate)
    const data = noiseBuffer.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  }
  return noiseBuffer
}

function ensureCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext()
  if (ctx.state === 'suspended') ctx.resume()
  return ctx
}

export function useMorseAudio() {
  const { progress } = useProgress()
  const playing = useState('morsey-audio-playing', () => false)

  function stop() {
    if (playbackTimer) {
      clearTimeout(playbackTimer)
      playbackTimer = null
    }
    // Resolve any pending playText() promise so callers awaiting playback
    // that gets interrupted (e.g. answering early) don't hang forever
    if (playbackResolve) {
      const resolve = playbackResolve
      playbackResolve = null
      resolve()
    }
    if (playbackNodes && ctx) {
      const { osc, gain } = playbackNodes
      gain.gain.cancelScheduledValues(ctx.currentTime)
      gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime)
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + RAMP)
      osc.stop(ctx.currentTime + RAMP + 0.01)
      playbackNodes = null
    }
    stopBand()
    playing.value = false
  }

  function stopBand() {
    for (const node of bandNodes) {
      try {
        if ('stop' in node) (node as OscillatorNode).stop()
        node.disconnect()
      } catch { /* already stopped */ }
    }
    bandNodes = []
  }

  /**
   * Simulated band conditions, applied to receive playback only:
   *  - QRN: white noise through a bandpass at the sidetone frequency — what
   *    atmospheric static sounds like inside a receiver's CW filter
   *  - QSB: slow fading — a 0.1-0.3 Hz LFO modulating the signal chain gain
   *  - QRM: a weaker off-frequency station sending random characters
   * Returns the node the signal chain should terminate into.
   */
  function buildBand(audio: AudioContext, start: number, total: number): AudioNode {
    const s = progress.value.settings
    let signalOut: AudioNode = audio.destination

    if (s.qsbDepth > 0) {
      // signal → qsbGain → destination; LFO wiggles qsbGain.gain around a base
      const qsbGain = audio.createGain()
      const depth = Math.min(0.95, s.qsbDepth)
      qsbGain.gain.value = 1 - depth / 2
      const lfo = audio.createOscillator()
      lfo.type = 'sine'
      lfo.frequency.value = 0.1 + Math.random() * 0.2
      const lfoAmp = audio.createGain()
      lfoAmp.gain.value = depth / 2
      lfo.connect(lfoAmp).connect(qsbGain.gain)
      qsbGain.connect(audio.destination)
      lfo.start(start)
      lfo.stop(start + total + 0.2)
      bandNodes.push(lfo, lfoAmp, qsbGain)
      signalOut = qsbGain
    }

    if (s.qrnLevel > 0) {
      const src = audio.createBufferSource()
      src.buffer = whiteNoise(audio)
      src.loop = true
      const filter = audio.createBiquadFilter()
      filter.type = 'bandpass'
      filter.frequency.value = s.freq
      filter.Q.value = 0.9
      const noiseGain = audio.createGain()
      // fade the noise in/out so toggling never clicks
      const level = s.qrnLevel * s.volume * 0.9
      noiseGain.gain.setValueAtTime(0, start - 0.05 > audio.currentTime ? start - 0.05 : audio.currentTime)
      noiseGain.gain.linearRampToValueAtTime(level, start + 0.1)
      noiseGain.gain.setValueAtTime(level, start + total)
      noiseGain.gain.linearRampToValueAtTime(0, start + total + 0.1)
      src.connect(filter).connect(noiseGain).connect(audio.destination)
      src.start(audio.currentTime)
      src.stop(start + total + 0.2)
      bandNodes.push(src, filter, noiseGain)
    }

    if (s.qrm) {
      // A second station, off-frequency and weaker, sending random characters
      const chars = Object.keys(MORSE)
      let text = ''
      for (let i = 0; i < 10; i++) text += chars[Math.floor(Math.random() * chars.length)]
      const t = morseTimings(22, 22)
      const { segments } = textToSchedule(text, t)
      const osc = audio.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = s.freq + (Math.random() < 0.5 ? -1 : 1) * (150 + Math.random() * 250)
      const qrmGain = audio.createGain()
      qrmGain.gain.value = 0
      const level = s.volume * 0.22
      const offset = Math.random() * total * 0.3
      for (const seg of segments) {
        const at = start + offset + seg.at
        if (at + seg.dur > start + total) break
        qrmGain.gain.setValueAtTime(0, at)
        qrmGain.gain.linearRampToValueAtTime(level, at + RAMP)
        qrmGain.gain.setValueAtTime(level, at + seg.dur - RAMP)
        qrmGain.gain.linearRampToValueAtTime(0, at + seg.dur)
      }
      osc.connect(qrmGain).connect(audio.destination)
      osc.start(start)
      osc.stop(start + total + 0.1)
      bandNodes.push(osc, qrmGain)
    }

    return signalOut
  }

  /**
   * Play text as morse using the user's character/effective WPM settings.
   * Resolves when playback finishes (or immediately if stopped).
   */
  function playText(text: string, opts?: { charWpm?: number; effectiveWpm?: number }): Promise<void> {
    if (!import.meta.client) return Promise.resolve()
    stop()

    const s = progress.value.settings
    const t = morseTimings(opts?.charWpm ?? s.charWpm, opts?.effectiveWpm ?? s.effectiveWpm)
    const { segments, total } = textToSchedule(text, t)
    if (segments.length === 0) return Promise.resolve()

    const audio = ensureCtx()
    const osc = audio.createOscillator()
    const gain = audio.createGain()
    osc.type = 'sine'
    osc.frequency.value = s.freq
    gain.gain.value = 0

    const start = audio.currentTime + 0.06
    // Route the signal through the band-condition chain (QSB fading), and let
    // QRN/QRM sources run alongside for the playback window
    osc.connect(gain).connect(buildBand(audio, start, total))
    const vol = s.volume
    for (const seg of segments) {
      gain.gain.setValueAtTime(0, start + seg.at)
      gain.gain.linearRampToValueAtTime(vol, start + seg.at + RAMP)
      gain.gain.setValueAtTime(vol, start + seg.at + seg.dur - RAMP)
      gain.gain.linearRampToValueAtTime(0, start + seg.at + seg.dur)
    }

    osc.start(start)
    osc.stop(start + total + 0.1)
    playbackNodes = { osc, gain }
    playing.value = true

    return new Promise((resolve) => {
      playbackResolve = resolve
      playbackTimer = setTimeout(() => {
        playbackNodes = null
        playbackTimer = null
        playbackResolve = null
        playing.value = false
        resolve()
      }, (total + 0.12) * 1000)
    })
  }

  /**
   * Short non-morse feedback cues for eyes-free training: a rising chirp for
   * correct, a low buzz for wrong. Distinct in pitch and timbre from the
   * sidetone so they can never be confused with code.
   */
  function playCue(kind: 'good' | 'bad') {
    if (!import.meta.client) return
    const audio = ensureCtx()
    const osc = audio.createOscillator()
    const gain = audio.createGain()
    osc.connect(gain).connect(audio.destination)
    const vol = progress.value.settings.volume * 0.45
    const t = audio.currentTime
    gain.gain.value = 0
    if (kind === 'good') {
      osc.type = 'sine'
      osc.frequency.setValueAtTime(1100, t)
      osc.frequency.setValueAtTime(1500, t + 0.06)
      gain.gain.linearRampToValueAtTime(vol, t + 0.01)
      gain.gain.setValueAtTime(vol, t + 0.1)
      gain.gain.linearRampToValueAtTime(0, t + 0.12)
      osc.start(t)
      osc.stop(t + 0.14)
    } else {
      osc.type = 'triangle'
      osc.frequency.value = 200
      gain.gain.linearRampToValueAtTime(vol, t + 0.01)
      gain.gain.setValueAtTime(vol, t + 0.16)
      gain.gain.linearRampToValueAtTime(0, t + 0.19)
      osc.start(t)
      osc.stop(t + 0.21)
    }
  }

  /** Start the continuous sidetone (keyer pressed). */
  function keyDown() {
    if (!import.meta.client) return
    const audio = ensureCtx()
    const s = progress.value.settings
    if (!keyNodes) {
      const osc = audio.createOscillator()
      const gain = audio.createGain()
      osc.type = 'sine'
      osc.frequency.value = s.freq
      gain.gain.value = 0
      osc.connect(gain).connect(audio.destination)
      osc.start()
      keyNodes = { osc, gain }
    }
    keyNodes.osc.frequency.setValueAtTime(s.freq, audio.currentTime)
    keyNodes.gain.gain.cancelScheduledValues(audio.currentTime)
    keyNodes.gain.gain.setValueAtTime(keyNodes.gain.gain.value, audio.currentTime)
    keyNodes.gain.gain.linearRampToValueAtTime(s.volume, audio.currentTime + RAMP)
  }

  /** Stop the sidetone (keyer released). */
  function keyUp() {
    if (!keyNodes || !ctx) return
    keyNodes.gain.gain.cancelScheduledValues(ctx.currentTime)
    keyNodes.gain.gain.setValueAtTime(keyNodes.gain.gain.value, ctx.currentTime)
    keyNodes.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + RAMP)
  }

  return { playText, playCue, stop, keyDown, keyUp, playing }
}
