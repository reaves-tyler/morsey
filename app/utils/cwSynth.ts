import { morseTimings, textToSchedule, type MorseTimings, type ToneSegment } from './morse.ts'

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
  /** QRM: an interfering station */
  qrm?: { offsetHz: number; level: number; text?: string; wpm?: number }
  /** dah length in dits (3 = standard; heavy fists 3.5–4) */
  weight?: number
  /** random timing jitter as a fraction of each element/gap (0.15 = sloppy hand) */
  jitter?: number
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
function humanize(text: string, t: MorseTimings, weight: number, jitter: number, rng: ReturnType<typeof makeRng>): { segments: ToneSegment[]; total: number } {
  const base = textToSchedule(text, t)
  if (weight === 3 && jitter === 0) return base

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
      cursor += Math.max(t.dit * 0.4, j(gap))
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
  const { segments: raw, total } = humanize(opts.text, t, weight, jitter, rng)
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
  for (let i = 0; i < n; i++) {
    const f = toneHz + (drift * i) / n
    phase += (2 * Math.PI * f) / sampleRate
    let g = amplitude * env[i]!
    if (opts.qsb && opts.qsb.depth > 0) {
      const fade = 1 - opts.qsb.depth * (0.5 + 0.5 * Math.sin(2 * Math.PI * opts.qsb.rateHz * (i / sampleRate) - Math.PI / 2))
      g *= fade
    }
    out[i] = g * Math.sin(phase)
  }

  // --- QRM: another station ---
  if (opts.qrm && opts.qrm.level > 0) {
    const q = opts.qrm
    const qt = morseTimings(q.wpm ?? 22, q.wpm ?? 22)
    const qText = q.text ?? 'VVV DE QRM QRM'
    let qsched = textToSchedule(qText, qt)
    // loop the interferer across the whole clip
    const qenv = new Float32Array(n)
    let offset = 0.1
    while (offset < duration) {
      for (const seg of qsched.segments) paint(qenv, offset + seg.at, seg.dur)
      offset += qsched.total + qt.wordGap * 2
      qsched = textToSchedule(qText, qt)
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
  if (sigma > 0) {
    for (let i = 0; i < n; i++) out[i] = out[i]! + sigma * rng.gauss()
  }

  // Keep the mix inside full scale: heavy noise would otherwise clip and the
  // clipping products would swamp the tone. A receiver's AGC does the same.
  const headroom = amplitude * (1 + (opts.qrm?.level ?? 0)) + 4 * sigma
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
