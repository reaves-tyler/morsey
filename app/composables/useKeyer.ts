import { KeyerEngine, type Contact } from '~/utils/keyerEngine'
import type { KeyType } from '~/composables/useProgress'

/**
 * Thin adapter between the pure keyer engine (app/utils/keyerEngine.ts —
 * all timing/decode state machines, unit-tested) and the app: it wires the
 * engine's events to Vue refs and the Web Audio sidetone, and feeds it
 * contact closures from the keyboard, the on-screen keys, and the USB
 * bridge (hardware/pico-bridge) over Web Serial.
 *
 * Everything here is module-level: the keyer bar and the send page share one
 * engine and one serial connection, which survives page navigation like a
 * rig staying plugged in.
 */

// ---- Shared reactive state ---------------------------------------------------

const decoded = ref('')
const currentSymbols = ref('')
const keyed = ref(false) // tone currently on (for UI)
const holdPreview = ref<'' | '.' | '-'>('')
const serialConnected = ref(false)
const adaptiveDitMs = ref(0)

let engine: KeyerEngine | null = null
let keyboardAttached = false
let watchersAttached = false

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
  const dahThresholdMs = computed(() =>
    Math.round((adaptiveDitMs.value || (1.2 / progress.value.settings.sendWpm) * 1000) * 2)
  )

  function getEngine(): KeyerEngine {
    if (!engine) {
      engine = new KeyerEngine({
        now: () => performance.now(),
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: h => clearTimeout(h as ReturnType<typeof setTimeout>),
        config: () => ({
          keyType: progress.value.settings.keyType,
          paddleReverse: progress.value.settings.paddleReverse,
          sendWpm: progress.value.settings.sendWpm
        }),
        onToneStart: () => { keyed.value = true; audio.keyDown() },
        onToneEnd: () => { keyed.value = false; audio.keyUp() },
        onSymbols: s => { currentSymbols.value = s },
        onLetter: (char) => { decoded.value += char },
        onWordGap: () => {
          if (decoded.value && !decoded.value.endsWith(' ')) decoded.value += ' '
        },
        onHoldPreview: p => { holdPreview.value = p },
        onAdaptiveDit: ms => { adaptiveDitMs.value = ms }
      })
    }
    return engine
  }

  if (import.meta.client && !watchersAttached) {
    watchersAttached = true
    // Speed changes invalidate the fist calibration; key-type changes hard-stop
    // whatever the previous machine was doing (element in flight, held tone).
    watch(() => progress.value.settings.sendWpm, () => getEngine().resetCalibration())
    watch(keyType, () => getEngine().reset())
  }

  function contactDown(contact: Contact) {
    getEngine().contactDown(contact)
  }
  function contactUp(contact: Contact) {
    getEngine().contactUp(contact)
  }

  function clear() {
    getEngine().clear()
    decoded.value = ''
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
    getEngine().reset()
    // Serial stays connected across pages — like a rig staying plugged in
  }

  // ---- Web Serial (USB bridge) --------------------------------------------------
  // The bridge is a dumb passthrough: it reports raw TIP/RING contact
  // closures as text lines and knows nothing about morse.

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
