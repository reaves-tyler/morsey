import { MORSE, REVERSE_MORSE } from './morse.ts'

/**
 * Pure CW (on-off keyed tone) stream decoder: PCM samples in, text out.
 *
 * No Web Audio, Vue, or clock dependencies — time is counted in samples, so
 * decoding is deterministic and unit-testable (tests/cwDecoder.test.ts feeds
 * it synthesized band audio from utils/cwSynth.ts). The browser adapter
 * (composables/useCwStreamDecoder.ts) only moves PCM blocks into `process()`.
 *
 * Pipeline, and why each stage is shaped the way it is:
 *
 * 1. Tone detection — quadrature (I/Q) mixing at the centre pitch followed by
 *    two cascaded boxcar (moving-average) integrators, i.e. a triangular
 *    window whose −3 dB width is `bandwidthHz`. This is the sliding-window
 *    equivalent of the single-bin Goertzel detector used in the QRP Labs
 *    QCX/QMX firmware and OZ1JHM's Arduino decoder they derive from, but
 *    evaluated every `tickMs` instead of once per block, so element edges are
 *    timed to ~2 ms rather than to the block length, and with −26 dB
 *    sidelobes instead of a plain boxcar's −13 dB so a QRM station a few
 *    hundred Hz away is rejected rather than leaking into the envelope. The
 *    I²+Q² magnitude is phase-independent; integrating over the tone is the
 *    matched filter for a keyed carrier in white noise (PA3FWM's RSCW
 *    analysis). Magnitude is normalized so a full-scale sine reads 1.0.
 *
 * 2. Level model — one rolling log-magnitude histogram over the last
 *    `LEVEL_WINDOW_MS` of audio, and nothing else. Every threshold number is
 *    a percentile of it, so the model never depends on the gate's own state
 *    and can never be poisoned by the signal it is supposed to measure (the
 *    trap an EMA noise floor falls into: it learns the tone, the gate sticks,
 *    and it then needs a "recovery" heuristic to climb out).
 *
 *    A narrowband envelope detector's noise is Rayleigh — measurably so on
 *    real 40 m band audio — so its scale σ follows from any low percentile:
 *    P20 = 0.668 σ. Taking it from the 20th percentile means the estimate
 *    holds while a signal occupies up to 80 % of the window, which no CW
 *    transmission does. Key-down then needs the envelope above a
 *    constant-false-alarm gate of a few σ, above the `minSnrDb` squelch, and
 *    — once a signal is actually present — half way up its keying envelope,
 *    which is what stops a 35 dB-over-noise station from sharing the gate
 *    with the band hash between its words. Key-up has hysteresis below that.
 *    A manual mode exposes the raw level for operators who prefer to set it
 *    by eye.
 *
 *    The same histogram answers "is anything on this frequency at all": two
 *    modes far enough apart, with a transmission's duty cycle in the upper
 *    one. That is the squelch — it decides both how far the gate relaxes for
 *    a weak signal and whether anything is printed (stage 5).
 *
 * 3. Noise blanker — a state change must persist `noiseBlankerMs` before it
 *    is believed (QMX default 10 ms). The accepted transition keeps its
 *    original timestamp so element lengths are not shortened by the blanker.
 *    Separately, and regardless of the blanker, a mark shorter than
 *    `MIN_MARK_MS` is not an element at any speed a human or a rig can send:
 *    it is a static crash or a sideband splatter, and it is dropped without
 *    breaking the silence around it in two.
 *
 * 4. Adaptive timing — a two-cluster (dit / dah) speed tracker rather than
 *    OZ1JHM's single "high-time average" or a fixed 1.5×-dit rule: each new
 *    mark is classified against the geometric midpoint of the two clusters,
 *    the clusters are re-fitted from a short history of recent marks (so a
 *    wrong initial speed guess is corrected within a couple of characters
 *    rather than dragging every element into the wrong class), then smoothed
 *    with an exponential moving average whose weight is the "speed
 *    averaging" knob. Letter and word gaps have their own tracked clusters so
 *    Farnsworth-spaced or hand-sent code (stretched letter gaps, compressed
 *    heavy-weight elements) decodes without static 3 × / 7 × dit limits.
 *    Every estimate is held inside `MIN_WPM`..`MAX_WPM`: CW is a band of
 *    speeds, not a free parameter, and an unbounded tracker chasing noise
 *    runs away to a 2 ms "dit" from which nothing recovers.
 *
 * 5. Emission — characters are flushed as soon as the running silence exceeds
 *    the letter-gap boundary (not when the next mark starts), so the terminal
 *    updates in real time; word spaces likewise. They are held back, though,
 *    until the burst they belong to has `BURST_ELEMENTS` elements in it and
 *    the squelch of stage 2 says there is a signal on the frequency. Code
 *    arrives in runs, and it arrives from a transmitter: even a bare "K" is
 *    three elements at the end of an over, with a carrier behind it. A lone
 *    mark with seconds of silence on either side is a static crash, and
 *    printing it as `E` is how a decoder ends up spraying E and T down the
 *    page between overs. The cost is that the first character or two of a
 *    transmission appear together rather than one at a time.
 */

export interface CwDecoderConfig {
  /** PCM sample rate in Hz (audio context rate: usually 44100 or 48000) */
  sampleRate: number
  /** tone centre frequency in Hz */
  centerHz: number
  /** detector bandwidth in Hz (window = sampleRate / bandwidthHz samples) */
  bandwidthHz: number
  /** auto = adaptive floor/peak tracker; manual = fixed `manualThreshold` */
  thresholdMode: 'auto' | 'manual'
  /** manual key-down level, 0..1 (fraction of full-scale tone amplitude) */
  manualThreshold: number
  /** auto mode squelch: peak must exceed floor by this many dB to key */
  minSnrDb: number
  /** impulse noise blanker: state changes shorter than this are ignored */
  noiseBlankerMs: number
  /** EMA weight for dit/dah/gap cluster updates, 0.05 (steady) .. 1 (jumpy) */
  speedAveraging: number
  /** initial speed guess used to seed the dit estimate */
  initialWpm: number
  /** freeze timing at the current estimate (no adaptation) */
  lockSpeed: boolean
  /** envelope evaluation period in ms */
  tickMs: number
  /**
   * Operator trims on the automatic decisions (all neutral by default, which
   * is what the tests hold the decoder to). They move the automation rather
   * than replace it: the levels, speed and spacing are still measured.
   */
  /** auto threshold moved up (+) or down (−) by this many dB */
  thresholdOffsetDb: number
  /** hold output until a burst looks like a transmission (off = print whatever keys the gate) */
  squelch: boolean
  /** recognise RTTY on the pitch and print none of it */
  rejectRtty: boolean
  /** letter boundary × this: above 1 waits longer before ending a letter (a fist that leaves long gaps inside letters) */
  letterBreak: number
  /** word boundary × this: above 1 needs a longer gap before printing a space */
  wordBreak: number
  /** how fast the tracked signal level follows a fade inside a transmission, ms (time constant) */
  fadeFollowMs: number
}

export const DEFAULT_DECODER_CONFIG: Omit<CwDecoderConfig, 'sampleRate'> = {
  centerHz: 700,
  bandwidthHz: 100,
  thresholdMode: 'auto',
  manualThreshold: 0.1,
  minSnrDb: 6,
  noiseBlankerMs: 8,
  speedAveraging: 0.2,
  initialWpm: 20,
  lockSpeed: false,
  tickMs: 2,
  thresholdOffsetDb: 0,
  squelch: true,
  rejectRtty: true,
  letterBreak: 1,
  wordBreak: 1,
  fadeFollowMs: 40
}

export interface CwDecoderEvents {
  /** a complete character was decoded (`char` is `*` for an unknown pattern) */
  onCharacter?: (char: string, pattern: string) => void
  /** silence long enough to be a word break followed decoded text */
  onWordGap?: () => void
  /** the in-progress pattern changed ('' after a flush) */
  onPattern?: (pattern: string) => void
  /** a mark was classified (for element ribbons / fist analysis) */
  onElement?: (el: '.' | '-', durationMs: number) => void
  /** key state changed (debounced) */
  onKey?: (down: boolean, atMs: number) => void
}

export interface CwDecoderState {
  /** current normalized tone magnitude (0..1, full-scale sine = 1) */
  magnitude: number
  /** tracked noise floor */
  floor: number
  /** tracked signal peak */
  peak: number
  /** current key-down threshold (auto or manual) */
  threshold: number
  /** peak-over-floor in dB (auto mode meter) */
  snrDb: number
  /** debounced key state */
  keyed: boolean
  /** estimated dit length in ms */
  ditMs: number
  /** estimated dah length in ms */
  dahMs: number
  /** estimated character speed (PARIS) from the dit length */
  wpm: number
  /** tracked gap between the elements of a letter, and letter and word gaps, in ms */
  elemGapMs: number
  letterGapMs: number
  wordGapMs: number
  /** in-progress pattern */
  pattern: string
  /** ms of audio processed */
  timeMs: number
  /** whether the timing tracker has seen both element classes */
  calibrated: boolean
  /** the level histogram shows a second mode: something is on frequency */
  signalPresent: boolean
  /**
   * Decode confidence 0..1: how far recent marks and gaps sat from the
   * classification boundaries (1 = every element squarely in its cluster,
   * 0 = coin flips). Drives the readability part of the signal report.
   */
  confidence: number
  /** RTTY (170 Hz FSK) was heard on this pitch in the last few seconds — not CW, and not printed */
  fsk: boolean
  /** a burst has passed the squelch and is being printed */
  decoding: boolean
  /** why the keying in progress is being held back rather than printed ('' = it is not) */
  hold: string
}

/** Prosigns not already in the character table — shown the way the QMX prints them. */
export const PROSIGN_PATTERNS: Record<string, string> = {
  '...-.-': '<SK>',
  '-.--.': '<KN>',
  '.-...': '<AS>',
  '-...-.-': '<BK>',
  '-.-..-..': '<CL>',
  '...-.': '<SN>',
  '.-.-': '<AA>',
  '........': '<HH>'
}

/** Pattern → printable character. Characters win over prosigns (so `.-.-.` is `+`, `-...-` is `=`). */
export const PATTERN_TO_CHAR: Record<string, string> = { ...PROSIGN_PATTERNS, ...REVERSE_MORSE }

export function charForPattern(pattern: string): string {
  return PATTERN_TO_CHAR[pattern] ?? '*'
}

/** Sanity: every table entry round-trips */
for (const [ch, code] of Object.entries(MORSE)) {
  if (PATTERN_TO_CHAR[code] !== ch) throw new Error(`morse table collision on ${ch}`)
}

const TAU = Math.PI * 2
const MARK_HISTORY = 10
const GAP_HISTORY = 16
/** the level histogram fills for this long after start before keying is believed */
const WARMUP_MS = 250

/**
 * The speeds CW is actually sent at. 5 WPM is slower than any straight-key
 * novice, 60 WPM faster than any contest rig, so an estimate outside this band
 * is not a speed — it is the tracker having latched onto something that is not
 * code. Everything downstream (the element/gap boundaries, the sub-element
 * noise rejection) is derived from the dit length, so letting it run away is
 * unrecoverable: it widens its own acceptance window as it shrinks.
 */
export const MIN_WPM = 5
export const MAX_WPM = 60
const MAX_DIT_MS = 1200 / MIN_WPM
const MIN_DIT_MS = 1200 / MAX_WPM
/**
 * Absolute shortest mark that can be an element: a dit at MAX_WPM is 20 ms and
 * a 100 Hz detector cannot resolve an edge closer than ~13 ms anyway, so
 * anything under this is a static crash, a keyclick or splatter from the next
 * channel down — never code.
 */
const MIN_MARK_MS = 15

/** window the level percentiles are measured over */
const LEVEL_WINDOW_MS = 8000
/**
 * Key-down gate in units of the Rayleigh scale σ, when nothing identifiable is
 * on the frequency. P(R > 4.5 σ) = 4 × 10⁻⁵ per independent sample, and the
 * excursion must then also outlast the noise blanker, so an idle receiver
 * stays silent instead of printing a letter every few seconds.
 */
const CFAR_QUIET = 4.5
/**
 * …and the gate once the level histogram shows an actual second mode. A
 * signal weak enough to need this (10–14 dB in the detector bandwidth) sits
 * only 4–5 σ up, so the quiet gate would clip the tops off its elements; the
 * evidence that it is a signal and not an excursion is that it is *there*,
 * across seconds of history, not how far up any one sample reached.
 */
const CFAR_OPEN = 3.0
/**
 * Signal-present test on the histogram's two modes. Band noise splits too — a
 * log-Rayleigh distribution is 10 dB wide, so 2-means always cuts it in half —
 * but it splits ~9.7 dB apart with ~70 % of the samples landing in the upper
 * half, because that is one mode being halved rather than two modes being
 * separated. A keyed carrier puts a mode of its own above the noise and drags
 * the upper mass down towards the transmission's duty cycle.
 */
const SPLIT_MIN_DB = 10.5
const SPLIT_MAX_UPPER = 0.6
const SPLIT_MIN_UPPER = 0.03
/**
 * Elements a burst needs before its characters are printed. Three would pass a
 * bare K or R; four means a letter plus something, which every real over has.
 */
const BURST_ELEMENTS = 4
/** a burst whose marks sit this many noise σ up is a signal whatever the histogram says */
const STRONG_BURST_SIGMA = 8
/** amateur RTTY shift, Hz */
const FSK_SHIFT_HZ = 170
/**
 * RTTY: the partner tone during our gaps is within 6 dB of our marks — it is
 * the same transmitter, so on the band it measures within a couple of dB,
 * where a CW station 250 Hz away leaks into the side detector 10 dB down — and
 * 6 dB louder than it is during them (not more: RTTY bits are 22 ms, short
 * enough that the detector smears some of the partner into our marks). An unrelated station 170 Hz away is
 * keyed independently of ours, so it is as often on in our marks as in our gaps.
 */
const FSK_PARTNER_LEVEL = 0.5
const FSK_CONTRAST = 2
/** elements the tone / RTTY verdict is taken over */
const VERDICT_ELEMENTS = 24
/** ticks of detector output kept for reading element levels (2 s at the default 2 ms tick) */
const HIST_TICKS = 1024
/** a tone is this much (10 dB) louder on its pitch than 170 Hz away */
const TONE_CONTRAST = 3
/** a single mark less than this (6 dB) over the quieter side is broadband, not our tone */
const BROADBAND_CONTRAST = 2
/** how long the RTTY warning stays up after the last FSK burst */
const FSK_HOLD_MS = 5000
/** a burst held back longer than this is decoded from its most recent elements */
const MAX_BURST_ELEMENTS = 400
/** words of spacing evidence, and the mean length under which they are really letters */
const WORD_HISTORY = 6
const ONE_LETTER_WORDS = 1.35
/** silence that ends a burst, relative to the tracked word gap (and never less) */
const BURST_GAP_WORDS = 3
const BURST_GAP_MIN_MS = 2000
/**
 * Silence beyond this many dits is the sender pausing, not spacing, and teaches
 * the gap trackers nothing. It has to clear the widest real spacing there is:
 * ARRL Farnsworth at 20 WPM characters / 5 WPM effective puts ~62 dits between
 * words. The limit is in dits rather than in multiples of the tracked word gap
 * — which is what it replaced — because a self-referential bound lets each long
 * pause raise the bar for the next one until a whole over counts as one word.
 */
const MAX_GAP_DITS = 75
/** how often the split is re-fitted (it needs no more resolution than this) */
const SPLIT_EVERY_MS = 50
/** the upper mode is a log-domain mean over keying ramps too, so the plateau sits a little above it */
const PEAK_MODE_HEADROOM = 2
/** Rayleigh quantile the noise scale is read from: P(q) = σ·sqrt(-2 ln(1-q)) */
const SIGMA_QUANTILE = 0.2
const SIGMA_FROM_QUANTILE = Math.sqrt(-2 * Math.log(1 - SIGMA_QUANTILE))
/** Rayleigh mean, in σ — what the meter calls the noise floor */
const RAYLEIGH_MEAN = Math.sqrt(Math.PI / 2)
/**
 * Nothing this quiet is keyed. −46 dBFS is 26 dB under the level the decode
 * page asks the operator to set, which is also the detector's sidelobe
 * rejection: without it, a strong carrier outside the passband leaks enough
 * to key the gate on a stream that is otherwise digital silence, where there
 * is no noise for the CFAR term to measure itself against.
 */
const ABSOLUTE_FLOOR = 0.005

/** EMA coefficient for a time constant `tauMs` sampled every `dtMs` */
function emaCoeff(tauMs: number, dtMs: number): number {
  return 1 - Math.exp(-dtMs / tauMs)
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Rolling distribution of the tone magnitude over the last `capacity` ticks,
 * as a 0.5 dB-binned log histogram plus a ring of bin indices so evictions are
 * O(1). Percentiles are read by scanning the bins, which is a fixed ~300 adds
 * however long the window is — cheap enough to do on every tick, and immune to
 * the feedback that makes a gate-conditioned EMA floor stick.
 */
const BIN_DB = 0.5
const HIST_MIN_DB = -140
const HIST_BINS = Math.ceil(-HIST_MIN_DB / BIN_DB) + 2

class LevelHistogram {
  private bins = new Int32Array(HIST_BINS)
  private ring: Int16Array
  private pos = 0
  private n = 0

  readonly capacity: number

  constructor(capacity: number) {
    this.capacity = capacity
    this.ring = new Int16Array(Math.max(16, capacity))
  }

  reset() {
    this.bins.fill(0)
    this.pos = 0
    this.n = 0
  }

  push(mag: number) {
    const db = 20 * Math.log10(Math.max(mag, 1e-9))
    const bin = clamp(Math.round((db - HIST_MIN_DB) / BIN_DB), 0, HIST_BINS - 1)
    if (this.n === this.ring.length) this.bins[this.ring[this.pos]!]!--
    else this.n++
    this.ring[this.pos] = bin
    this.bins[bin]!++
    if (++this.pos === this.ring.length) this.pos = 0
  }

  /**
   * 2-means over the occupied bins, weighted by count, in dB. Returns the two
   * mode centres and the share of samples in the upper one, or null when the
   * window holds too little to say anything.
   */
  split(): { lowDb: number; highDb: number; upperFrac: number } | null {
    if (this.n < 32) return null
    let first = -1
    let last = -1
    for (let i = 0; i < HIST_BINS; i++) {
      if (this.bins[i]!) { if (first < 0) first = i; last = i }
    }
    if (first < 0 || first === last) return null
    let lo = HIST_MIN_DB + first * BIN_DB
    let hi = HIST_MIN_DB + last * BIN_DB
    let upper = 0
    for (let iter = 0; iter < 12; iter++) {
      const mid = (lo + hi) / 2
      let sumLo = 0
      let nLo = 0
      let sumHi = 0
      let nHi = 0
      for (let i = first; i <= last; i++) {
        const c = this.bins[i]!
        if (!c) continue
        const db = HIST_MIN_DB + i * BIN_DB
        if (db <= mid) { sumLo += db * c; nLo += c } else { sumHi += db * c; nHi += c }
      }
      if (!nLo || !nHi) return null
      lo = sumLo / nLo
      hi = sumHi / nHi
      upper = nHi / this.n
    }
    return { lowDb: lo, highDb: hi, upperFrac: upper }
  }

  /** magnitude at quantile `q` of the window (0 when empty) */
  quantile(q: number): number {
    if (!this.n) return 0
    let target = Math.min(this.n - 1, Math.floor(q * this.n))
    for (let i = 0; i < HIST_BINS; i++) {
      target -= this.bins[i]!
      if (target < 0) return Math.pow(10, (HIST_MIN_DB + i * BIN_DB) / 20)
    }
    return Math.pow(10, (HIST_MIN_DB + (HIST_BINS - 1) * BIN_DB) / 20)
  }
}

/**
 * Split durations into two clusters by iterating 2-means in the log domain,
 * seeded from the min and max. Returns null when the values are too alike to
 * be two classes (ratio < `minRatio`), i.e. we saw only dits or only dahs.
 */
function splitClusters(values: number[], minRatio: number): { low: number; high: number } | null {
  if (values.length < 2) return null
  const logs = values.map(Math.log)
  let lo = Math.min(...logs)
  let hi = Math.max(...logs)
  if (Math.exp(hi - lo) < minRatio) return null
  for (let iter = 0; iter < 4; iter++) {
    const mid = (lo + hi) / 2
    const a = logs.filter(v => v <= mid)
    const b = logs.filter(v => v > mid)
    if (!a.length || !b.length) return null
    lo = mean(a)
    hi = mean(b)
  }
  if (Math.exp(hi - lo) < minRatio) return null
  return { low: Math.exp(lo), high: Math.exp(hi) }
}

/**
 * Sliding quadrature tone detector: I/Q mix at `freqHz`, then two cascaded
 * boxcars of `win` samples (a triangular window). Magnitude is normalized so
 * a full-scale sine at the centre reads 1.0.
 */
class ToneDetector {
  private phase = 0
  private readonly phaseInc: number
  readonly win: number
  private bufI!: Float32Array
  private bufQ!: Float32Array
  private bufPos = 0
  private sumI = 0
  private sumQ = 0
  private s2I!: Float64Array
  private s2Q!: Float64Array
  private s2Pos = 0
  private s2SumI = 0
  private s2SumQ = 0
  private filled = 0

  constructor(sampleRate: number, freqHz: number, win: number) {
    this.phaseInc = (TAU * freqHz) / sampleRate
    this.win = win
    this.bufI = new Float32Array(win)
    this.bufQ = new Float32Array(win)
    this.s2I = new Float64Array(win)
    this.s2Q = new Float64Array(win)
  }

  push(x: number) {
    const c = Math.cos(this.phase)
    const sn = Math.sin(this.phase)
    this.phase += this.phaseInc
    if (this.phase >= TAU) this.phase -= TAU
    this.pushIQ(x * c, x * sn)
  }

  private pushIQ(vi: number, vq: number) {
    const win = this.win
    // stage 1: sliding boxcar over the last `win` mixed samples
    this.sumI += vi - this.bufI[this.bufPos]!
    this.sumQ += vq - this.bufQ[this.bufPos]!
    this.bufI[this.bufPos] = vi
    this.bufQ[this.bufPos] = vq
    if (++this.bufPos === win) {
      this.bufPos = 0
      // re-sum once per lap so float drift can't accumulate
      let si = 0
      let sq = 0
      for (let k = 0; k < win; k++) {
        si += this.bufI[k]!
        sq += this.bufQ[k]!
      }
      this.sumI = si
      this.sumQ = sq
    }
    // stage 2: boxcar over the stage-1 sums (cascade = triangular window)
    this.s2SumI += this.sumI - this.s2I[this.s2Pos]!
    this.s2SumQ += this.sumQ - this.s2Q[this.s2Pos]!
    this.s2I[this.s2Pos] = this.sumI
    this.s2Q[this.s2Pos] = this.sumQ
    if (++this.s2Pos === win) {
      this.s2Pos = 0
      let si = 0
      let sq = 0
      for (let k = 0; k < win; k++) {
        si += this.s2I[k]!
        sq += this.s2Q[k]!
      }
      this.s2SumI = si
      this.s2SumQ = sq
    }
    if (this.filled < 2 * win) this.filled++
  }

  /** both stages have seen a full window */
  get ready(): boolean {
    return this.filled >= 2 * this.win
  }

  /** amplitude of a sine at the tuned frequency (I,Q sums each reach A·win/2 in quadrature) */
  magnitude(): number {
    return (2 / (this.win * this.win)) * Math.hypot(this.s2SumI, this.s2SumQ)
  }
}

export class CwDecoder {
  private cfg: CwDecoderConfig
  private ev: CwDecoderEvents

  // --- tone detector -----------------------------------------------------------
  private det!: ToneDetector
  /**
   * The same detector 170 Hz either side of the pitch. A keyed tone is far
   * stronger at its own pitch than beside it; band noise coming back as a
   * receiver unmutes, or a static crash, is as loud beside it as on it; and
   * RTTY — which through a narrow filter sounds like very fast machine code —
   * puts its other tone exactly in our gaps. See `burstVerdict`.
   */
  private sideLo: ToneDetector | null = null
  private sideHi!: ToneDetector
  private sideMag = 0
  /** the quieter of the two sides: only something broadband lifts both */
  private sideMinMag = 0
  private hop = 0
  private hopPos = 0
  private sampleCount = 0

  // --- envelope / threshold -------------------------------------------------------
  private magnitude = 0
  private levels!: LevelHistogram
  /** bandwidth the levels in the histogram were measured at */
  private detectorBandwidthHz = 0
  private floor = 0
  private sigma = 0
  private peak = 0
  private threshold = 0
  private startedAtMs = -1
  /** the histogram shows a second mode: something is being transmitted here */
  private signalPresent = false
  /** magnitude of that second mode (0 when there is none) */
  private signalMode = 0
  private nextSplitMs = 0
  private aPeakUp = 0
  private aPeakDown = 0
  private aPeakDownLive = 0
  private aPeakRelease = 0
  private rawState = false
  /** time the envelope first fell below the on-level during a mark (symmetric edge timing) */
  private fallSinceMs = -1
  /** when the raw (un-debounced) gate last opened, for the peak tracker */
  private rawSinceMs = 0
  private candidateState = false
  private candidateSinceMs = 0
  private keyed = false
  /** start of the mark in progress */
  private markStartMs = 0
  /** magnitude summed over the mark in progress, for its level */
  /**
   * The last couple of seconds of detector output, tick by tick — so a mark's
   * or a gap's level is read over its settled middle, between the edges the
   * gate reported, rather than over whatever the blanker's confirmation delay
   * and the detector's own rise time let in from the neighbouring element.
   * (A 22 ms RTTY bit is barely longer than the detector's settling, so an
   * average that runs on to the confirmation smears the other tone into it.)
   */
  private hist = {
    t: new Float64Array(HIST_TICKS),
    mag: new Float32Array(HIST_TICKS),
    side: new Float32Array(HIST_TICKS),
    sideMin: new Float32Array(HIST_TICKS),
    pos: 0,
    n: 0
  }
  /** start of the current silence — survives marks rejected as impulse noise */
  private gapStartMs = 0
  /** at least one real element has been seen, so gaps mean something */
  private hasEdge = false
  /** consecutive marks that fit neither cluster (speed jump detector) */
  private outliers = 0
  /** spacing clusters have been measured (not just scaled from the dit) */
  private spacingCalibrated = false

  // --- timing --------------------------------------------------------------------
  private ditMs = 60
  private dahMs = 180
  /** silence between the elements of one character — 1 dit from a keyer, 1.2–1.8 from a straight key */
  private elemGapMs = 60
  private letterGapMs = 180
  private wordGapMs = 420
  private marks: number[] = []
  private gaps: number[] = []
  private calibrated = false
  /** mark durations of the character in progress (re-classified when speed re-fits) */
  private currentMarks: number[] = []
  /** EMA of per-element classification margin (see CwDecoderState.confidence) */
  private confidence = 1

  // --- symbol assembly -------------------------------------------------------------
  private pattern = ''
  private charFlushed = true
  private wordFlushed = true
  private hasOutput = false
  /**
   * The burst in progress, as raw durations, until it passes the squelch: each
   * mark and the silence before it (the first one's is the gap since the last
   * burst). Nothing is decoded from it or learned from it before then — a
   * burst that turns out to be band hash or RTTY must not drag the speed
   * estimate onto itself, and one that turns out to be code is decoded as a
   * whole with the timing fitted to it, so its first letters are read at the
   * sender's speed rather than whatever the last station ran.
   */
  private burstMarks: number[] = []
  private burstGaps: number[] = []
  /**
   * Mean magnitude of the burst's recent marks on the pitch and 170 Hz beside
   * it, and beside it in the gap before each — kept through the live phase too,
   * so RTTY that slipped through is caught within a few elements.
   */
  private burstLevels: number[] = []
  private burstSides: number[] = []
  private burstGapSides: number[] = []
  /** when RTTY (two-tone FSK) was last recognised on the frequency */
  private fskSeenMs = -Infinity
  /** why the burst in progress is not being printed ('' when it is, or there is none) */
  private holdReason = ''
  /** the burst passed the squelch: its elements are decoded as they arrive */
  private live = false
  /** where the burst in progress began, and where the last printed one ended */
  private burstStartMs = 0
  private lastLiveEdgeMs = -Infinity
  /** characters in each of the last few printed words (letter/word spacing evidence) */
  private wordLens: number[] = []
  private charsInWord = 0

  constructor(config: Partial<CwDecoderConfig> & { sampleRate: number }, events: CwDecoderEvents = {}) {
    this.cfg = { ...DEFAULT_DECODER_CONFIG, ...config }
    this.ev = events
    this.configureDetector()
    this.resetTiming()
  }

  /** Update settings on the fly. Detector-related changes rebuild the window; speed changes re-seed timing. */
  configure(patch: Partial<CwDecoderConfig>) {
    const prev = this.cfg
    this.cfg = { ...prev, ...patch }
    if (
      patch.centerHz !== undefined && patch.centerHz !== prev.centerHz ||
      patch.bandwidthHz !== undefined && patch.bandwidthHz !== prev.bandwidthHz ||
      patch.sampleRate !== undefined && patch.sampleRate !== prev.sampleRate ||
      patch.tickMs !== undefined && patch.tickMs !== prev.tickMs ||
      patch.fadeFollowMs !== undefined && patch.fadeFollowMs !== prev.fadeFollowMs
    ) {
      this.configureDetector()
    }
    if (patch.initialWpm !== undefined && patch.initialWpm !== prev.initialWpm) this.resetTiming()
  }

  get config(): Readonly<CwDecoderConfig> {
    return this.cfg
  }

  private configureDetector() {
    const { sampleRate, centerHz, bandwidthHz, tickMs } = this.cfg
    // two cascaded boxcars of length T each have a −3 dB width of ≈ 0.64 / T
    const win = Math.max(8, Math.round((0.64 * sampleRate) / Math.max(10, bandwidthHz)))
    this.det = new ToneDetector(sampleRate, centerHz, win)
    this.sideHi = new ToneDetector(sampleRate, centerHz + FSK_SHIFT_HZ, win)
    this.sideLo = centerHz - FSK_SHIFT_HZ >= 150 ? new ToneDetector(sampleRate, centerHz - FSK_SHIFT_HZ, win) : null
    this.hop = Math.max(1, Math.round((sampleRate * tickMs) / 1000))
    this.hopPos = 0
    const dt = (this.hop / sampleRate) * 1000
    const capacity = Math.round(LEVEL_WINDOW_MS / dt)
    // A pitch change keeps the measured distribution — it refills within
    // `LEVEL_WINDOW_MS` anyway, and blanking it would put the decoder back into
    // warm-up, deaf, in the middle of the signal the operator was tuning onto.
    // A *bandwidth* change cannot be kept: noise power through the detector
    // scales with its bandwidth, so every level already in the window was
    // measured on a different scale, and σ would read low (gate down in the
    // noise) after widening, or high (deaf) after narrowing, until the window
    // turned over.
    const rescaled = !!this.levels && bandwidthHz !== this.detectorBandwidthHz
    if (!this.levels || rescaled || this.levels.capacity !== capacity) {
      this.levels = new LevelHistogram(capacity)
      this.startedAtMs = -1
    }
    this.detectorBandwidthHz = bandwidthHz
    this.aPeakUp = emaCoeff(40, dt)
    this.aPeakDown = emaCoeff(120, dt)
    this.aPeakDownLive = emaCoeff(clamp(this.cfg.fadeFollowMs, 5, 2000), dt)
    // Between two transmissions the band is quiet for tens of seconds. A peak
    // that decayed in a second or two would drop the threshold into the hash
    // every time the other station stopped talking, and the decoder would
    // spend the gaps printing E and T; holding it is what an operator does with
    // a squelch knob. `signalMode` above is what brings it back down.
    this.aPeakRelease = emaCoeff(60000, dt)
  }

  /** Re-seed timing from `initialWpm` (called on speed-prior changes and by `reset`). */
  resetTiming() {
    this.ditMs = clamp(1200 / this.cfg.initialWpm, MIN_DIT_MS, MAX_DIT_MS)
    this.dahMs = this.ditMs * 3
    this.elemGapMs = this.ditMs
    this.letterGapMs = this.ditMs * 3
    this.wordGapMs = this.ditMs * 7
    this.marks = []
    this.gaps = []
    this.wordLens = []
    this.calibrated = false
    this.spacingCalibrated = false
    this.outliers = 0
    this.confidence = 1
  }

  /**
   * Classification margin of a duration between two cluster centres: 1 at a
   * centre, 0 at the geometric-midpoint boundary (log domain, so dits and
   * dahs are judged on the same footing).
   */
  private margin(dur: number, low: number, high: number): number {
    const b = Math.log(Math.sqrt(low * high))
    const d = Math.log(dur)
    const c = d < b ? Math.log(low) : Math.log(high)
    const half = Math.abs(c - b)
    if (half === 0) return 1
    return Math.min(1, Math.abs(d - b) / half)
  }

  private noteMargin(m: number) {
    this.confidence += (m - this.confidence) * 0.15
  }

  /** Full reset: detector, levels, timing, and the pending pattern. */
  reset() {
    this.configureDetector()
    this.resetTiming()
    this.resetLevels()
    this.magnitude = 0
    this.sampleCount = 0
    this.pattern = ''
    this.hasOutput = false
  }

  /**
   * Throw away the measured level distribution and learn it again from the
   * next `LEVEL_WINDOW_MS` of audio (with a fresh warm-up), e.g. after the
   * operator changed the rig's volume or the interface gain. Timing clusters
   * and decoded output are untouched; a character in progress is flushed
   * rather than mixed with the new levels.
   */
  resetLevels() {
    if (this.live && this.pattern) this.flushChar()
    this.levels.reset()
    this.floor = 0
    this.sigma = 0
    this.peak = 0
    this.threshold = 0
    this.startedAtMs = -1
    this.signalPresent = false
    this.signalMode = 0
    this.nextSplitMs = 0
    this.outliers = 0
    this.rawState = false
    this.fallSinceMs = -1
    this.candidateState = false
    this.keyed = false
    this.hasEdge = false
    this.currentMarks = []
    this.charFlushed = true
    this.wordFlushed = true
    // A burst that never qualified belongs to the session that was interrupted:
    // holding it would print last session's squelched characters in front of
    // this one's first word, and its element count would let the next burst
    // through the squelch without earning it.
    this.dropBurst()
  }

  /**
   * Feed PCM (mono, -1..1). Any block length is fine. `side`, when given, is
   * the same audio before any band-pass the host put in front of `samples`:
   * the 170 Hz side detectors must hear the band beside the pitch, which a
   * pre-filter narrow enough to help the main detector takes 8–10 dB off —
   * enough to hide the other tone of an RTTY pair.
   */
  process(samples: Float32Array | number[], side?: Float32Array | number[]) {
    const n = samples.length
    const aside = side && side.length === n ? side : samples
    for (let i = 0; i < n; i++) {
      const x = samples[i]!
      const y = aside[i]!
      this.det.push(x)
      this.sideHi.push(y)
      this.sideLo?.push(y)
      this.sampleCount++
      if (++this.hopPos >= this.hop) {
        this.hopPos = 0
        this.tick()
      }
    }
  }

  /** ms of audio consumed */
  get timeMs(): number {
    return (this.sampleCount / this.cfg.sampleRate) * 1000
  }

  private tick() {
    const nowMs = this.timeMs
    const mag = this.det.magnitude()
    this.magnitude = mag
    const hi = this.sideHi.magnitude()
    const lo = this.sideLo ? this.sideLo.magnitude() : hi
    this.sideMag = Math.max(hi, lo)
    this.sideMinMag = Math.min(hi, lo)
    if (!this.det.ready) return

    // --- level model: percentiles of the last LEVEL_WINDOW_MS, nothing else ---
    if (this.startedAtMs < 0) this.startedAtMs = nowMs
    this.levels.push(mag)
    const warmingUp = nowMs - this.startedAtMs < WARMUP_MS
    // σ of the Rayleigh-distributed noise envelope, read from a low quantile so
    // the signal cannot lift it: it would take a transmission keyed down 80 %
    // of the whole window to reach this far into the distribution.
    this.sigma = this.levels.quantile(SIGMA_QUANTILE) / SIGMA_FROM_QUANTILE
    this.floor = this.sigma * RAYLEIGH_MEAN
    if (nowMs >= this.nextSplitMs) {
      this.nextSplitMs = nowMs + SPLIT_EVERY_MS
      const sp = this.levels.split()
      this.signalPresent = !!sp &&
        sp.highDb - sp.lowDb >= SPLIT_MIN_DB &&
        sp.upperFrac <= SPLIT_MAX_UPPER &&
        sp.upperFrac >= SPLIT_MIN_UPPER
      this.signalMode = this.signalPresent ? Math.pow(10, sp!.highDb / 20) : 0
    }

    // Signal peak: fast attack, moderate decay so a QSB fade is followed, and
    // released towards the noise over a minute of silence so a band that has
    // gone quiet eventually hands the gate back. Unlike the noise statistics
    // this may be conditioned on the gate — a peak learned from the signal is
    // the point — and when it does fall all the way to the floor the CFAR term
    // below, not the noise itself, is what the threshold rests on.
    if (mag > this.peak) {
      // attack on anything: a threshold that has drifted low is corrected by
      // the first real element that comes through it
      if (this.rawState) this.peak += (mag - this.peak) * this.aPeakUp
    } else if (this.rawState && nowMs - this.rawSinceMs >= MIN_MARK_MS) {
      // Decay only inside a key-down long enough to be an element. Impulse
      // noise and splatter cross the gate in 2–12 ms bursts; letting those
      // pull the peak down is the decoder's death spiral — the threshold
      // follows the peak onto the hash, the hash then keys it, and the dit
      // estimate collapses behind it. A fading signal's marks are tens of ms
      // and still bring the peak down inside a character.
      //
      // Inside a burst that has passed the squelch the peak follows three times
      // faster: that is a station, not the hash, and HF fading takes 10 dB off
      // it in a few hundred ms. At the slower rate the gate — halfway up the old
      // peak — ends up above the faded marks, which then break up or vanish,
      // and a peak that only moves while the gate is open never learns they
      // faded. (Measured on ITU-R F.1487 moderate/poor channels: 86 → 93 % and
      // 83 → 96 % copy at 15 dB, with the real takes unchanged.)
      this.peak += (mag - this.peak) * (this.live ? this.aPeakDownLive : this.aPeakDown)
    } else if (!this.rawState) {
      this.peak += (this.floor - this.peak) * this.aPeakRelease
    }
    // A remembered peak that only decays would go deaf on the next, weaker
    // station — the gate would sit above it and so never learn it. The upper
    // mode of the histogram is measured without the gate's help, so when it
    // says the thing on frequency is quieter than what we remember, believe it.
    if (this.signalMode && this.peak > this.signalMode * PEAK_MODE_HEADROOM) {
      this.peak = this.signalMode * PEAK_MODE_HEADROOM
    }
    if (this.peak < this.floor) this.peak = this.floor

    // --- decision with hysteresis ---
    let onLevel: number
    let offLevel: number
    if (this.cfg.thresholdMode === 'manual') {
      onLevel = this.cfg.manualThreshold
      offLevel = onLevel * 0.7
    } else {
      const span = this.peak - this.floor
      onLevel = Math.max(
        this.floor + span * 0.5, // halfway up a signal we are already tracking
        // CFAR gate against band noise — relaxed once something on frequency
        // is known to be a signal: the histogram says so, or a burst of it
        // passed the squelch and is being decoded
        this.sigma * (this.signalPresent || this.live ? CFAR_OPEN : CFAR_QUIET),
        this.floor * Math.pow(10, this.cfg.minSnrDb / 20), // operator squelch
        ABSOLUTE_FLOOR // digital silence (or a far-off tone's sidelobe) must never key
      )
      offLevel = this.floor + span * 0.4
      if (offLevel > onLevel * 0.9) offLevel = onLevel * 0.9
      if (this.cfg.thresholdOffsetDb) {
        const g = Math.pow(10, this.cfg.thresholdOffsetDb / 20)
        onLevel = Math.max(ABSOLUTE_FLOOR, onLevel * g)
        offLevel = Math.min(onLevel * 0.9, Math.max(ABSOLUTE_FLOOR * 0.7, offLevel * g))
      }
    }
    this.threshold = onLevel
    let raw = this.rawState
    let edgeAt = nowMs
    if (warmingUp) {
      raw = false // learn the noise statistics before believing anything
    } else if (!raw) {
      if (mag > onLevel) { raw = true; this.rawSinceMs = nowMs }
    } else {
      // Hysteresis would shorten every mark (on at 50 %, off at 40 %), so the
      // key-up edge is timed at the *on*-level crossing, confirmed only once
      // the envelope also drops through the off-level.
      if (mag < onLevel) {
        if (this.fallSinceMs < 0) this.fallSinceMs = nowMs
      } else {
        this.fallSinceMs = -1
      }
      if (mag < offLevel) {
        raw = false
        edgeAt = this.fallSinceMs >= 0 ? this.fallSinceMs : nowMs
        this.fallSinceMs = -1
      }
    }
    this.rawState = raw

    // --- noise blanker (debounce keeping the original edge time) ---
    if (raw !== this.candidateState) {
      this.candidateState = raw
      this.candidateSinceMs = edgeAt
    }
    if (this.candidateState !== this.keyed && nowMs - this.candidateSinceMs >= this.cfg.noiseBlankerMs) {
      this.setKeyed(this.candidateState, this.candidateSinceMs)
    }
    const h = this.hist
    h.t[h.pos] = nowMs
    h.mag[h.pos] = mag
    h.side[h.pos] = this.sideMag
    h.sideMin[h.pos] = this.sideMinMag
    h.pos = (h.pos + 1) % HIST_TICKS
    if (h.n < HIST_TICKS) h.n++

    // --- real-time flushing during silence ---
    if (!this.keyed && this.hasEdge) {
      // A key-down the blanker has not confirmed yet ended this silence where it
      // began. Measuring on to `nowMs` instead lets the letter boundary pass
      // during the blanker's hold, and every element gap that falls within a
      // blanker length of the boundary splits its letter in two.
      const until = this.candidateState ? this.candidateSinceMs : nowMs
      const silence = until - this.gapStartMs
      if (!this.live && this.printable) this.goLive()
      if (this.live) {
        if (!this.charFlushed && silence >= this.letterBoundary()) this.flushChar()
        if (!this.wordFlushed && this.hasOutput && silence >= this.wordBoundary()) {
          this.wordFlushed = true
          this.emitWordGap()
        }
      }
      if (silence >= this.burstGapMs() && (this.live || this.burstMarks.length)) {
        // the over ended; one that never looked like code is dropped unprinted
        if (this.live && !this.charFlushed) this.flushChar()
        this.dropBurst()
      }
    }
  }

  /**
   * Shortest mark that can be an element. Relative to the tracked dit so a
   * clipped element at 12 WPM is still rejected, but never below the absolute
   * limit, which is what keeps a static crash from ever becoming an `E`.
   */
  private minMarkMs(): number {
    // Until a burst passes the squelch the dit estimate is somebody else's —
    // the last station's, or the prior — and scaling the rejection from it
    // deadlocks on a faster sender: at a 10 WPM prior a 40 WPM dit (30 ms) is
    // "noise", so the dit estimate never sees one and never shrinks.
    // Before then the rejection assumes no slower than 20 WPM (21 ms at most).
    return Math.max(MIN_MARK_MS, 0.35 * (this.live ? this.ditMs : Math.min(this.ditMs, 60)))
  }

  private setKeyed(down: boolean, atMs: number) {
    this.keyed = down
    this.ev.onKey?.(down, atMs)
    if (down) {
      this.markStartMs = atMs
      return
    }
    const dur = atMs - this.markStartMs
    const { mag: level, side, sideMin } = this.settledMeans(this.markStartMs, atMs)
    if (dur < this.minMarkMs() || (this.sideLo && level < sideMin * BROADBAND_CONTRAST)) {
      // Impulse noise — too short to be an element, or as loud on both sides
      // of the pitch as on it (a static crash is broadband; a station beside
      // us lifts only one side). Drop it *without* moving `gapStartMs`: a
      // crash in the middle of a letter gap must not split that gap into two
      // short ones and glue the letters on either side of it together.
      return
    }
    const gap = this.hasEdge ? this.markStartMs - this.gapStartMs : Infinity
    const gapSide = this.hasEdge ? this.settledMeans(this.gapStartMs, this.markStartMs).side : 0
    if (gap >= this.burstGapMs()) {
      // a new over (the silence check in `tick` normally got here first)
      if (this.live && !this.charFlushed) this.flushChar()
      this.dropBurst()
    }
    this.hasEdge = true
    this.gapStartMs = atMs
    this.burstLevels.push(level)
    this.burstSides.push(side)
    this.burstGapSides.push(gapSide)
    if (this.burstLevels.length > VERDICT_ELEMENTS) {
      this.burstLevels.shift()
      this.burstSides.shift()
      this.burstGapSides.shift()
    }
    if (this.live) {
      if (this.cfg.rejectRtty && this.burstLevels.length >= BURST_ELEMENTS && this.burstVerdict() === 'fsk') {
        // it was RTTY after all: stop printing it
        this.fskSeenMs = this.timeMs
        this.flushChar()
        this.dropBurst()
        return
      }
      this.onGapEnded(gap)
      this.onMarkEnded(dur)
      this.lastLiveEdgeMs = atMs
      return
    }
    if (!this.burstMarks.length) this.burstStartMs = this.markStartMs
    this.burstMarks.push(dur)
    this.burstGaps.push(gap)
    if (this.burstMarks.length > MAX_BURST_ELEMENTS) {
      this.burstMarks.shift()
      this.burstGaps.shift()
    }
    // show it on the element ribbon at the timing we have; it is decoded for
    // real (and learned from) only once the burst passes the squelch — and not
    // shown at all while the frequency is known to carry RTTY, whose bits
    // would otherwise scroll past as an endless "character in progress"
    if (this.cfg.rejectRtty && this.timeMs - this.fskSeenMs < FSK_HOLD_MS) {
      if (this.pattern) {
        this.pattern = ''
        this.ev.onPattern?.('')
      }
    } else {
      const el: '.' | '-' = dur < this.markBoundary() ? '.' : '-'
      this.ev.onElement?.(el, dur)
      this.pattern = gap >= this.letterBoundary() ? el : this.pattern + el
      this.ev.onPattern?.(this.pattern)
    }
    if (this.printable) this.goLive()
  }

  /**
   * Mean detector output over the settled middle of [fromMs, toMs]: a
   * detector window in from each edge, where the step response has finished
   * rising. A segment too short to have one is read at its centre.
   */
  private settledMeans(fromMs: number, toMs: number): { mag: number; side: number; sideMin: number } {
    const h = this.hist
    const settle = (this.det.win / this.cfg.sampleRate) * 1000
    let a = fromMs + settle
    let b = toMs - settle
    if (b < a) a = b = (fromMs + toMs) / 2
    let mag = 0
    let side = 0
    let sideMin = 0
    let n = 0
    let nearest = -1
    let nearestD = Infinity
    for (let k = 1; k <= h.n; k++) {
      const i = (h.pos - k + HIST_TICKS) % HIST_TICKS
      const t = h.t[i]!
      if (t < a - 4) break
      const d = Math.abs(t - (a + b) / 2)
      if (d < nearestD) { nearestD = d; nearest = i }
      if (t >= a && t <= b) {
        mag += h.mag[i]!
        side += h.side[i]!
        sideMin += h.sideMin[i]!
        n++
      }
    }
    if (n) return { mag: mag / n, side: side / n, sideMin: sideMin / n }
    if (nearest >= 0) return { mag: h.mag[nearest]!, side: h.side[nearest]!, sideMin: h.sideMin[nearest]! }
    return { mag: 0, side: 0, sideMin: 0 }
  }

  /** forget the burst in progress: it ended, or it never passed the squelch */
  private dropBurst() {
    this.live = false
    this.burstMarks = []
    this.burstGaps = []
    this.burstLevels = []
    this.burstSides = []
    this.burstGapSides = []
    if (this.pattern && this.charFlushed) {
      this.pattern = ''
      this.ev.onPattern?.('')
    }
    this.currentMarks = []
  }

  /**
   * The burst passed the squelch. Fit the timing to everything it holds —
   * element speed from its marks, spacing from its gaps — then decode it
   * from the start with that timing, and go on decoding it element by
   * element from here.
   */
  private goLive() {
    const marks = this.burstMarks
    const gaps = this.burstGaps
    this.live = true
    this.burstMarks = []
    this.burstGaps = []
    // The silence since the last printed burst is spacing evidence too, when it
    // is short enough to be spacing rather than a pause: the stretched word gap
    // of a Farnsworth sender outlasts the burst timeout, and it is the only
    // thing that shows the gaps inside the burst to be letter gaps.
    const since = this.burstStartMs - this.lastLiveEdgeMs
    this.fitBurst(marks, gaps, Number.isFinite(since) ? since : undefined)
    this.lastLiveEdgeMs = this.gapStartMs
    this.pattern = ''
    this.currentMarks = []
    this.charFlushed = true
    const boundary = this.markBoundary()
    for (let i = 0; i < marks.length; i++) {
      const g = gaps[i]!
      if (i > 0 && this.pattern && g >= this.letterBoundary()) {
        this.flushChar()
        if (g >= this.wordBoundary() && this.hasOutput) {
          this.wordFlushed = true
          this.emitWordGap()
        }
      }
      this.currentMarks.push(marks[i]!)
      this.pattern += marks[i]! < boundary ? '.' : '-'
      this.charFlushed = false
      this.wordFlushed = false
    }
    this.ev.onPattern?.(this.pattern)
  }

  /**
   * Timing from one burst's own durations, snapped rather than smoothed: the
   * trackers' history belongs to whoever was on before, and the point of
   * holding the burst back was to read it at its own speed.
   */
  private fitBurst(marks: number[], gaps: number[], sinceLastMs?: number) {
    if (this.cfg.lockSpeed || !marks.length) return
    const prevDit = this.ditMs
    const split = splitClusters(marks, 1.8)
    if (split) {
      this.ditMs = split.low
      this.dahMs = split.high
      this.calibrated = true
    } else {
      // one class only (a run of Es or Ts): which one it is follows from the
      // speed we had; the other cluster rides along at 3:1
      const m = median(marks)
      if (m < this.markBoundary()) { this.ditMs = m; this.dahMs = m * 3 } else { this.dahMs = m; this.ditMs = m / 3 }
    }
    this.boundElementSpeed()
    this.marks = marks.slice(-MARK_HISTORY)
    this.outliers = 0
    const ratio = this.ditMs / prevDit
    this.elemGapMs *= ratio
    this.letterGapMs *= ratio
    this.wordGapMs *= ratio

    // spacing: the burst's gaps below the pause limit, first one excluded
    const inner = gaps.slice(1).filter(g => g < this.ditMs * MAX_GAP_DITS)
    const pause = this.ditMs * MAX_GAP_DITS
    const lead = sinceLastMs !== undefined && sinceLastMs < pause ? [sinceLastMs] : []
    if (!inner.length && !lead.length) { this.clampSpacing(); return }
    const s = splitClusters(inner, 1.6)
    let intra: number[]
    let rest: number[]
    if (s) {
      const b = Math.sqrt(s.low * s.high)
      intra = inner.filter(g => g < b)
      rest = inner.filter(g => g >= b)
    } else if (inner.length && median(inner) < this.ditMs * 2.2) {
      intra = inner
      rest = []
    } else {
      intra = []
      rest = inner
    }
    if (intra.length) this.elemGapMs = median(intra)
    if (rest.length) {
      const s2 = splitClusters(rest, 1.5)
      if (s2) {
        this.letterGapMs = s2.low
        this.wordGapMs = s2.high
        this.spacingCalibrated = true
      } else {
        const m = median(rest)
        // One class of long gaps: letter gaps or word gaps? Nearer 3 dits than
        // 7 (in ratio) they are letter gaps. Nearer 7, a keyer's are word gaps —
        // unless the silence before this burst was far longer still (the word
        // gap of a Farnsworth sender, which outlasts the burst timeout), or the
        // fist is a hand's, which stretches everything: six or more one-letter
        // "words" in a row is its letter spacing, not six words.
        const longer = lead.length && lead[0]! > m * 1.8 ? lead[0]! : 0
        const letters = m < this.ditMs * Math.sqrt(3 * 7) || longer > 0 ||
          (this.handSent() && rest.length + 1 >= WORD_HISTORY) ||
          (this.spacingCalibrated && m < this.wordBoundary())
        if (letters) {
          this.letterGapMs = m
          if (longer) {
            this.wordGapMs = longer
            this.spacingCalibrated = true
          } else if (this.wordGapMs < m * 1.6) {
            this.wordGapMs = m * (7 / 3)
          }
        } else {
          this.wordGapMs = m
        }
      }
      this.gaps = rest.slice(-GAP_HISTORY)
    }
    this.clampSpacing()
  }

  // --- timing boundaries ---------------------------------------------------------

  /** mark shorter than this = dit; geometric midpoint of the two clusters */
  private markBoundary(): number {
    return Math.sqrt(this.ditMs * this.dahMs)
  }

  /** silence longer than this ends a character */
  private letterBoundary(): number {
    // between the measured intra-character gap and the tracked letter gap
    return Math.sqrt(this.elemGapMs * this.letterGapMs) * this.cfg.letterBreak
  }

  /** silence longer than this is a word break */
  private wordBoundary(): number {
    return Math.max(this.letterBoundary() * 1.2, Math.sqrt(this.letterGapMs * this.wordGapMs) * this.cfg.wordBreak)
  }

  // --- element handling ------------------------------------------------------------

  private onMarkEnded(dur: number) {
    const el: '.' | '-' = dur < this.markBoundary() ? '.' : '-'
    this.noteMargin(this.margin(dur, this.ditMs, this.dahMs))
    this.currentMarks.push(dur)
    this.pattern += el
    this.charFlushed = false
    this.wordFlushed = false
    this.ev.onElement?.(el, dur)

    if (!this.cfg.lockSpeed && dur <= this.dahMs * 5) {
      // (absurdly long marks — someone tuning up — are excluded from adaptation)
      // A mark that fits neither cluster is either noise or a speed jump; two
      // in a row means the sender changed speed — forget the old history so
      // the clusters re-fit to the new speed instead of averaging both.
      const fits = (dur > this.ditMs * 0.6 && dur < this.ditMs * 1.5) || (dur > this.dahMs * 0.6 && dur < this.dahMs * 1.5)
      this.outliers = fits ? 0 : this.outliers + 1
      if (this.outliers >= 2) {
        this.marks = this.marks.slice(-1)
        this.outliers = 0
      }
      this.marks.push(dur)
      if (this.marks.length > MARK_HISTORY) this.marks.shift()
      const a = this.cfg.speedAveraging
      const split = splitClusters(this.marks, 1.8)
      if (split) {
        // Two classes visible: re-fit both clusters from history. The first
        // time (or when the estimate is badly off) snap rather than smooth —
        // the history means are already averaged, and a wrong prior would
        // otherwise misclassify several more elements while it drifts in.
        const off = split.low / this.ditMs
        const snap = !this.calibrated || off < 0.7 || off > 1.4
        const step = snap ? 1 : a
        const prevDit = this.ditMs
        this.ditMs += (split.low - this.ditMs) * step
        this.dahMs += (split.high - this.dahMs) * step
        this.calibrated = true
        if (snap) {
          // The sender's spacing scales with their element speed: rescale the
          // spacing clusters, and forget gaps classified under the old speed
          const ratio = this.ditMs / prevDit
          this.elemGapMs *= ratio
          this.letterGapMs *= ratio
          this.wordGapMs *= ratio
          this.gaps = []
          this.spacingCalibrated = false
        }
      } else if (el === '.') {
        // One class visible: nudge the nearer cluster; until calibrated drag
        // the other along at 3:1 so a stream of only Es (or only Ts) tracks
        this.ditMs += (dur - this.ditMs) * a
        if (!this.calibrated) this.dahMs = this.ditMs * 3
      } else {
        this.dahMs += (dur - this.dahMs) * a
        if (!this.calibrated) this.ditMs = this.dahMs / 3
      }
      this.boundElementSpeed()
      // spacing clusters ride along with the element speed until measured
      this.clampSpacing()

      // re-classify the character in progress against the refined boundary
      const boundary = this.markBoundary()
      this.pattern = this.currentMarks.map(d => (d < boundary ? '.' : '-')).join('')
    }
    this.ev.onPattern?.(this.pattern)
  }

  /**
   * Hold the element estimate inside the speeds CW is sent at. Without this
   * the tracker has no fixed point: a burst of noise marks drags the dit down,
   * a shorter dit widens the window of things that count as elements, and it
   * walks itself to a 2 ms "dit" and 600 WPM of E and T.
   */
  private boundElementSpeed() {
    this.ditMs = clamp(this.ditMs, MIN_DIT_MS, MAX_DIT_MS)
    // keep the clusters physically plausible (dah:dit between 2 and 5)
    if (this.dahMs < this.ditMs * 2) this.dahMs = this.ditMs * 2
    if (this.dahMs > this.ditMs * 5) this.dahMs = this.ditMs * 5
  }

  private onGapEnded(dur: number) {
    // how cleanly did this gap fall into intra / letter / word?
    if (dur < this.wordBoundary()) this.noteMargin(this.margin(dur, this.elemGapMs, this.letterGapMs))
    else if (dur < this.wordGapMs * 2) this.noteMargin(this.margin(dur, this.letterGapMs, this.wordGapMs))
    if (this.cfg.lockSpeed || !Number.isFinite(dur)) return
    if (dur < this.letterBoundary()) {
      // The gap between the elements of a letter: a keyer makes it one dit, a
      // straight key rarely does (1.2–1.8 is usual). The letter boundary sits
      // between this and the letter gap, so it has to be measured, not assumed.
      this.elemGapMs += (dur - this.elemGapMs) * this.cfg.speedAveraging
      this.clampSpacing()
      return
    }
    // Long pauses — the sender gathering their thoughts, or the end of an over
    // — must not stretch the word gap. The limit is in dits, not in multiples
    // of the tracked word gap, which would let each long pause raise the bar
    // for the next one until a whole over counted as one word.
    if (dur > this.ditMs * MAX_GAP_DITS) return

    const a = this.cfg.speedAveraging
    const single = splitClusters(this.gaps.filter(g => g >= this.ditMs * 2), 1.7) === null
    if (dur < this.wordBoundary()) {
      this.letterGapMs += (dur - this.letterGapMs) * a
    } else if (single && this.gaps.length >= 2 && dur > this.wordGapMs * 1.8) {
      // Every long gap so far was the same size and this one is far longer:
      // the "word gaps" were the stretched letter gaps of a Farnsworth-spaced
      // (or slow-spacing) sender — promote them and adopt this as the word gap
      this.letterGapMs = this.wordGapMs
      this.wordGapMs = dur
      this.spacingCalibrated = true
    } else {
      this.wordGapMs += (dur - this.wordGapMs) * a
    }
    this.gaps.push(dur)
    if (this.gaps.length > GAP_HISTORY) this.gaps.shift()

    // Two visible spacing classes ⇒ letter/word clusters can be re-fitted
    // (gaps under 2 dits are stale intra-character gaps from before a speed re-fit)
    this.gaps = this.gaps.filter(g => g >= this.ditMs * 2)
    const split = splitClusters(this.gaps, 1.7)
    if (split) {
      this.letterGapMs += (split.low - this.letterGapMs) * a
      this.wordGapMs += (split.high - this.wordGapMs) * a
      this.spacingCalibrated = true
    }
    this.clampSpacing()
  }

  /**
   * Hold the spacing estimates where CW spacing can actually be. The standard
   * is 3 and 7 dits; Farnsworth stretches both, but in proportion — even ARRL
   * 20/5 spacing keeps the letter gap inside 30 dits, and no sender's word gap
   * is more than about four letter gaps. Without the upper bounds the
   * trackers drift the same way the speed estimate used to: a long silence
   * between overs stretches the word gap, the stretched word gap widens the
   * window of silences that are allowed to stretch it further, and the decoder
   * ends up running a whole over together as one word while splitting every
   * letter of it apart.
   */
  private clampSpacing() {
    // nobody leaves less than half a dit or more than 2.5 inside a letter
    this.elemGapMs = clamp(this.elemGapMs, this.ditMs * 0.5, this.ditMs * 2.5)
    this.letterGapMs = clamp(this.letterGapMs, Math.max(this.ditMs * 2, this.elemGapMs * 1.6), this.ditMs * 30)
    this.wordGapMs = clamp(this.wordGapMs, this.letterGapMs * 1.6, this.letterGapMs * 4)
  }

  private flushChar() {
    this.charFlushed = true
    if (!this.pattern) return
    const ch = charForPattern(this.pattern)
    const pattern = this.pattern
    this.pattern = ''
    this.currentMarks = []
    this.ev.onPattern?.('')
    this.hasOutput = true
    this.charsInWord++
    this.ev.onCharacter?.(ch, pattern)
  }

  /**
   * Print a word space, and keep the evidence of what the spacing classes
   * are. Words of one letter are rare in real traffic — "R R", "E E", a lone
   * "K" — so when a hand-sent fist's words keep coming out a single letter
   * long, the gaps being called word gaps are its letter gaps (a straight key
   * leaving 8–15 dits between letters), and the spacing clusters move up.
   */
  private emitWordGap() {
    this.ev.onWordGap?.()
    if (this.charsInWord) {
      this.wordLens.push(this.charsInWord)
      if (this.wordLens.length > WORD_HISTORY) this.wordLens.shift()
    }
    this.charsInWord = 0
    if (this.cfg.lockSpeed || this.wordLens.length < WORD_HISTORY || !this.handSent()) return
    if (mean(this.wordLens) <= ONE_LETTER_WORDS) {
      this.letterGapMs = this.wordGapMs
      this.wordGapMs = this.letterGapMs * (7 / 3)
      this.gaps = []
      this.wordLens = []
      this.clampSpacing()
    }
  }

  /**
   * The fist is a hand's, not a keyer's: the gap inside a letter measures a
   * quarter dit or more over the dit. A keyer times it to exactly one, so a
   * keyed run of one-letter words (a character drill, "E E") keeps its spaces.
   */
  private handSent(): boolean {
    return this.elemGapMs >= this.ditMs * 1.25
  }

  /** silence after which the next element starts a new burst */
  private burstGapMs(): number {
    return Math.max(BURST_GAP_MIN_MS, this.wordGapMs * BURST_GAP_WORDS)
  }

  /**
   * Copy is printed once the burst is long enough to be code *and* the level
   * histogram agrees there is a signal on the frequency — a squelch, in the
   * sense the knob on a radio has. Band hash and a muted receiver's own
   * residue both key the gate now and then; neither puts a second mode in the
   * histogram with a transmission's duty cycle behind it.
   */
  private get printable(): boolean {
    const n = this.burstMarks.length
    const need = this.cfg.squelch ? BURST_ELEMENTS : 1
    if (n < need) {
      this.holdReason = n ? `waiting for ${need} elements (${n} so far)` : ''
      return false
    }
    const v = n >= BURST_ELEMENTS ? this.burstVerdict() : 'tone'
    if (v === 'fsk') {
      this.fskSeenMs = this.timeMs
      if (this.cfg.rejectRtty) {
        this.holdReason = 'RTTY on this pitch'
        return false
      }
    }
    if (!this.cfg.squelch || this.signalPresent) {
      this.holdReason = ''
      return true
    }
    // The histogram's two-mode test is blind when the window holds three
    // levels — band noise, a station between overs, and the operator's own
    // sidetone well above both — so a burst also passes on its own strength:
    // marks this far over the noise scale are not something Rayleigh noise
    // produces (P = e^(−k²/2) per sample, 10⁻¹⁴ at 8 σ), provided they are a
    // tone and not the whole band getting louder.
    const level = median(this.burstLevels)
    if (v !== 'tone') {
      const db = 20 * Math.log10(Math.max(level, 1e-9) / Math.max(median(this.burstSides), 1e-9))
      this.holdReason = `broadband: only ${db.toFixed(0)} dB louder on the pitch than 170 Hz away (needs 10)`
      return false
    }
    const over = this.sigma > 0 ? level / this.sigma : 0
    if (over < STRONG_BURST_SIGMA) {
      this.holdReason = `no transmission seen in the level history, and marks only ${(20 * Math.log10(Math.max(over, 1e-9))).toFixed(0)} dB over the noise (needs ${(20 * Math.log10(STRONG_BURST_SIGMA)).toFixed(0)})`
      return false
    }
    this.holdReason = ''
    return true
  }

  /**
   * What the burst's marks are, judged by the side detectors 170 Hz away:
   *  - 'fsk'   the other tone of an RTTY pair fills our gaps and vanishes in
   *            our marks — radioteletype, which no CW decoder can read
   *  - 'tone'  narrowband: far louder on the pitch than beside it
   *  - 'broad' as loud beside the pitch as on it: static, splatter, or band
   *            noise returning between the operator's own muted elements
   */
  private burstVerdict(): 'fsk' | 'tone' | 'broad' {
    const level = median(this.burstLevels)
    const side = median(this.burstSides)
    const gapSide = median(this.burstGapSides.slice(1))
    if (gapSide >= level * FSK_PARTNER_LEVEL && gapSide >= side * FSK_CONTRAST) return 'fsk'
    return level >= side * TONE_CONTRAST ? 'tone' : 'broad'
  }

  /** Force out whatever is pending (end of a recording). */
  flush() {
    if (this.keyed) {
      // treat the end of audio as key-up
      this.setKeyed(false, this.timeMs)
    }
    if (!this.charFlushed) this.flushChar()
  }

  /** Cheap snapshot for UI meters (call from rAF, not per tick). */
  getState(): CwDecoderState {
    const snr = this.floor > 0 ? 20 * Math.log10(Math.max(this.peak, 1e-9) / this.floor) : 0
    return {
      magnitude: this.magnitude,
      floor: this.floor,
      peak: this.peak,
      threshold: this.threshold,
      snrDb: snr,
      keyed: this.keyed,
      ditMs: this.ditMs,
      dahMs: this.dahMs,
      wpm: 1200 / this.ditMs,
      elemGapMs: this.elemGapMs,
      letterGapMs: this.letterGapMs,
      wordGapMs: this.wordGapMs,
      pattern: this.pattern,
      timeMs: this.timeMs,
      calibrated: this.calibrated,
      signalPresent: this.signalPresent,
      confidence: this.confidence,
      fsk: this.timeMs - this.fskSeenMs < FSK_HOLD_MS,
      decoding: this.live,
      hold: this.live || !this.burstMarks.length ? '' : this.holdReason
    }
  }
}
