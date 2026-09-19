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
  tickMs: 2
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
  /** tracked letter gap and word gap in ms */
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
  /** elements in the current burst, and the characters it has produced so far */
  private burstElements = 0
  private held: ({ ch: string; pattern: string } | null)[] = []

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
      patch.tickMs !== undefined && patch.tickMs !== prev.tickMs
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
    this.letterGapMs = this.ditMs * 3
    this.wordGapMs = this.ditMs * 7
    this.marks = []
    this.gaps = []
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
    if (this.pattern) this.flushChar()
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
    this.burstElements = 0
    this.held = []
  }

  /** Feed PCM (mono, -1..1). Any block length is fine. */
  process(samples: Float32Array | number[]) {
    const n = samples.length
    for (let i = 0; i < n; i++) {
      this.det.push(samples[i]!)
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
      this.peak += (mag - this.peak) * this.aPeakDown
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
        this.sigma * (this.signalPresent ? CFAR_OPEN : CFAR_QUIET), // CFAR gate against band noise
        this.floor * Math.pow(10, this.cfg.minSnrDb / 20), // operator squelch
        ABSOLUTE_FLOOR // digital silence (or a far-off tone's sidelobe) must never key
      )
      offLevel = this.floor + span * 0.4
      if (offLevel > onLevel * 0.9) offLevel = onLevel * 0.9
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

    // --- real-time flushing during silence ---
    if (!this.keyed && this.hasEdge) {
      const silence = nowMs - this.gapStartMs
      if (!this.charFlushed && silence >= this.letterBoundary()) this.flushChar()
      if (!this.wordFlushed && (this.hasOutput || this.held.length) && silence >= this.wordBoundary()) {
        this.wordFlushed = true
        this.emit(null)
      }
      if (this.held.length) {
        if (this.printable) this.releaseBurst()
        else if (silence >= this.burstGapMs()) {
          // the burst ended without ever looking like code — drop it unprinted
          this.held = []
          this.burstElements = 0
        }
      }
    }
  }

  /**
   * Shortest mark that can be an element. Relative to the tracked dit so a
   * clipped element at 12 WPM is still rejected, but never below the absolute
   * limit, which is what keeps a static crash from ever becoming an `E`.
   */
  private minMarkMs(): number {
    return Math.max(MIN_MARK_MS, this.ditMs * 0.35)
  }

  private setKeyed(down: boolean, atMs: number) {
    this.keyed = down
    this.ev.onKey?.(down, atMs)
    if (down) {
      this.markStartMs = atMs
      return
    }
    const dur = atMs - this.markStartMs
    if (dur < this.minMarkMs()) {
      // Impulse noise. Drop it *without* moving `gapStartMs`: a crash in the
      // middle of a letter gap must not split that gap into two short ones and
      // glue the letters on either side of it together.
      return
    }
    if (this.hasEdge) {
      const gap = this.markStartMs - this.gapStartMs
      if (gap >= this.burstGapMs()) this.burstElements = 0
      this.onGapEnded(gap)
    }
    this.hasEdge = true
    this.burstElements++
    this.onMarkEnded(dur)
    if (this.held.length && this.printable) this.releaseBurst()
    this.gapStartMs = atMs
  }

  // --- timing boundaries ---------------------------------------------------------

  /** mark shorter than this = dit; geometric midpoint of the two clusters */
  private markBoundary(): number {
    return Math.sqrt(this.ditMs * this.dahMs)
  }

  /** silence longer than this ends a character */
  private letterBoundary(): number {
    // between the intra-character gap (≈1 dit) and the tracked letter gap
    return Math.sqrt(this.ditMs * this.letterGapMs)
  }

  /** silence longer than this is a word break */
  private wordBoundary(): number {
    return Math.sqrt(this.letterGapMs * this.wordGapMs)
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
      // Hold the estimate inside the speeds CW is sent at. Without this the
      // tracker has no fixed point: a burst of noise marks drags the dit down,
      // a shorter dit widens the window of things that count as elements, and
      // it walks itself to a 2 ms "dit" and 600 WPM of E and T.
      this.ditMs = clamp(this.ditMs, MIN_DIT_MS, MAX_DIT_MS)
      // keep the clusters physically plausible (dah:dit between 2 and 5)
      if (this.dahMs < this.ditMs * 2) this.dahMs = this.ditMs * 2
      if (this.dahMs > this.ditMs * 5) this.dahMs = this.ditMs * 5
      // spacing clusters ride along with the element speed until measured
      this.clampSpacing()

      // re-classify the character in progress against the refined boundary
      const boundary = this.markBoundary()
      this.pattern = this.currentMarks.map(d => (d < boundary ? '.' : '-')).join('')
    }
    this.ev.onPattern?.(this.pattern)
  }

  private onGapEnded(dur: number) {
    // how cleanly did this gap fall into intra / letter / word?
    if (dur < this.wordBoundary()) this.noteMargin(this.margin(dur, this.ditMs, this.letterGapMs))
    else if (dur < this.wordGapMs * 2) this.noteMargin(this.margin(dur, this.letterGapMs, this.wordGapMs))
    if (this.cfg.lockSpeed) return
    // intra-character gaps carry no spacing information we use
    if (dur < this.letterBoundary()) return
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
    this.letterGapMs = clamp(this.letterGapMs, this.ditMs * 2, this.ditMs * 30)
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
    this.emit({ ch, pattern })
  }

  /** silence after which the next element starts a new burst */
  private burstGapMs(): number {
    return Math.max(BURST_GAP_MIN_MS, this.wordGapMs * BURST_GAP_WORDS)
  }

  /**
   * Queue a character (or, for `null`, a word space) behind the burst squelch,
   * or pass it straight through once the burst has proved itself.
   */
  private emit(item: { ch: string; pattern: string } | null) {
    // `!held.length` keeps the queue in order: the squelch can open part-way
    // through a tick, and a character flushed after it opened must not overtake
    // the ones still waiting from before.
    if (this.printable && !this.held.length) {
      this.hasOutput = true
      if (item) this.ev.onCharacter?.(item.ch, item.pattern)
      else this.ev.onWordGap?.()
      return
    }
    this.held.push(item)
  }

  /**
   * Copy is printed once the burst is long enough to be code *and* the level
   * histogram agrees there is a signal on the frequency — a squelch, in the
   * sense the knob on a radio has. Band hash and a muted receiver's own
   * residue both key the gate now and then; neither puts a second mode in the
   * histogram with a transmission's duty cycle behind it.
   */
  private get printable(): boolean {
    return this.burstElements >= BURST_ELEMENTS && this.signalPresent
  }

  /** the burst qualified: let everything it produced out */
  private releaseBurst() {
    const held = this.held
    this.held = []
    for (const item of held) {
      this.hasOutput = true
      if (item) this.ev.onCharacter?.(item.ch, item.pattern)
      else this.ev.onWordGap?.()
    }
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
      letterGapMs: this.letterGapMs,
      wordGapMs: this.wordGapMs,
      pattern: this.pattern,
      timeMs: this.timeMs,
      calibrated: this.calibrated,
      signalPresent: this.signalPresent,
      confidence: this.confidence
    }
  }
}
