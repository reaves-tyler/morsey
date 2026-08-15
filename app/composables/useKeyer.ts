import { REVERSE_MORSE } from '~/utils/morse'

/**
 * Sending-side keyer: turns physical inputs (keyboard, mouse/touch, or a USB
 * key via the Web Serial API) into dits and dahs, then decodes them into text.
 *
 * Two modes:
 *  - straight: one input, timing measured from how long you hold it
 *  - paddle: two inputs; the electronic keyer generates perfectly timed
 *    elements, squeezing both alternates dit/dah (iambic)
 *
 * Timing is based on the dedicated *sending* speed (settings.sendWpm), not the
 * receive/character speed — humans key far slower than they can copy. On top
 * of that, straight-key classification is adaptive: every press nudges the
 * dit-length estimate toward the operator's actual fist, and the letter/word
 * commit gaps are stretched (with generous floors) so the decoder waits for
 * you to finish a character instead of committing between elements.
 *
 * Hardware notes: most cheap USB CW interfaces enumerate as a keyboard or
 * mouse, which the keyboard/mouse bindings already capture. Serial-wired
 * paddles assert the CTS (dit) and DSR (dah) control lines, which we poll
 * through navigator.serial.
 */

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Presses shorter than this are treated as contact bounce and discarded. */
const DEBOUNCE_MS = 20
/** Adaptive dit estimate is clamped to this range (ms). */
const MIN_DIT_MS = 40
const MAX_DIT_MS = 300

export function useKeyer() {
  const { progress } = useProgress()
  const audio = useMorseAudio()

  const decoded = ref('')
  const currentSymbols = ref('')
  const keyed = ref(false) // tone currently on (for UI)
  /** Live classification of the element being held right now ('.' or '-'). */
  const holdPreview = ref<'' | '.' | '-'>('')
  const serialConnected = ref(false)
  const serialSupported = computed(() =>
    import.meta.client && 'serial' in navigator
  )

  /** Nominal dit length at the configured sending speed. */
  const sendDitMs = computed(() => (1.2 / progress.value.settings.sendWpm) * 1000)

  /** Adaptive dit length, calibrated to the operator's actual keying. */
  const adaptiveDitMs = ref(0)
  watch(sendDitMs, () => { adaptiveDitMs.value = 0 }) // recalibrate on speed change
  function estDit(): number {
    return adaptiveDitMs.value || sendDitMs.value
  }
  /** A press at or above this duration is a dah (midpoint of 1u and 3u). */
  const dahThresholdMs = computed(() => Math.round((adaptiveDitMs.value || sendDitMs.value) * 2))

  let letterTimer: ReturnType<typeof setTimeout> | null = null
  let wordTimer: ReturnType<typeof setTimeout> | null = null

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

  // ---- Straight key --------------------------------------------------------

  let pressStart = 0
  let straightDown = false
  let holdTimer: ReturnType<typeof setTimeout> | null = null

  function straightDownHandler() {
    if (straightDown) return
    straightDown = true
    clearGapTimers() // never commit a letter while the key is down
    pressStart = performance.now()
    keyed.value = true
    // Live preview: a press starts as a dit and becomes a dah the moment the
    // hold crosses the threshold, so the operator can see the boundary.
    holdPreview.value = '.'
    holdTimer = setTimeout(() => {
      if (straightDown) holdPreview.value = '-'
    }, dahThresholdMs.value)
    audio.keyDown()
  }

  function straightUpHandler() {
    if (!straightDown) return
    straightDown = false
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

  // ---- Iambic paddle -------------------------------------------------------

  let ditPaddle = false
  let dahPaddle = false
  let sending = false
  let lastElement: '.' | '-' = '-'
  let generation = 0 // bumped on detach to kill in-flight loops

  function setPaddle(side: 'dit' | 'dah', pressed: boolean) {
    if (side === 'dit') ditPaddle = pressed
    else dahPaddle = pressed
    if (pressed && !sending) keyerLoop()
  }

  async function keyerLoop() {
    sending = true
    const gen = generation
    clearGapTimers()
    while (gen === generation) {
      let el: '.' | '-' | null = null
      if (ditPaddle && dahPaddle) el = lastElement === '.' ? '-' : '.'
      else if (ditPaddle) el = '.'
      else if (dahPaddle) el = '-'
      if (!el) break
      lastElement = el
      keyed.value = true
      audio.keyDown()
      await sleep(el === '.' ? sendDitMs.value : sendDitMs.value * 3)
      audio.keyUp()
      keyed.value = false
      if (gen !== generation) return
      pushSymbol(el)
      await sleep(sendDitMs.value)
    }
    sending = false
    scheduleGapTimers()
  }

  // ---- Input routing -------------------------------------------------------

  const mode = computed(() => progress.value.settings.keyerMode)

  function inputDown(input: 'primary' | 'secondary') {
    if (mode.value === 'straight') straightDownHandler()
    else setPaddle(input === 'primary' ? 'dit' : 'dah', true)
  }

  function inputUp(input: 'primary' | 'secondary') {
    if (mode.value === 'straight') straightUpHandler()
    else setPaddle(input === 'primary' ? 'dit' : 'dah', false)
  }

  // Keyboard bindings: straight = Space; paddle = "[" or LeftCtrl for dit,
  // "]" or RightCtrl for dah. USB keyers that emulate keyboards/mice land here.
  function keyFor(e: KeyboardEvent): 'primary' | 'secondary' | null {
    if (mode.value === 'straight') {
      return e.code === 'Space' ? 'primary' : null
    }
    if (e.code === 'BracketLeft' || e.code === 'ControlLeft') return 'primary'
    if (e.code === 'BracketRight' || e.code === 'ControlRight') return 'secondary'
    return null
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.repeat) return
    if (e.code === 'Backspace') {
      e.preventDefault()
      clear()
      return
    }
    const input = keyFor(e)
    if (!input) return
    e.preventDefault()
    inputDown(input)
  }

  function onKeyUp(e: KeyboardEvent) {
    const input = keyFor(e)
    if (!input) return
    e.preventDefault()
    inputUp(input)
  }

  function attach() {
    if (!import.meta.client) return
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
  }

  function detach() {
    if (!import.meta.client) return
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
    sending = false
    straightDown = false
    disconnectSerial()
  }

  // ---- Web Serial ----------------------------------------------------------

  let serialPort: any = null
  let serialPoll: ReturnType<typeof setInterval> | null = null
  let lastCts = false
  let lastDsr = false

  async function connectSerial(): Promise<string | null> {
    if (!serialSupported.value) {
      return 'Web Serial is not supported in this browser. Use Chrome or Edge, or a USB keyer that emulates a keyboard.'
    }
    try {
      serialPort = await (navigator as any).serial.requestPort()
      await serialPort.open({ baudRate: 9600 })
      // Raise DTR/RTS so a passive paddle circuit has voltage to switch
      await serialPort.setSignals({ dataTerminalReady: true, requestToSend: true })
      serialConnected.value = true
      serialPoll = setInterval(async () => {
        if (!serialPort) return
        try {
          const s = await serialPort.getSignals()
          const cts = !!s.clearToSend
          const dsr = !!(s.dataSetReady || s.dataCarrierDetect)
          if (cts !== lastCts) {
            lastCts = cts
            cts ? inputDown('primary') : inputUp('primary')
          }
          if (dsr !== lastDsr) {
            lastDsr = dsr
            dsr ? inputDown('secondary') : inputUp('secondary')
          }
        } catch {
          disconnectSerial()
        }
      }, 5)
      return null
    } catch (err: any) {
      serialPort = null
      return err?.message ?? 'Could not open serial port.'
    }
  }

  function disconnectSerial() {
    if (serialPoll) {
      clearInterval(serialPoll)
      serialPoll = null
    }
    if (serialPort) {
      try { serialPort.close() } catch { /* already closed */ }
      serialPort = null
    }
    serialConnected.value = false
    lastCts = false
    lastDsr = false
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
    attach,
    detach,
    inputDown,
    inputUp,
    connectSerial,
    disconnectSerial,
    clear
  }
}
