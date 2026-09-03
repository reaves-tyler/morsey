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
 * 2. Adaptive threshold — a CFAR-style detector: while the key is up, the
 *    noise floor's mean and deviation are tracked; while it is down, the
 *    signal peak is tracked (fast attack, moderate release so QSB fades are
 *    followed). Key-down needs the envelope above floor + 3.5 σ *and* above
 *    the `minSnrDb` squelch *and* halfway between floor and peak; key-up has
 *    hysteresis below that. The peak relaxes to the floor over a few seconds
 *    of silence so a station that vanished releases the threshold for a
 *    weaker one. This replaces the fixed 0.6 × running-average rule of the
 *    OZ1JHM decoder, which mis-keys during word gaps and deep fades. A manual
 *    mode exposes the raw level for operators who prefer to set it by eye.
 *
 * 3. Noise blanker — a state change must persist `noiseBlankerMs` before it
 *    is believed (QMX default 10 ms). The accepted transition keeps its
 *    original timestamp so element lengths are not shortened by the blanker.
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
 *
 * 5. Emission — characters are flushed as soon as the running silence exceeds
 *    the letter-gap boundary (not when the next mark starts), so the terminal
 *    updates in real time; word spaces likewise.
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
/** noise statistics are learned for this long after start before keying is believed */
const WARMUP_MS = 200

/** EMA coefficient for a time constant `tauMs` sampled every `dtMs` */
function emaCoeff(tauMs: number, dtMs: number): number {
  return 1 - Math.exp(-dtMs / tauMs)
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length
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
  private floor = 0
  private devSq = 0
  private peak = 0
  private threshold = 0
  private levelsInit = false
  private warmupUntilMs = 0
  private rawState = false
  /** time the envelope first fell below the on-level during a mark (symmetric edge timing) */
  private fallSinceMs = -1
  private candidateState = false
  private candidateSinceMs = 0
  private keyed = false
  private lastEdgeMs = 0
  private hasEdge = false
  private aFloor = 0
  private aFloorWarm = 0
  private aPeakUp = 0
  private aPeakDown = 0
  private aPeakRelease = 0
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
    // level-tracker time constants (see class comment)
    const dt = (this.hop / sampleRate) * 1000
    this.aFloor = emaCoeff(300, dt)
    this.aFloorWarm = emaCoeff(40, dt)
    this.aPeakUp = emaCoeff(40, dt)
    this.aPeakDown = emaCoeff(120, dt)
    this.aPeakRelease = emaCoeff(1500, dt)
  }

  /** Re-seed timing from `initialWpm` (called on speed-prior changes and by `reset`). */
  resetTiming() {
    this.ditMs = 1200 / this.cfg.initialWpm
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
    this.magnitude = 0
    this.floor = 0
    this.devSq = 0
    this.peak = 0
    this.threshold = 0
    this.levelsInit = false
    this.warmupUntilMs = 0
    this.outliers = 0
    this.spacingCalibrated = false
    this.rawState = false
    this.fallSinceMs = -1
    this.candidateState = false
    this.keyed = false
    this.hasEdge = false
    this.sampleCount = 0
    this.pattern = ''
    this.currentMarks = []
    this.charFlushed = true
    this.wordFlushed = true
    this.hasOutput = false
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

    // --- level trackers (CFAR): noise statistics while the key is up, signal peak while down ---
    if (!this.levelsInit) {
      this.levelsInit = true
      this.floor = mag
      this.peak = mag
      this.devSq = mag * mag * 0.1
      this.warmupUntilMs = nowMs + WARMUP_MS
    }
    const warmingUp = nowMs < this.warmupUntilMs
    if (!this.rawState || warmingUp) {
      // Robust noise statistics: samples far above the floor (the smoothed
      // tails of the last element, or a weak signal below threshold) are
      // outliers, not noise — letting them in would inflate the deviation and
      // push the CFAR gate up into the signal at high speeds.
      const d = mag - this.floor
      if (warmingUp) {
        // fast, unconditional learning so the estimate converges inside the
        // warm-up even when the stream began with digital silence
        this.floor += d * this.aFloorWarm
        this.devSq += (d * d - this.devSq) * this.aFloorWarm
      } else if (d * d <= this.devSq * 9) {
        this.floor += d * this.aFloor
        this.devSq += (d * d - this.devSq) * this.aFloor
      }
      this.peak += (this.floor - this.peak) * this.aPeakRelease
    } else {
      this.peak += (mag - this.peak) * (mag > this.peak ? this.aPeakUp : this.aPeakDown)
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
      const dev = Math.sqrt(this.devSq)
      onLevel = Math.max(
        this.floor + span * 0.5, // halfway up a signal we are already tracking
        this.floor + dev * 3.5, // constant-false-alarm gate against noise excursions
        this.floor * Math.pow(10, this.cfg.minSnrDb / 20), // operator squelch
        0.005 // digital silence (or a far-off tone's sidelobe) must never key
      )
      offLevel = this.floor + Math.max(span * 0.4, dev * 1.5)
      if (offLevel > onLevel * 0.9) offLevel = onLevel * 0.9
    }
    this.threshold = onLevel
    let raw = this.rawState
    let edgeAt = nowMs
    if (warmingUp) {
      raw = false // learn the noise statistics before believing anything
    } else if (!raw) {
      if (mag > onLevel) raw = true
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
      const silence = nowMs - this.lastEdgeMs
      if (!this.charFlushed && silence >= this.letterBoundary()) this.flushChar()
      if (!this.wordFlushed && this.hasOutput && silence >= this.wordBoundary()) {
        this.wordFlushed = true
        this.ev.onWordGap?.()
      }
    }
  }

  private setKeyed(down: boolean, atMs: number) {
    const prevEdge = this.lastEdgeMs
    const hadEdge = this.hasEdge
    this.keyed = down
    this.lastEdgeMs = atMs
    this.hasEdge = true
    this.ev.onKey?.(down, atMs)

    if (!hadEdge) return
    const dur = atMs - prevEdge
    if (down) this.onGapEnded(dur)
    else this.onMarkEnded(dur)
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
    // sub-dit blips that slipped past the blanker are noise, not elements
    if (dur < this.ditMs * 0.3) return

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
      // keep the clusters physically plausible (dah:dit between 2 and 5)
      if (this.dahMs < this.ditMs * 2) this.dahMs = this.ditMs * 2
      if (this.dahMs > this.ditMs * 5) this.dahMs = this.ditMs * 5
      // spacing clusters ride along with the element speed until measured
      this.letterGapMs = Math.min(Math.max(this.letterGapMs, this.ditMs * 2), this.ditMs * 30)
      if (this.wordGapMs < this.letterGapMs * 1.6) this.wordGapMs = this.letterGapMs * 1.6

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
    // long pauses (the other station stopped sending) must not stretch the word gap
    if (dur > Math.max(this.wordGapMs * 3, this.ditMs * 45)) return

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
    // plausibility: letter gap 2–30 dits (Farnsworth stretches far), word gap ≥ 1.6 × letter gap
    this.letterGapMs = Math.min(Math.max(this.letterGapMs, this.ditMs * 2), this.ditMs * 30)
    if (this.wordGapMs < this.letterGapMs * 1.6) this.wordGapMs = this.letterGapMs * 1.6
  }

  private flushChar() {
    this.charFlushed = true
    if (!this.pattern) return
    const ch = charForPattern(this.pattern)
    const pattern = this.pattern
    this.pattern = ''
    this.currentMarks = []
    this.hasOutput = true
    this.ev.onPattern?.('')
    this.ev.onCharacter?.(ch, pattern)
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
      confidence: this.confidence
    }
  }
}
