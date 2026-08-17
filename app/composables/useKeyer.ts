import { REVERSE_MORSE } from '~/utils/morse'
import type { KeyType } from '~/composables/useProgress'

/**
 * Sending-side keyer: turns physical contact closures into dits and dahs,
 * then decodes them into text.
 *
 * The hardware is always dumb — any key (straight, sideswiper, bug, single or
 * dual paddle) is just one or two momentary contacts reaching us via the
 * keyboard, the on-screen keys, or the USB bridge (hardware/pico-bridge)
 * over Web Serial. What those contacts MEAN is decided here, by the
 * `keyType` setting — exactly like the keyer menu on an HF transceiver:
 *
 *  - straight:  any contact = the key. Tone follows the closure; the operator
 *               does all timing (also covers sideswipers/cooties).
 *  - bug:       dit contact produces an automatic dit stream at sendWpm while
 *               held; dah contact behaves like a straight key (manual dahs) —
 *               the classic semi-automatic emulation.
 *  - iambic-a:  electronic keyer; squeeze alternates. Releasing both stops
 *               after the element in progress.
 *  - iambic-b:  as A, plus the Curtis-B memory: releasing both mid-element
 *               after a squeeze sends ONE extra opposite element.
 *
 * `paddleReverse` swaps the tip/ring roles (standard wiring is tip = dit).
 * Manual timing (straight key, bug dahs) is classified against an adaptive
 * dit-length estimate that calibrates to the operator's fist; letter/word
 * commit gaps are stretched (4u/8u with 450 ms / 1.2 s floors) so the decoder
 * waits for a character to finish. Backspace clears.
 *
 * All state is module-level: the keyer bar and the send page share one keyer
 * and one serial connection, which survives page navigation like a rig
 * staying plugged in.
 */

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Presses shorter than this are treated as contact bounce and discarded. */
const DEBOUNCE_MS = 20
/** Adaptive dit estimate is clamped to this range (ms). */
const MIN_DIT_MS = 40
const MAX_DIT_MS = 300

/** Physical contact on the plug: tip or ring (sleeve is ground). */
export type Contact = 'tip' | 'ring'

// ---- Shared state (one keyer for the whole app) -----------------------------

const decoded = ref('')
const currentSymbols = ref('')
const keyed = ref(false) // tone currently on (for UI)
/** Live classification of a manual element being held ('.' or '-'). */
const holdPreview = ref<'' | '.' | '-'>('')
const serialConnected = ref(false)
const adaptiveDitMs = ref(0)

let letterTimer: ReturnType<typeof setTimeout> | null = null
let wordTimer: ReturnType<typeof setTimeout> | null = null
let generation = 0 // bumped on detach to kill in-flight element loops
let keyboardAttached = false
let speedWatcherAttached = false

// manual keying (straight key; the dah lever of a bug)
let pressStart = 0
let manualDown = false
let holdTimer: ReturnType<typeof setTimeout> | null = null

// electronic keyer (iambic A/B)
let ditPaddle = false
let dahPaddle = false
let sending = false
let lastElement: '.' | '-' = '-'
/** Curtis-B memory: extra element owed after a squeeze released mid-element */
let memoryEl: '.' | '-' | null = null

// bug auto-dit stream
let bugDit = false

// Web Serial handles (survive navigation)
let serialPort: any = null
let serialReader: any = null

export function useKeyer() {
  const { progress } = useProgress()
  const audio = useMorseAudio()

  const serialSupported = computed(() =>
    import.meta.client && 'serial' in navigator
  )

  const keyType = computed<KeyType>(() => progress.value.settings.keyType)

  /** Nominal dit length at the configured sending speed. */
  const sendDitMs = computed(() => (1.2 / progress.value.settings.sendWpm) * 1000)

  if (!speedWatcherAttached) {
    speedWatcherAttached = true
    watch(sendDitMs, () => { adaptiveDitMs.value = 0 }) // recalibrate on speed change
  }
  function estDit(): number {
    return adaptiveDitMs.value || sendDitMs.value
  }
  /** A manual press at or above this duration is a dah (midpoint of 1u and 3u). */
  const dahThresholdMs = computed(() => Math.round((adaptiveDitMs.value || sendDitMs.value) * 2))

  function clearGapTimers() {
    if (letterTimer) clearTimeout(letterTimer)
    if (wordTimer) clearTimeout(wordTimer)
    letterTimer = null
    wordTimer = null
  }

  function finalizeLetter() {
    if (!currentSymbols.value) return
    const char = REVERSE_MORSE[currentSymbols.value] ?? '?'
    decoded.value += char
    currentSymbols.value = ''
  }

  function scheduleGapTimers() {
    clearGapTimers()
    const u = estDit()
    // Generous gaps: nominal is 3u between letters and 7u between words, but a
    // human fist pauses between elements too — wait ~4u (min 450 ms) before
    // committing a letter, ~8u (min 1.2 s) before inserting a space.
    letterTimer = setTimeout(finalizeLetter, Math.max(u * 4, 450))
    wordTimer = setTimeout(() => {
      if (decoded.value && !decoded.value.endsWith(' ')) decoded.value += ' '
    }, Math.max(u * 8, 1200))
  }

  function pushSymbol(symbol: '.' | '-') {
    currentSymbols.value += symbol
  }

  // ---- Manual keying ---------------------------------------------------------

  function manualDownHandler() {
    if (manualDown) return
    manualDown = true
    clearGapTimers() // never commit a letter while the key is down
    pressStart = performance.now()
    keyed.value = true
    // Live preview: a press starts as a dit and becomes a dah the moment the
    // hold crosses the threshold, so the operator can see the boundary.
    holdPreview.value = '.'
    holdTimer = setTimeout(() => {
      if (manualDown) holdPreview.value = '-'
    }, dahThresholdMs.value)
    audio.keyDown()
  }

  function manualUpHandler() {
    if (!manualDown) return
    manualDown = false
    audio.keyUp()
    keyed.value = false
    if (holdTimer) clearTimeout(holdTimer)
    holdPreview.value = ''
    const dur = performance.now() - pressStart
    if (dur < DEBOUNCE_MS) {
      // Contact bounce — ignore, but keep waiting on the pending symbols
      scheduleGapTimers()
      return
    }
    const est = estDit()
    const isDit = dur < est * 2
    pushSymbol(isDit ? '.' : '-')
    // Calibrate toward this press: a dit implies its own length, a dah implies
    // a third of it. Blend 30% per press, clamped to sane bounds.
    const implied = isDit ? dur : dur / 3
    adaptiveDitMs.value = Math.min(
      MAX_DIT_MS,
      Math.max(MIN_DIT_MS, est * 0.7 + implied * 0.3)
    )
    scheduleGapTimers()
  }

  // ---- Electronic keyer (iambic A/B) ----------------------------------------

  function setPaddle(role: 'dit' | 'dah', pressed: boolean) {
    if (role === 'dit') ditPaddle = pressed
    else dahPaddle = pressed
    if (pressed && !sending) iambicLoop()
  }

  /** Wait `ms`, sampling the paddles so mode B can arm its element memory. */
  async function sampledWait(ms: number, currentEl: '.' | '-', modeB: boolean, gen: number) {
    const t0 = performance.now()
    while (performance.now() - t0 < ms) {
      await sleep(5)
      if (gen !== generation) return
      if (modeB && ditPaddle && dahPaddle) {
        memoryEl = currentEl === '.' ? '-' : '.'
      }
    }
  }

  async function iambicLoop() {
    sending = true
    const gen = generation
    clearGapTimers()
    const modeB = keyType.value === 'iambic-b'
    while (gen === generation) {
      let el: '.' | '-' | null = null
      if (ditPaddle && dahPaddle) el = lastElement === '.' ? '-' : '.'
      else if (ditPaddle) el = '.'
      else if (dahPaddle) el = '-'
      else if (modeB && memoryEl) el = memoryEl
      if (!el) break
      memoryEl = null
      lastElement = el
      keyed.value = true
      audio.keyDown()
      await sampledWait(el === '.' ? sendDitMs.value : sendDitMs.value * 3, el, modeB, gen)
      audio.keyUp()
      keyed.value = false
      if (gen !== generation) return
      pushSymbol(el)
      await sampledWait(sendDitMs.value, el, modeB, gen)
    }
    sending = false
    memoryEl = null
    scheduleGapTimers()
  }

  // ---- Bug: automatic dit stream ---------------------------------------------

  async function bugLoop() {
    sending = true
    const gen = generation
    clearGapTimers()
    while (gen === generation && bugDit) {
      keyed.value = true
      audio.keyDown()
      await sleep(sendDitMs.value)
      audio.keyUp()
      keyed.value = false
      if (gen !== generation) return
      pushSymbol('.')
      await sleep(sendDitMs.value)
    }
    sending = false
    scheduleGapTimers()
  }

  // ---- Contact routing ---------------------------------------------------------
  // Everything physical lands here as a tip or ring closure; keyType decides
  // what it means (like the radio's keyer menu).

  function roleOf(contact: Contact): 'key' | 'dit' | 'dah' | null {
    if (keyType.value === 'straight') {
      // Tip only: a mono plug permanently shorts ring to sleeve, which would
      // otherwise read as a stuck contact. Sideswipers wire both arms to tip.
      return contact === 'tip' ? 'key' : null
    }
    const isDit = (contact === 'tip') !== progress.value.settings.paddleReverse
    return isDit ? 'dit' : 'dah'
  }

  function contactDown(contact: Contact) {
    const role = roleOf(contact)
    if (!role) return
    if (role === 'key') return manualDownHandler()
    if (keyType.value === 'bug') {
      if (role === 'dit') {
        bugDit = true
        if (!sending) bugLoop()
      } else {
        manualDownHandler() // bug dahs are manual
      }
      return
    }
    setPaddle(role, true)
  }

  function contactUp(contact: Contact) {
    const role = roleOf(contact)
    if (!role) return
    if (role === 'key') return manualUpHandler()
    if (keyType.value === 'bug') {
      if (role === 'dit') bugDit = false
      else manualUpHandler()
      return
    }
    setPaddle(role, false)
  }

  // ---- Keyboard input ----------------------------------------------------------
  // Straight: Space = the key. Other types: "[" / LeftCtrl = tip,
  // "]" / RightCtrl = ring. USB keyers emulating keyboards land here too.

  function keyFor(e: KeyboardEvent): Contact | null {
    if (keyType.value === 'straight') {
      return e.code === 'Space' ? 'tip' : null
    }
    if (e.code === 'BracketLeft' || e.code === 'ControlLeft') return 'tip'
    if (e.code === 'BracketRight' || e.code === 'ControlRight') return 'ring'
    return null
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.repeat) return
    if (e.code === 'Backspace') {
      e.preventDefault()
      clear()
      return
    }
    const contact = keyFor(e)
    if (!contact) return
    e.preventDefault()
    contactDown(contact)
  }

  function onKeyUp(e: KeyboardEvent) {
    const contact = keyFor(e)
    if (!contact) return
    e.preventDefault()
    contactUp(contact)
  }

  function attach() {
    if (!import.meta.client || keyboardAttached) return
    keyboardAttached = true
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
  }

  function detach() {
    if (!import.meta.client) return
    keyboardAttached = false
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    generation++
    clearGapTimers()
    if (holdTimer) clearTimeout(holdTimer)
    audio.keyUp()
    keyed.value = false
    holdPreview.value = ''
    ditPaddle = false
    dahPaddle = false
    memoryEl = null
    bugDit = false
    sending = false
    manualDown = false
    // Serial stays connected across pages — like a rig staying plugged in
  }

  // ---- Web Serial (USB bridge) --------------------------------------------------
  // The bridge (hardware/pico-bridge) is a dumb passthrough: it reports raw
  // TIP/RING contact closures as text lines and knows nothing about morse.

  function handleSerialLine(line: string) {
    switch (line) {
      case 'TIP_DOWN': contactDown('tip'); break
      case 'TIP_UP': contactUp('tip'); break
      case 'RING_DOWN': contactDown('ring'); break
      case 'RING_UP': contactUp('ring'); break
      // MORSEY_BRIDGE_READY and anything else: ignore
    }
  }

  async function serialReadLoop() {
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (serialPort?.readable) {
        serialReader = serialPort.readable.getReader()
        try {
          while (true) {
            const { value, done } = await serialReader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let nl
            while ((nl = buffer.indexOf('\n')) !== -1) {
              handleSerialLine(buffer.slice(0, nl).trim())
              buffer = buffer.slice(nl + 1)
            }
          }
        } finally {
          serialReader.releaseLock()
          serialReader = null
        }
      }
    } catch {
      // Port gone (unplugged) — a cancel() from disconnectSerial also lands here
    }
  }

  async function connectSerial(): Promise<string | null> {
    if (!serialSupported.value) {
      return 'Web Serial is not supported in this browser. Use Chrome or Edge, or a USB keyer that emulates a keyboard.'
    }
    try {
      serialPort = await (navigator as any).serial.requestPort()
      await serialPort.open({ baudRate: 115200 })
      serialConnected.value = true
      serialReadLoop()
      return null
    } catch (err: any) {
      serialPort = null
      return err?.message ?? 'Could not open serial port.'
    }
  }

  function disconnectSerial() {
    if (serialPort) {
      const port = serialPort
      serialPort = null // stop the read loop from re-acquiring a reader
      if (serialReader) {
        // cancel() releases the lock and unblocks read(); close after
        try { serialReader.cancel().catch(() => {}).finally(() => port.close().catch(() => {})) }
        catch { /* reader already gone */ }
      } else {
        try { port.close() } catch { /* already closed */ }
      }
    }
    serialConnected.value = false
  }

  function clear() {
    decoded.value = ''
    currentSymbols.value = ''
    clearGapTimers()
  }

  return {
    decoded,
    currentSymbols,
    keyed,
    holdPreview,
    dahThresholdMs,
    adaptiveDitMs,
    serialConnected,
    serialSupported,
    keyType,
    attach,
    detach,
    contactDown,
    contactUp,
    connectSerial,
    disconnectSerial,
    clear
  }
}
