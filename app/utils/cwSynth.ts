import { MORSE, morseTimings, textToSchedule, type MorseTimings, type ToneSegment } from './morse.ts'

/**
 * Deterministic CW band-audio synthesizer — the test fixture and sample
 * generator for the stream decoder. Pure: no Web Audio, so it runs in Vitest
 * and in Node (scripts/gen-cw-samples.ts) as well as in the browser (the
 * decode page renders presets into an AudioBuffer).
 *
 * Models the things that break real-world decoders:
 *  - noise (QRN) at a chosen SNR, quoted the way hams quote it: in a 2.5 kHz
 *    SSB bandwidth, so 0 dB is "just audible in the receiver"
 *  - QSB fading (slow sinusoidal amplitude modulation, arbitrary depth)
 *  - QRM: a second keyed carrier offset in pitch
 *  - hand-sent timing: per-element jitter, dah weight, stretched spacing
 *  - keying envelope rise/fall (5 ms is the usual rig shaping; 0 = hard keying,
 *    which produces key clicks the detector must tolerate)
 *  - frequency drift and a pitch offset from the decoder's centre
 *  - HF multipath fading: the ITU-R F.1487 (Watterson) channel — independent
 *    Rayleigh-faded paths with a Gaussian Doppler spectrum and a delay spread —
 *    which is what the ionosphere does to a carrier, as opposed to the tidy
 *    sinusoid of `qsb`
 *  - real band noise: any recorded noise bed in place of white noise, scaled
 *    to the same SNR convention
 *
 * `renderRtty` renders the other thing on the CW bands that sounds like very
 * fast code through a narrow filter — 45.45 baud, 170 Hz-shift Baudot — so the
 * decoder can be tested on what it must *not* print.
 */

export interface CwSynthOptions {
  text: string
  sampleRate?: number
  /** character speed */
  wpm?: number
  /** effective (Farnsworth) speed; defaults to wpm */
  effectiveWpm?: number
  toneHz?: number
  /** tone amplitude 0..1 */
  amplitude?: number
  /** SNR in dB referenced to a 2.5 kHz bandwidth; Infinity = no noise */
  snrDb?: number
  /** QSB: fading depth 0..1 and rate in Hz */
  qsb?: { depth: number; rateHz: number }
  /** QRM: one or more interfering stations (level relative to the wanted signal) */
  qrm?: QrmStation | QrmStation[]
  /** dah length in dits (3 = standard; heavy fists 3.5–4) */
  weight?: number
  /** random timing jitter as a fraction of each element/gap (0.15 = sloppy hand) */
  jitter?: number
  /**
   * Spacing multipliers on the standard 1 / 3 / 7-dit gaps — a straight-key
   * novice leaves 1.3–1.6 dits between the elements of a letter and 5–15
   * between letters, which is the fist the letter-boundary logic has to follow.
   */
  spacing?: { element?: number; letter?: number; word?: number }
  /** HF multipath fading (ITU-R F.1487 / Watterson); applied to the wanted signal */
  fading?: FadingChannel
  /**
   * Recorded noise bed used instead of white noise (same sample rate), scaled
   * so `snrDb` keeps its meaning; read from `noiseOffset` samples in, looping.
   */
  noise?: Float32Array
  noiseOffset?: number
  /** keying envelope rise/fall in ms */
  riseMs?: number
  /** linear frequency drift over the whole clip, Hz */
  driftHz?: number
  /** silence before/after the message, seconds */
  leadInSec?: number
  tailSec?: number
  /** PRNG seed */
  seed?: number
}

export interface QrmStation {
  offsetHz: number
  level: number
  text?: string
  wpm?: number
  /** seconds of silence before the interferer starts (default 0.1) */
  startSec?: number
}

/**
 * ITU-R F.1487 channel conditions are quoted as a frequency spread (2σ of the
 * Gaussian Doppler spectrum) and a differential delay: "good" 0.1 Hz / 0.5 ms,
 * "moderate" 0.5 Hz / 1 ms, "poor" 1 Hz / 2 ms, "flutter" (auroral) 10 Hz.
 */
export interface FadingChannel {
  /** frequency spread 2σ, Hz */
  spreadHz: number
  /** differential delay of the second path, ms (0 = a single faded path) */
  delayMs?: number
  /** number of equal-power independently faded paths (default 2) */
  paths?: 1 | 2
}

export const ITU_CHANNELS: Record<'good' | 'moderate' | 'poor' | 'flutter', FadingChannel> = {
  good: { spreadHz: 0.1, delayMs: 0.5 },
  moderate: { spreadHz: 0.5, delayMs: 1 },
  poor: { spreadHz: 1, delayMs: 2 },
  flutter: { spreadHz: 10, delayMs: 0.5 }
}

export interface CwSynthResult {
  samples: Float32Array
  sampleRate: number
  /** the tone schedule actually rendered (after jitter/weight), for timing assertions */
  segments: ToneSegment[]
  /** duration in seconds */
  duration: number
}

/** mulberry32 — small, fast, deterministic */
export function makeRng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  /** standard normal via Box–Muller */
  const gauss = () => {
    let u = 0
    while (u === 0) u = next()
    const v = next()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
  return { next, gauss }
}

/**
 * Apply hand-sent character to a machine schedule: dah weight, per-element
 * jitter. Gaps are re-derived so the schedule stays consistent.
 */
function humanize(
  text: string,
  t: MorseTimings,
  weight: number,
  jitter: number,
  rng: ReturnType<typeof makeRng>,
  spacing: { element?: number; letter?: number; word?: number } = {}
): { segments: ToneSegment[]; total: number } {
  const base = textToSchedule(text, t)
  const se = spacing.element ?? 1
  const sl = spacing.letter ?? 1
  const sw = spacing.word ?? 1
  if (weight === 3 && jitter === 0 && se === 1 && sl === 1 && sw === 1) return base

  const segments: ToneSegment[] = []
  let cursor = 0
  let prevEnd = 0
  const j = (x: number) => x * (1 + jitter * rng.gauss() * 0.5)
  for (let i = 0; i < base.segments.length; i++) {
    const seg = base.segments[i]!
    const isDah = seg.dur > t.dit * 2
    const dur = j(isDah ? t.dit * weight : t.dit)
    if (i > 0) {
      const gap = seg.at - prevEnd
      // which gap this is, from the machine schedule: element, letter or word
      const scale = gap > (t.charGap + t.wordGap) / 2 ? sw : gap > (t.elementGap + t.charGap) / 2 ? sl : se
      cursor += Math.max(t.dit * 0.4, j(gap * scale))
    }
    segments.push({ at: cursor, dur })
    cursor += dur
    prevEnd = seg.at + seg.dur
  }
  return { segments, total: cursor }
}

/** Noise RMS for a target SNR quoted in a 2.5 kHz bandwidth. */
export function noiseRmsForSnr(snrDb: number, amplitude: number, sampleRate: number): number {
  if (!Number.isFinite(snrDb)) return 0
  const signalRms = amplitude / Math.SQRT2
  // white noise of RMS σ over the full Nyquist band has σ²·(2500 / (fs/2)) power in 2.5 kHz
  const bwFraction = Math.min(1, 2500 / (sampleRate / 2))
  const noiseInBand = signalRms / Math.pow(10, snrDb / 20)
  return noiseInBand / Math.sqrt(bwFraction)
}

/**
 * Add noise of RMS `sigma` (white by default). A recorded bed is scaled to that
 * RMS so the SNR convention holds — but its *spectrum* is kept, which is the
 * point: a rig's CW filter peaks real band noise right where the tone is, so
 * it costs more than white noise at the same quoted SNR.
 */
function addNoise(out: Float32Array, sigma: number, sampleRate: number, rng: ReturnType<typeof makeRng>, bed?: Float32Array, offset = 0) {
  if (!bed || !bed.length) {
    for (let i = 0; i < out.length; i++) out[i] = out[i]! + sigma * rng.gauss()
    return
  }
  let sum = 0
  for (const v of bed) sum += v * v
  const rms = Math.sqrt(sum / bed.length)
  if (!(rms > 0)) return
  // `noiseRmsForSnr` assumes white noise across Nyquist; a bed at another
  // rate would shift the in-band share, so this only holds at the bed's rate
  void sampleRate
  const g = sigma / rms
  for (let i = 0; i < out.length; i++) out[i] = out[i]! + g * bed[(i + offset) % bed.length]!
}

/**
 * One Rayleigh-faded path: a complex Gaussian process with a Gaussian Doppler
 * spectrum of 2σ width `spreadHz`, normalised to RMS `rms`, at audio rate.
 * Generated at a low control rate and linearly interpolated — the spectrum is
 * a few Hz wide at most.
 */
function rayleighTap(n: number, sampleRate: number, spreadHz: number, rng: ReturnType<typeof makeRng>, rms: number): { re: Float32Array; im: Float32Array } {
  const re = new Float32Array(n)
  const im = new Float32Array(n)
  const ctrlHz = Math.min(400, Math.max(20, 20 * spreadHz))
  const m = Math.ceil((n / sampleRate) * ctrlHz) + 2
  const sigmaF = Math.max(1e-3, spreadHz / 2)
  const sigmaT = (1 / (2 * Math.PI * sigmaF)) * ctrlHz // kernel σ in control samples
  const half = Math.min(Math.ceil(4 * sigmaT), 4 * m)
  const kernel = new Float64Array(2 * half + 1)
  for (let k = -half; k <= half; k++) kernel[k + half] = Math.exp(-(k * k) / (2 * sigmaT * sigmaT))
  const wr = new Float64Array(m + 2 * half)
  const wi = new Float64Array(m + 2 * half)
  for (let i = 0; i < wr.length; i++) { wr[i] = rng.gauss(); wi[i] = rng.gauss() }
  const cr = new Float64Array(m)
  const ci = new Float64Array(m)
  let power = 0
  for (let i = 0; i < m; i++) {
    let a = 0
    let b = 0
    for (let k = 0; k < kernel.length; k++) { a += kernel[k]! * wr[i + k]!; b += kernel[k]! * wi[i + k]! }
    cr[i] = a
    ci[i] = b
    power += a * a + b * b
  }
  const g = rms / Math.sqrt(power / m || 1)
  for (let i = 0; i < n; i++) {
    const x = (i / sampleRate) * ctrlHz
    const i0 = Math.min(m - 2, Math.floor(x))
    const f = x - i0
    re[i] = g * (cr[i0]! * (1 - f) + cr[i0 + 1]! * f)
    im[i] = g * (ci[i0]! * (1 - f) + ci[i0 + 1]! * f)
  }
  return { re, im }
}

/**
 * When each character of `text` ends in a rendered schedule, in seconds — the
 * ground truth for measuring how long a decoder takes to print it. Prosigns are
 * one character; spaces have no entry.
 */
export function characterEndTimes(text: string, segments: ToneSegment[]): { ch: string; end: number }[] {
  const out: { ch: string; end: number }[] = []
  let seg = 0
  for (const word of text.trim().toUpperCase().split(/\s+/)) {
    for (const token of word.match(/<[A-Z]+>|./g) ?? []) {
      const code = token.startsWith('<')
        ? token.slice(1, -1).split('').map(l => MORSE[l] ?? '').join('')
        : MORSE[token] ?? ''
      if (!code) continue
      seg += code.length
      const last = segments[seg - 1]
      if (last) out.push({ ch: token, end: last.at + last.dur })
    }
  }
  return out
}

export function renderCw(opts: CwSynthOptions): CwSynthResult {
  const sampleRate = opts.sampleRate ?? 8000
  const wpm = opts.wpm ?? 20
  const effectiveWpm = opts.effectiveWpm ?? wpm
  const toneHz = opts.toneHz ?? 700
  const amplitude = opts.amplitude ?? 0.5
  const weight = opts.weight ?? 3
  const jitter = opts.jitter ?? 0
  const riseMs = opts.riseMs ?? 5
  const leadIn = opts.leadInSec ?? 0.3
  const tail = opts.tailSec ?? 0.5
  const rng = makeRng(opts.seed ?? 1)

  const t = morseTimings(wpm, effectiveWpm)
  const { segments: raw, total } = humanize(opts.text, t, weight, jitter, rng, opts.spacing)
  const segments = raw.map(s => ({ at: s.at + leadIn, dur: s.dur }))
  const duration = leadIn + total + tail
  const n = Math.ceil(duration * sampleRate)
  const out = new Float32Array(n)

  // --- keyed carrier via a per-sample gain envelope ---
  // The rise/fall is centred on the nominal edges (50 % amplitude exactly at
  // the scheduled key-down/key-up instants), so element lengths are
  // preserved through the shaping.
  const env = new Float32Array(n)
  const rise = Math.max(1, Math.round((riseMs / 1000) * sampleRate))
  const paint = (target: Float32Array, startSec: number, durSec: number) => {
    const s0 = Math.round(startSec * sampleRate) - Math.floor(rise / 2)
    const s1 = Math.round((startSec + durSec) * sampleRate) + Math.ceil(rise / 2)
    for (let i = Math.max(0, s0); i < Math.min(n, s1); i++) {
      const up = Math.min(1, (i - s0 + 1) / rise)
      const down = Math.min(1, (s1 - i) / rise)
      target[i] = Math.max(target[i]!, Math.min(up, down))
    }
  }
  for (const seg of segments) paint(env, seg.at, seg.dur)
  const drift = opts.driftHz ?? 0
  let phase = 0
  const qsbGain = (i: number) => opts.qsb && opts.qsb.depth > 0
    ? 1 - opts.qsb.depth * (0.5 + 0.5 * Math.sin(2 * Math.PI * opts.qsb.rateHz * (i / sampleRate) - Math.PI / 2))
    : 1
  if (!opts.fading) {
    for (let i = 0; i < n; i++) {
      const f = toneHz + (drift * i) / n
      phase += (2 * Math.PI * f) / sampleRate
      out[i] = amplitude * env[i]! * qsbGain(i) * Math.sin(phase)
    }
  } else {
    // Multipath: each path is the same keyed carrier, delayed, times its own
    // complex Rayleigh tap. Summing them is what fills a gap with the tail of
    // the previous element (delay spread) and takes whole elements out (fades).
    const ph = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const f = toneHz + (drift * i) / n
      phase += (2 * Math.PI * f) / sampleRate
      ph[i] = phase
    }
    const paths = opts.fading.paths ?? 2
    const delay = Math.round(((opts.fading.delayMs ?? 0) / 1000) * sampleRate)
    for (let p = 0; p < paths; p++) {
      const tap = rayleighTap(n, sampleRate, opts.fading.spreadHz, rng, 1 / Math.sqrt(paths))
      const d = p * delay
      for (let i = d; i < n; i++) {
        const k = i - d
        const a = amplitude * env[k]! * qsbGain(i)
        if (a === 0) continue
        // the tap (re, im) scales and rotates the carrier; an unfaded (1, 0) leaves it as sin φ
        out[i] = out[i]! + a * (tap.re[i]! * Math.sin(ph[k]!) + tap.im[i]! * Math.cos(ph[k]!))
      }
    }
  }

  // --- QRM: other stations ---
  const qrms = opts.qrm ? (Array.isArray(opts.qrm) ? opts.qrm : [opts.qrm]) : []
  for (const q of qrms) {
    if (!(q.level > 0)) continue
    const qt = morseTimings(q.wpm ?? 22, q.wpm ?? 22)
    const qText = q.text ?? 'VVV DE QRM QRM'
    const qsched = textToSchedule(qText, qt)
    // loop the interferer across the whole clip
    const qenv = new Float32Array(n)
    let offset = q.startSec ?? 0.1
    while (offset < duration) {
      for (const seg of qsched.segments) paint(qenv, offset + seg.at, seg.dur)
      offset += qsched.total + qt.wordGap * 2
    }
    let qphase = 0
    const qf = toneHz + q.offsetHz
    for (let i = 0; i < n; i++) {
      qphase += (2 * Math.PI * qf) / sampleRate
      out[i] = out[i]! + amplitude * q.level * qenv[i]! * Math.sin(qphase)
    }
  }

  // --- noise ---
  const sigma = noiseRmsForSnr(opts.snrDb ?? Infinity, amplitude, sampleRate)
  if (sigma > 0) addNoise(out, sigma, sampleRate, rng, opts.noise, opts.noiseOffset)

  // Keep the mix inside full scale: heavy noise would otherwise clip and the
  // clipping products would swamp the tone. A receiver's AGC does the same.
  const headroom = amplitude * (1 + qrms.reduce((a, q) => a + q.level, 0)) + 4 * sigma
  if (headroom > 1) {
    const g = 1 / headroom
    for (let i = 0; i < n; i++) out[i] = out[i]! * g
  }
  for (let i = 0; i < n; i++) {
    const v = out[i]!
    if (v > 1 || v < -1) out[i] = Math.tanh(v)
  }

  return { samples: out, sampleRate, segments, duration }
}

/** 44-byte header for a 16-bit PCM mono WAV holding `numSamples` samples */
export function wavHeader16(sampleRate: number, numSamples: number): ArrayBuffer {
  const buf = new ArrayBuffer(44)
  const v = new DataView(buf)
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF')
  v.setUint32(4, 36 + numSamples * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, numSamples * 2, true)
  return buf
}

/** Float PCM → 16-bit little-endian samples */
export function toInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!))
    out[i] = Math.round(s < 0 ? s * 0x8000 : s * 0x7FFF)
  }
  return out
}

/** 16-bit PCM mono WAV container */
export function encodeWav16(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2)
  new Uint8Array(buf).set(new Uint8Array(wavHeader16(sampleRate, samples.length)), 0)
  const v = new DataView(buf)
  let o = 44
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]!))
    v.setInt16(o, Math.round(s < 0 ? s * 0x8000 : s * 0x7FFF), true)
  }
  return buf
}

/** ITA2 (Baudot) letters and figures tables, indexed by the 5-bit code */
const ITA2_LTRS = '\0E\nA SIU\rDRJNFCKTZLWHYPQOBG\0MXV\0'
const ITA2_FIGS = '\x003\n- \x0787\r$4\',!:(5")2#6019?&\0./;\0'
const ITA2_TO_FIGS = 27
const ITA2_TO_LTRS = 31

export interface RttySynthOptions {
  text: string
  sampleRate?: number
  /** mark tone (audio), Hz; space is `shiftHz` below it */
  markHz?: number
  shiftHz?: number
  baud?: number
  amplitude?: number
  snrDb?: number
  noise?: Float32Array
  leadInSec?: number
  tailSec?: number
  seed?: number
}

/**
 * Amateur RTTY: continuous-phase FSK, 45.45 baud, 170 Hz shift, 5-bit ITA2
 * with a start bit and 1.5 stop bits. Through a CW filter narrow enough to
 * pass only one of the two tones it is a carrier keyed on and off in 22 ms
 * steps — which is exactly what "insanely fast machine CW" sounds like, and
 * what a contest weekend fills the CW end of the band with. Rendered so the
 * decoder can be tested on what it must not print.
 */
export function renderRtty(opts: RttySynthOptions): { samples: Float32Array; sampleRate: number; duration: number } {
  const sampleRate = opts.sampleRate ?? 8000
  const markHz = opts.markHz ?? 880
  const spaceHz = markHz - (opts.shiftHz ?? 170)
  const baud = opts.baud ?? 45.45
  const amplitude = opts.amplitude ?? 0.5
  const rng = makeRng(opts.seed ?? 1)
  // bit stream: idle mark, then start(0) + 5 data bits LSB first + 1.5 stop(1)
  const bits: { v: 0 | 1; len: number }[] = [{ v: 1, len: 8 }]
  let figs = false
  const push = (code: number) => {
    bits.push({ v: 0, len: 1 })
    for (let b = 0; b < 5; b++) bits.push({ v: ((code >> b) & 1) as 0 | 1, len: 1 })
    bits.push({ v: 1, len: 1.5 })
  }
  for (const ch of opts.text.toUpperCase()) {
    const c = ch === '\n' ? '\n' : ch
    let code = ITA2_LTRS.indexOf(c)
    if (code > 0 && c !== ' ' && c !== '\n' && figs) { push(ITA2_TO_LTRS); figs = false }
    if (code <= 0) {
      code = ITA2_FIGS.indexOf(c)
      if (code <= 0) continue
      if (!figs && c !== ' ' && c !== '\n') { push(ITA2_TO_FIGS); figs = true }
    }
    push(code)
  }
  bits.push({ v: 1, len: 8 })
  const lead = opts.leadInSec ?? 0.5
  const tail = opts.tailSec ?? 0.5
  const bitSec = 1 / baud
  const signalSec = bits.reduce((a, b) => a + b.len, 0) * bitSec
  const duration = lead + signalSec + tail
  const n = Math.ceil(duration * sampleRate)
  const out = new Float32Array(n)
  const s0 = Math.round(lead * sampleRate)
  let phase = 0
  let t = 0
  let bi = 0
  let bitEnd = bits[0]!.len * bitSec
  const ramp = Math.round(0.005 * sampleRate)
  const s1 = s0 + Math.round(signalSec * sampleRate)
  for (let i = s0; i < s1; i++) {
    while (t >= bitEnd && bi < bits.length - 1) { bi++; bitEnd += bits[bi]!.len * bitSec }
    const f = bits[bi]!.v ? markHz : spaceHz
    phase += (2 * Math.PI * f) / sampleRate
    const g = Math.min(1, (i - s0) / ramp, (s1 - i) / ramp)
    out[i] = amplitude * g * Math.sin(phase)
    t += 1 / sampleRate
  }
  const sigma = noiseRmsForSnr(opts.snrDb ?? Infinity, amplitude, sampleRate)
  if (sigma > 0) addNoise(out, sigma, sampleRate, rng, opts.noise)
  const headroom = amplitude + 4 * sigma
  if (headroom > 1) for (let i = 0; i < n; i++) out[i] = out[i]! / headroom
  return { samples: out, sampleRate, duration }
}

/** Decode ITA2 bits back to text — the counterpart used by tests of `renderRtty`. */
export function ita2Char(code: number, figs: boolean): string {
  return (figs ? ITA2_FIGS : ITA2_LTRS)[code] ?? ''
}

export interface SamplePreset {
  id: string
  name: string
  /** what the operator will hear / what it tests */
  description: string
  /** 1 = armchair copy … 5 = barely there */
  difficulty: 1 | 2 | 3 | 4 | 5
  options: Omit<CwSynthOptions, 'sampleRate'>
}

/**
 * Sample library, in order of difficulty. The same presets back the
 * generated WAV files (`pnpm run samples`) and the in-app sample source.
 */
export const SAMPLE_PRESETS: SamplePreset[] = [
  {
    id: 'clean-20',
    name: 'Armchair copy',
    description: '20 WPM, machine timing, no noise — decoder should be perfect.',
    difficulty: 1,
    options: { text: 'CQ CQ CQ DE W1AW W1AW K', wpm: 20, snrDb: 40, seed: 11 }
  },
  {
    id: 'farnsworth-20-10',
    name: 'Farnsworth 20/10',
    description: 'Morsey-style Koch spacing: characters at 20 WPM, gaps stretched to 10 WPM.',
    difficulty: 1,
    options: { text: 'KMUR KUMR MRKU RUKM', wpm: 20, effectiveWpm: 10, snrDb: 30, seed: 12 }
  },
  {
    id: 'hand-sent-15',
    name: 'Hand-sent 15 WPM',
    description: 'Straight-key fist: heavy dahs (3.6:1), 15 % timing jitter, mild noise.',
    difficulty: 2,
    options: { text: 'UR RST 579 579 = NAME OP OP = QTH TOWN TOWN K', wpm: 15, weight: 3.6, jitter: 0.15, snrDb: 18, seed: 13 }
  },
  {
    id: 'noisy-18',
    name: 'Noisy band',
    description: '18 WPM under QRN at 8 dB SNR (2.5 kHz) — a typical evening on 40 m.',
    difficulty: 3,
    options: { text: 'TNX FER CALL = UR RST 559 559 = RIG IS QMX 5W ES ANT IS EFHW K', wpm: 18, snrDb: 8, seed: 14 }
  },
  {
    id: 'qsb-20',
    name: 'Deep QSB',
    description: '20 WPM with 80 % fading at 0.25 Hz plus noise — the threshold has to ride the fade.',
    difficulty: 3,
    options: { text: 'QSB QSB UR SIG FADING = PSE RPT UR QTH QTH K', wpm: 20, snrDb: 20, qsb: { depth: 0.8, rateHz: 0.25 }, seed: 15 }
  },
  {
    id: 'qrm-22',
    name: 'QRM 250 Hz up',
    description: '22 WPM with an equal-strength station 250 Hz above — narrow the bandwidth to separate them.',
    difficulty: 4,
    options: { text: 'CQ TEST CQ TEST DE N1XYZ N1XYZ TEST', wpm: 22, snrDb: 20, qrm: { offsetHz: 250, level: 1, text: 'VVV VVV DE QRM', wpm: 25 }, seed: 16 }
  },
  {
    id: 'fast-30',
    name: 'Fast 30 WPM',
    description: '30 WPM contest exchange with mild noise — timing resolution test.',
    difficulty: 4,
    options: { text: 'W1AW 5NN 05 TU', wpm: 30, snrDb: 15, seed: 17 }
  },
  {
    id: 'weak-16',
    name: 'Weak signal',
    description: '16 WPM at −3 dB SNR (2.5 kHz) — below the noise in the receiver. Garbles at 100 Hz bandwidth; narrow to 50 Hz and it copies clean.',
    difficulty: 5,
    options: { text: 'QRP QRP DE N0CALL N0CALL PSE K', wpm: 16, snrDb: -3, seed: 18 }
  }
]

/**
 * Read a 16-bit PCM WAV (mono, or stereo mixed to mono) into float samples.
 * Counterpart of `encodeWav16`, for replaying recorded takes (the decode
 * page's Rec button) through the decoder tests.
 */
export function decodeWav16(data: ArrayBuffer): { samples: Float32Array; sampleRate: number } {
  const v = new DataView(data)
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file')
  let sampleRate = 0
  let channels = 1
  let bits = 16
  let o = 12
  while (o + 8 <= v.byteLength) {
    const id = tag(o)
    const len = v.getUint32(o + 4, true)
    if (id === 'fmt ') {
      if (v.getUint16(o + 8, true) !== 1) throw new Error('only PCM WAV is supported')
      channels = v.getUint16(o + 10, true)
      sampleRate = v.getUint32(o + 12, true)
      bits = v.getUint16(o + 22, true)
    } else if (id === 'data') {
      if (bits !== 16) throw new Error(`only 16-bit WAV is supported (got ${bits})`)
      const frames = Math.floor(len / (2 * channels))
      const samples = new Float32Array(frames)
      let p = o + 8
      for (let i = 0; i < frames; i++) {
        let acc = 0
        for (let c = 0; c < channels; c++, p += 2) acc += v.getInt16(p, true)
        samples[i] = acc / channels / 0x8000
      }
      return { samples, sampleRate }
    }
    o += 8 + len + (len & 1)
  }
  throw new Error('WAV has no data chunk')
}
