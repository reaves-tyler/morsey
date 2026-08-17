import { REVERSE_MORSE } from './morse'

/**
 * Pure keyer engine — every timing state machine of the sending side, with
 * zero dependencies on Vue, Nuxt, audio, or real clocks. The host injects a
 * clock and timer scheduler and receives events through callbacks, which is
 * what makes the engine deterministic under fake timers in tests.
 *
 * Inputs are raw TIP/RING contact closures (any key is one or two dumb
 * contacts); `keyType` decides what they mean, like an HF rig's keyer menu:
 *
 *  - straight:  tip contact = the key (ring ignored, so mono plugs are safe).
 *               Tone follows the closure; the operator does all timing.
 *               Elements are classified against an adaptive dit length.
 *  - bug:       dit contact streams automatic dits at the keyer speed while
 *               held; dah contact is manual, like a straight key.
 *  - iambic-a:  electronic keyer; squeeze alternates. Releasing everything
 *               stops after the element in progress.
 *  - iambic-b:  as A, plus the Curtis-B memory: a squeeze seen during an
 *               element arms ONE extra opposite element that plays if both
 *               paddles are released before the next decision point.
 *
 * `paddleReverse` swaps the tip/ring roles (standard wiring is tip = dit).
 */

export type Contact = 'tip' | 'ring'
export type Element = '.' | '-'
export type EngineKeyType = 'straight' | 'bug' | 'iambic-a' | 'iambic-b'

export interface KeyerConfig {
  keyType: EngineKeyType
  paddleReverse: boolean
  /** electronic-keyer element speed; also seeds the manual classifier */
  sendWpm: number
}

export interface KeyerEngineHost {
  /** monotonic-enough clock in ms */
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  /** live config, read at every decision point */
  config(): KeyerConfig
  /** sidetone on/off */
  onToneStart(): void
  onToneEnd(): void
  /** in-progress symbol buffer changed (e.g. ".-") */
  onSymbols(symbols: string): void
  /** a full letter sat unfinished long enough and was committed */
  onLetter(char: string): void
  /** enough silence passed to count as a word boundary */
  onWordGap(): void
  /** live dit/dah preview while a manual contact is held ('' when released) */
  onHoldPreview(preview: '' | Element): void
  /** adaptive dit estimate moved (ms); fires with 0 on recalibration */
  onAdaptiveDit(ms: number): void
}

/** Manual presses shorter than this are treated as contact bounce. */
export const DEBOUNCE_MS = 20
/** Adaptive dit estimate is clamped to this range (ms). */
export const MIN_DIT_MS = 40
export const MAX_DIT_MS = 300

const opposite = (el: Element): Element => (el === '.' ? '-' : '.')

export class KeyerEngine {
  private host: KeyerEngineHost

  private symbols = ''
  private letterTimer: unknown = null
  private wordTimer: unknown = null

  // manual keying (straight key; the dah lever of a bug)
  private manualDown = false
  private pressStart = 0
  private previewTimer: unknown = null
  private adaptiveDit = 0

  // electronic keyer (iambic A/B)
  private ditHeld = false
  private dahHeld = false
  private phase: 'idle' | 'tone' | 'gap' = 'idle'
  private currentEl: Element = '.'
  private lastEl: Element = '-'
  private memoryEl: Element | null = null
  private elementTimer: unknown = null

  // bug auto-dit stream
  private bugHeld = false

  constructor(host: KeyerEngineHost) {
    this.host = host
  }

  // ---- Timing helpers --------------------------------------------------------

  /** Nominal dit length at the configured keyer speed. */
  ditMs(): number {
    return (1.2 / this.host.config().sendWpm) * 1000
  }

  /** Manual classifier's current dit estimate (adaptive, falls back to nominal). */
  estDit(): number {
    return this.adaptiveDit || this.ditMs()
  }

  /** A manual press at or above this duration is a dah (midpoint of 1u and 3u). */
  dahThresholdMs(): number {
    return Math.round(this.estDit() * 2)
  }

  /** Forget the operator calibration (call when sendWpm changes). */
  resetCalibration() {
    this.adaptiveDit = 0
    this.host.onAdaptiveDit(0)
  }

  // ---- Symbol buffer / decode --------------------------------------------------

  private pushSymbol(el: Element) {
    this.symbols += el
    this.host.onSymbols(this.symbols)
  }

  private clearGapTimers() {
    if (this.letterTimer) this.host.clearTimer(this.letterTimer)
    if (this.wordTimer) this.host.clearTimer(this.wordTimer)
    this.letterTimer = null
    this.wordTimer = null
  }

  private scheduleGapTimers() {
    this.clearGapTimers()
    const u = this.estDit()
    // Generous gaps: nominal is 3u between letters and 7u between words, but a
    // human fist pauses between elements too — wait ~4u (min 450 ms) before
    // committing a letter, ~8u (min 1.2 s) before a word boundary.
    this.letterTimer = this.host.setTimer(() => this.finalizeLetter(), Math.max(u * 4, 450))
    this.wordTimer = this.host.setTimer(() => this.host.onWordGap(), Math.max(u * 8, 1200))
  }

  private finalizeLetter() {
    if (!this.symbols) return
    const char = REVERSE_MORSE[this.symbols] ?? '?'
    this.symbols = ''
    this.host.onSymbols('')
    this.host.onLetter(char)
  }

  // ---- Contact routing -----------------------------------------------------------

  private roleOf(contact: Contact): 'key' | 'dit' | 'dah' | null {
    const cfg = this.host.config()
    if (cfg.keyType === 'straight') {
      // Tip only: a mono plug permanently shorts ring to sleeve, which would
      // otherwise read as a stuck contact. Sideswipers wire both arms to tip.
      return contact === 'tip' ? 'key' : null
    }
    const isDit = (contact === 'tip') !== cfg.paddleReverse
    return isDit ? 'dit' : 'dah'
  }

  contactDown(contact: Contact) {
    const cfg = this.host.config()
    const role = this.roleOf(contact)
    if (!role) return
    if (role === 'key') return this.manualDownHandler()
    if (cfg.keyType === 'bug') {
      if (role === 'dit') {
        this.bugHeld = true
        if (this.phase === 'idle') this.startBugDit()
      } else {
        this.manualDownHandler() // bug dahs are manual
      }
      return
    }
    // iambic
    if (role === 'dit') this.ditHeld = true
    else this.dahHeld = true
    if (this.phase === 'idle') {
      const el = this.chooseElement()
      if (el) this.startElement(el)
    } else if (cfg.keyType === 'iambic-b' && this.ditHeld && this.dahHeld) {
      // Curtis-B: a squeeze during an element arms one extra opposite element
      this.memoryEl = opposite(this.currentEl)
    }
  }

  contactUp(contact: Contact) {
    const cfg = this.host.config()
    const role = this.roleOf(contact)
    if (!role) return
    if (role === 'key') return this.manualUpHandler()
    if (cfg.keyType === 'bug') {
      if (role === 'dit') this.bugHeld = false
      else this.manualUpHandler()
      return
    }
    if (role === 'dit') this.ditHeld = false
    else this.dahHeld = false
  }

  // ---- Manual keying ---------------------------------------------------------

  private manualDownHandler() {
    if (this.manualDown) return
    this.manualDown = true
    this.clearGapTimers() // never commit a letter while the key is down
    this.pressStart = this.host.now()
    this.host.onToneStart()
    // Live preview: a press starts as a dit and becomes a dah the moment the
    // hold crosses the threshold, so the operator can see the boundary.
    this.host.onHoldPreview('.')
    this.previewTimer = this.host.setTimer(() => {
      if (this.manualDown) this.host.onHoldPreview('-')
    }, this.dahThresholdMs())
  }

  private manualUpHandler() {
    if (!this.manualDown) return
    this.manualDown = false
    this.host.onToneEnd()
    if (this.previewTimer) this.host.clearTimer(this.previewTimer)
    this.previewTimer = null
    this.host.onHoldPreview('')
    const dur = this.host.now() - this.pressStart
    if (dur < DEBOUNCE_MS) {
      // Contact bounce — ignore, but keep waiting on the pending symbols
      this.scheduleGapTimers()
      return
    }
    const est = this.estDit()
    const isDit = dur < est * 2
    this.pushSymbol(isDit ? '.' : '-')
    // Calibrate toward this press: a dit implies its own length, a dah implies
    // a third of it. Blend 30% per press, clamped to sane bounds.
    const implied = isDit ? dur : dur / 3
    this.adaptiveDit = Math.min(MAX_DIT_MS, Math.max(MIN_DIT_MS, est * 0.7 + implied * 0.3))
    this.host.onAdaptiveDit(this.adaptiveDit)
    this.scheduleGapTimers()
  }

  // ---- Electronic keyer (iambic A/B) ----------------------------------------

  private chooseElement(): Element | null {
    if (this.ditHeld && this.dahHeld) return opposite(this.lastEl)
    if (this.ditHeld) return '.'
    if (this.dahHeld) return '-'
    if (this.host.config().keyType === 'iambic-b' && this.memoryEl) {
      const el = this.memoryEl
      this.memoryEl = null
      return el
    }
    return null
  }

  private startElement(el: Element) {
    // Curtis-B latch: a squeeze held as this element begins arms one opposite
    // element, so releasing both mid-element still completes the alternation.
    // (contactDown re-arms it if the squeeze starts mid-element instead.)
    this.memoryEl = this.host.config().keyType === 'iambic-b' && this.ditHeld && this.dahHeld
      ? opposite(el)
      : null
    this.currentEl = el
    this.lastEl = el
    this.phase = 'tone'
    this.clearGapTimers()
    this.host.onToneStart()
    this.elementTimer = this.host.setTimer(() => this.endElement(), el === '.' ? this.ditMs() : this.ditMs() * 3)
  }

  private endElement() {
    this.host.onToneEnd()
    this.pushSymbol(this.currentEl)
    this.phase = 'gap'
    this.elementTimer = this.host.setTimer(() => this.endGap(), this.ditMs())
  }

  private endGap() {
    this.elementTimer = null
    const next = this.chooseElement()
    if (next) {
      this.startElement(next)
    } else {
      this.phase = 'idle'
      this.scheduleGapTimers()
    }
  }

  // ---- Bug auto-dit stream ------------------------------------------------------

  private startBugDit() {
    this.phase = 'tone'
    this.clearGapTimers()
    this.host.onToneStart()
    this.elementTimer = this.host.setTimer(() => {
      this.host.onToneEnd()
      this.pushSymbol('.')
      this.phase = 'gap'
      this.elementTimer = this.host.setTimer(() => {
        this.elementTimer = null
        if (this.bugHeld) {
          this.startBugDit()
        } else {
          this.phase = 'idle'
          this.scheduleGapTimers()
        }
      }, this.ditMs())
    }, this.ditMs())
  }

  // ---- Housekeeping ----------------------------------------------------------------

  /** Clear the in-progress symbol buffer and pending letter/word timers. */
  clear() {
    this.symbols = ''
    this.host.onSymbols('')
    this.clearGapTimers()
  }

  /** Hard stop: release everything, silence the tone, drop all timers. */
  reset() {
    if (this.elementTimer) this.host.clearTimer(this.elementTimer)
    if (this.previewTimer) this.host.clearTimer(this.previewTimer)
    this.elementTimer = null
    this.previewTimer = null
    this.clearGapTimers()
    if (this.manualDown || this.phase === 'tone') this.host.onToneEnd()
    this.host.onHoldPreview('')
    this.manualDown = false
    this.ditHeld = false
    this.dahHeld = false
    this.bugHeld = false
    this.memoryEl = null
    this.phase = 'idle'
    this.symbols = ''
    this.host.onSymbols('')
  }
}
