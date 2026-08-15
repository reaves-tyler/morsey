import { morseTimings, textToSchedule } from '~/utils/morse'

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
    playing.value = false
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
    osc.connect(gain).connect(audio.destination)

    const start = audio.currentTime + 0.06
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
