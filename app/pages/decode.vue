<script setup lang="ts">
// full-width shell: the stream on the left half and its controls on the right want the whole screen
definePageMeta({ wide: true })

useSeoMeta({
  title: 'Live CW Decoder for Your Transceiver Audio',
  description: 'Decode Morse code from your radio in real time, in the browser. Feed the rig into a laptop\'s aux jack, a USB sound card or a microphone, hear it in your headphones, tune the passband on a live spectrum display, and read a text terminal with automatic speed tracking, adaptive noise threshold and prosign detection.',
  ogTitle: 'Live CW Decoder · Morsey',
  ogDescription: 'Browser-based Morse decoder for rig audio: spectrum tuning, adaptive threshold, speed tracking.'
})

import { DEFAULT_DEVICE, isLive, type DecoderSource } from '~/composables/useCwStreamDecoder'

/**
 * Stream decoding — a live CW terminal fed by the rig's audio.
 *
 * Layout follows a receiver's front panel: signal display (spectrum with the
 * passband drawn over it, click to tune), a level meter with the decoder's
 * floor / threshold / peak marks, status readouts, then the terminal, then
 * the controls. Everything the decoder adapts is visible, so when it misses
 * the operator can see *why* (pitch off, threshold in the noise, speed
 * estimate wrong) and reach for the matching knob.
 */

const dec = useCwStreamDecoder()
const s = dec.settings
const { progress } = useProgress()

// ---- Source & lifecycle --------------------------------------------------------

const SOURCES: { id: DecoderSource; label: string; icon: string; hint: string }[] = [
  { id: 'line', label: 'Aux / line in', icon: 'i-lucide-cable', hint: 'Cable from the rig to the jack or a USB sound card' },
  { id: 'mic', label: 'Microphone', icon: 'i-lucide-mic', hint: 'Mic held to the rig\'s speaker' },
  { id: 'file', label: 'Audio file', icon: 'i-lucide-file-audio', hint: 'WAV / MP3 recording' }
]

const busy = ref(false)
async function toggle() {
  if (dec.listening.value) {
    dec.stop()
    return
  }
  busy.value = true
  await dec.start()
  busy.value = false
}

// ---- Recorder ---------------------------------------------------------------------
// Rec → Pause → (Resume | Export | Discard). Independent of Start/Stop and of
// the terminal: exporting never clears what has been decoded.

const recordNote = ref('')
const rec = dec.recordingState
function recordOrResume() {
  if (dec.startRecording()) recordNote.value = ''
}
function exportRecording() {
  const take = dec.exportRecording()
  if (!take) {
    recordNote.value = 'Nothing captured.'
    return
  }
  const url = URL.createObjectURL(take.blob)
  const a = document.createElement('a')
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
  a.href = url
  a.download = `morsey-rx-${stamp}.wav`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  recordNote.value = `Saved ${a.download} · ${take.seconds.toFixed(0)} s at ${(take.sampleRate / 1000).toFixed(1)} kHz`
}
function discardRecording() {
  dec.discardRecording()
  recordNote.value = 'Take discarded.'
}
const recordLabel = computed(() => {
  const sec = dec.recordedSeconds.value
  const mb = dec.recordedBytes.value / 1048576
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')} · ${mb.toFixed(1)} MB`
})

const fileInput = ref<HTMLInputElement>()
async function onFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  if (dec.listening.value) dec.stop()
  const err = await dec.loadFile(file)
  input.value = '' // so choosing the same file again re-triggers change
  if (!err) toggle()
}

// ---- Devices & monitor ---------------------------------------------------------------

// (a select item may not carry an empty-string value, hence the sentinel)
const inputItems = computed(() => {
  const auto = dec.source.value === 'line'
    ? (dec.suggestedLineDevice.value ? `Auto — ${dec.suggestedLineDevice.value.label}` : 'Auto — system default input')
    : 'System default input'
  return [
    { label: auto, value: DEFAULT_DEVICE },
    ...dec.devices.value.map(d => ({ label: d.label, value: d.deviceId }))
  ]
})
const outputItems = computed(() => [
  { label: 'System default output', value: DEFAULT_DEVICE },
  ...dec.outputs.value.map(d => ({ label: d.label, value: d.deviceId }))
])
/** the device setting that belongs to the selected live source */
const inputDevice = computed({
  get: () => (dec.source.value === 'mic' ? s.value.micDeviceId : s.value.lineDeviceId),
  set: (v: string) => {
    if (dec.source.value === 'mic') s.value.micDeviceId = v
    else s.value.lineDeviceId = v
  }
})
/** the monitor switch that belongs to the selected source */
const monitorOn = computed({
  get: () => (dec.source.value === 'mic' ? s.value.monitorMic : s.value.monitor),
  set: (v: boolean) => {
    if (dec.source.value === 'mic') s.value.monitorMic = v
    else s.value.monitor = v
  }
})
const monitorDb = computed(() => {
  const g = s.value.monitorLevel
  return g <= 0 ? '−∞' : `${g >= 1 ? '+' : ''}${(20 * Math.log10(g)).toFixed(0)}`
})
/** what the leveller is doing right now, signed dB */
const agcDb = computed(() => {
  const d = Math.round(dec.monitorGainDb.value)
  return `${d > 0 ? '+' : ''}${d}`
})

const detecting = ref(false)
/** ask once for capture permission so the device list shows real names */
async function detectDevices() {
  detecting.value = true
  await dec.requestDevicePermission()
  detecting.value = false
}

function selectSource(id: DecoderSource) {
  if (dec.listening.value) dec.stop()
  dec.source.value = id
  // picking a live source is the moment the operator needs device names
  if (isLive(id) && !dec.devicesLabelled.value) detectDevices()
}

onMounted(() => { dec.refreshDevices() })

// ---- Spectrum display -----------------------------------------------------------

const spectrumCanvas = ref<HTMLCanvasElement>()
const F_LO = 200
const F_HI = 1600
let spectrumRaf = 0
let spectrumBuf: Float32Array | null = null
let peakHold: Float32Array | null = null

function xForHz(hz: number, width: number) {
  return ((hz - F_LO) / (F_HI - F_LO)) * width
}

function drawSpectrum() {
  const canvas = spectrumCanvas.value
  if (!canvas) return
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
  }
  const g = canvas.getContext('2d')
  if (!g) return
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, w, h)

  // passband
  const centre = s.value.centerHz
  const bw = s.value.bandwidthHz
  const x0 = xForHz(centre - bw / 2, w)
  const x1 = xForHz(centre + bw / 2, w)
  g.fillStyle = 'rgba(16, 185, 129, 0.12)'
  g.fillRect(x0, 0, Math.max(2, x1 - x0), h)

  // grid every 200 Hz
  g.strokeStyle = 'rgba(63, 63, 70, 0.6)'
  g.lineWidth = 1
  g.font = '10px ui-monospace, monospace'
  g.fillStyle = 'rgb(113, 113, 122)'
  for (let f = F_LO; f <= F_HI; f += 200) {
    const x = Math.round(xForHz(f, w)) + 0.5
    g.beginPath()
    g.moveTo(x, 0)
    g.lineTo(x, h)
    g.stroke()
    if (f > F_LO && f < F_HI) g.fillText(`${f}`, x + 3, h - 4)
  }

  const bins = dec.spectrumBins()
  if (!spectrumBuf || spectrumBuf.length !== bins) {
    spectrumBuf = new Float32Array(bins)
    peakHold = new Float32Array(bins).fill(-160)
  }
  const info = dec.spectrum(spectrumBuf)
  if (info) {
    const dbLo = -100
    const dbHi = -20
    const yFor = (db: number) => h - ((Math.min(dbHi, Math.max(dbLo, db)) - dbLo) / (dbHi - dbLo)) * (h - 14)
    const i0 = Math.max(1, Math.floor(F_LO / info.binHz))
    const i1 = Math.min(bins - 1, Math.ceil(F_HI / info.binHz))
    // live trace
    g.beginPath()
    g.moveTo(xForHz(i0 * info.binHz, w), h)
    for (let i = i0; i <= i1; i++) {
      g.lineTo(xForHz(i * info.binHz, w), yFor(spectrumBuf[i]!))
      peakHold![i] = Math.max(spectrumBuf[i]!, peakHold![i]! - 0.4)
    }
    g.lineTo(xForHz(i1 * info.binHz, w), h)
    g.closePath()
    const grad = g.createLinearGradient(0, 0, 0, h)
    grad.addColorStop(0, 'rgba(52, 211, 153, 0.9)')
    grad.addColorStop(1, 'rgba(52, 211, 153, 0.15)')
    g.fillStyle = grad
    g.fill()
    // peak hold
    g.beginPath()
    for (let i = i0; i <= i1; i++) {
      const x = xForHz(i * info.binHz, w)
      const y = yFor(peakHold![i]!)
      if (i === i0) g.moveTo(x, y)
      else g.lineTo(x, y)
    }
    g.strokeStyle = 'rgba(251, 191, 36, 0.7)'
    g.stroke()
  } else if (peakHold) {
    peakHold.fill(-160)
  }

  // centre line
  const xc = Math.round(xForHz(centre, w)) + 0.5
  g.strokeStyle = 'rgba(52, 211, 153, 0.9)'
  g.setLineDash([3, 3])
  g.beginPath()
  g.moveTo(xc, 0)
  g.lineTo(xc, h)
  g.stroke()
  g.setLineDash([])
  g.fillStyle = 'rgb(110, 231, 183)'
  g.fillText(`${centre} Hz`, Math.min(w - 52, xc + 4), 11)

  spectrumRaf = requestAnimationFrame(drawSpectrum)
}

function tuneFromEvent(e: PointerEvent) {
  const canvas = spectrumCanvas.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const frac = (e.clientX - rect.left) / rect.width
  const hz = Math.round((F_LO + frac * (F_HI - F_LO)) / 10) * 10
  s.value.centerHz = Math.min(1000, Math.max(400, hz))
}
let dragging = false
function onSpectrumDown(e: PointerEvent) {
  dragging = true
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  tuneFromEvent(e)
}
function onSpectrumMove(e: PointerEvent) { if (dragging) tuneFromEvent(e) }
function onSpectrumUp() { dragging = false }

/** Snap the centre to the strongest tone in the CW range — one-click tuning */
function tuneToPeak() {
  if (!spectrumBuf) return
  const info = dec.spectrum(spectrumBuf)
  if (!info) return
  let best = -1
  let bestDb = -Infinity
  const i0 = Math.ceil(350 / info.binHz)
  const i1 = Math.floor(1050 / info.binHz)
  for (let i = i0; i <= i1; i++) {
    if (spectrumBuf[i]! > bestDb) { bestDb = spectrumBuf[i]!; best = i }
  }
  if (best > 0) {
    // parabolic interpolation between neighbouring bins for sub-bin accuracy
    const a = spectrumBuf[best - 1]!
    const b = spectrumBuf[best]!
    const c = spectrumBuf[best + 1]!
    const denom = a - 2 * b + c
    const offset = denom !== 0 ? (0.5 * (a - c)) / denom : 0
    s.value.centerHz = Math.min(1000, Math.max(400, Math.round(((best + offset) * info.binHz) / 5) * 5))
  }
}

onMounted(() => {
  drawSpectrum()
})
onBeforeUnmount(() => {
  cancelAnimationFrame(spectrumRaf)
})

// ---- Meter & readouts ------------------------------------------------------------

const DB_LO = -60
function pct(level: number) {
  const db = 20 * Math.log10(Math.max(level, 1e-6))
  return Math.min(100, Math.max(0, ((db - DB_LO) / -DB_LO) * 100))
}
const m = dec.meter
const wpmText = computed(() => (dec.listening.value || dec.text.value ? Math.round(m.value.wpm).toString() : '—'))
const snrText = computed(() => (m.value.floor > 0 ? `${Math.round(m.value.snrDb)} dB` : '—'))
const ratio = computed(() => (m.value.dahMs / m.value.ditMs).toFixed(1))
const report = dec.report
/** S-meter scale: S1–S9 then +10/+20/+30 dB — 12 segments */
const S_SEGMENTS = [...Array.from({ length: 9 }, (_, i) => `S${i + 1}`), '+10', '+20', '+30']
const litSegments = computed(() => {
  const r = report.value
  if (r.sUnits <= 0) return 0
  const base = Math.min(9, Math.round(r.sUnits))
  return base + Math.min(3, Math.floor(r.plusDb / 10))
})
const strengthText = computed(() => {
  const r = report.value
  if (r.s === 0) return '—'
  return r.plusDb > 0 ? `S9 +${r.plusDb} dB` : `S${r.s}`
})
const prefilterQ = computed(() => Math.min(50, Math.max(5, s.value.centerHz / Math.max(20, s.value.bandwidthHz * 2))).toFixed(0))


// ---- Terminal ----------------------------------------------------------------------

const terminal = ref<HTMLElement>()
watch(() => dec.text.value + dec.pattern.value, async () => {
  await nextTick()
  if (terminal.value) terminal.value.scrollTop = terminal.value.scrollHeight
})

const copied = ref(false)
async function copyText() {
  try {
    await navigator.clipboard.writeText(dec.text.value)
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
  } catch { /* clipboard unavailable */ }
}

/** the highlight legend under the terminal (colours match CwHighlightedText) */
const LEGEND = [
  { label: 'Callsign', cls: 'text-amber-300' },
  { label: 'Abbreviation', cls: 'text-emerald-400' },
  { label: 'Q-signal', cls: 'text-cyan-300' },
  { label: 'RST', cls: 'text-sky-300' },
  { label: 'Prosign', cls: 'text-violet-300' }
]

// ---- Advanced ------------------------------------------------------------------------

const showAdvanced = ref(false)
function reseedSpeed() {
  dec.resetTiming()
}
function matchRigPitch() {
  s.value.centerHz = progress.value.settings.freq
}

</script>

<template>
  <div class="space-y-6">
    <section class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">Stream decoding</h1>
        <p class="mt-1 max-w-4xl text-sm text-zinc-400">
          Live over-the-air CW terminal. Cable the rig into your laptop's aux jack or a USB sound card, or hold a microphone to its speaker — the audio is passed through to your headphones while it decodes. The text is a running log: it survives Stop and reloads, breaks the line after five seconds of silence, and only Clear empties it. Callsigns, Q-signals, RST reports, prosigns and common shorthand are coloured as they arrive; hover one for its meaning.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <span
          class="rounded-sm border px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider"
          :class="dec.listening.value
            ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300'
            : 'border-zinc-800 bg-zinc-900 text-zinc-500'"
        >
          {{ dec.listening.value ? 'Listening' : 'Idle' }}
        </span>
        <span
          class="rounded-sm border px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider transition"
          :class="m.keyed
            ? 'border-rose-500/60 bg-rose-500/15 text-rose-300 shadow-[0_0_10px_-2px_theme(colors.rose.500/60%)]'
            : 'border-zinc-800 bg-zinc-900 text-zinc-600'"
        >
          Key
        </span>
      </div>
    </section>

    <!-- Two halves on wide screens: the stream on the left, everything that configures it on the right -->
    <div class="grid items-start gap-6 lg:grid-cols-2">
      <div class="space-y-6">
        <!-- Signal display -->
        <UCard>
          <!-- readouts sit beside the spectrum only where the half-width column is wide enough -->
          <div class="grid gap-4 2xl:grid-cols-[1fr_auto]">
            <div class="space-y-3">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="font-mono text-[10px] uppercase tracking-widest text-zinc-500">
                  Spectrum · click or drag to tune
                </div>
                <div class="flex gap-1.5">
                  <UButton size="xs" variant="soft" color="neutral" icon="i-lucide-crosshair" class="whitespace-nowrap" :disabled="!dec.listening.value" @click="tuneToPeak">
                    Tune to peak
                  </UButton>
                  <UButton size="xs" variant="soft" color="neutral" icon="i-lucide-music-2" class="whitespace-nowrap" @click="matchRigPitch">
                    Rig pitch {{ progress.settings.freq }} Hz
                  </UButton>
                </div>
              </div>
              <canvas
                ref="spectrumCanvas"
                class="h-36 w-full cursor-crosshair touch-none rounded-md border border-zinc-800 bg-zinc-950"
                role="img"
                :aria-label="`Audio spectrum 200 to 1600 Hz, passband centred at ${s.centerHz} Hz, ${s.bandwidthHz} Hz wide`"
                @pointerdown="onSpectrumDown"
                @pointermove="onSpectrumMove"
                @pointerup="onSpectrumUp"
                @pointercancel="onSpectrumUp"
              />

              <!-- Level meter with the decoder's marks -->
              <div>
                <div class="mb-1 flex items-center justify-between font-mono text-[10px] uppercase tracking-widest text-zinc-500">
                  <span class="flex items-center gap-2">
                    Tone level in passband
                    <UButton
                      size="xs"
                      variant="soft"
                      color="neutral"
                      icon="i-lucide-rotate-ccw"
                      :disabled="!dec.listening.value"
                      class="whitespace-nowrap normal-case tracking-normal"
                      title="Throw away the measured levels and learn them again from the next few seconds — press after changing the rig's volume or the interface gain. Text and speed tracking are kept."
                      @click="dec.resetLevels()"
                    >
                      Reset levels
                    </UButton>
                    <span
                      v-if="dec.listening.value"
                      class="rounded px-1.5 py-0.5 normal-case tracking-normal"
                      :class="m.signalPresent ? 'bg-emerald-500/15 text-emerald-400' : 'bg-zinc-800 text-zinc-500'"
                      :title="m.signalPresent
                        ? 'A keyed signal is on the frequency: copy is being printed.'
                        : 'Squelched — the levels in the passband are band noise, not a transmission. Anything the gate catches is held back rather than printed as E and T.'"
                    >{{ m.signalPresent ? 'Signal' : 'Squelched' }}</span>
                  </span>
                  <span class="flex gap-3 normal-case tracking-normal">
                    <span class="text-zinc-500">▮ floor</span>
                    <span class="text-amber-400">▮ threshold</span>
                    <span class="text-emerald-400">▮ peak</span>
                  </span>
                </div>
                <div class="relative h-5 overflow-hidden rounded border border-zinc-800 bg-zinc-950">
                  <div
                    class="absolute inset-y-0 left-0 transition-[width] duration-75"
                    :class="m.keyed ? 'bg-emerald-500/70' : 'bg-zinc-600/60'"
                    :style="{ width: pct(m.magnitude) + '%' }"
                  />
                  <div class="absolute inset-y-0 w-0.5 bg-zinc-400" :style="{ left: pct(m.floor) + '%' }" />
                  <div class="absolute inset-y-0 w-0.5 bg-amber-400" :style="{ left: pct(m.threshold) + '%' }" />
                  <div class="absolute inset-y-0 w-0.5 bg-emerald-400" :style="{ left: pct(m.peak) + '%' }" />
                  <div class="pointer-events-none absolute inset-0 flex items-center justify-between px-2 font-mono text-[9px] text-zinc-600">
                    <span>-60 dB</span><span>-40</span><span>-20</span><span>0</span>
                  </div>
                </div>
              </div>
            </div>

            <!-- Readouts -->
            <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 2xl:w-56 2xl:grid-cols-1">
              <div class="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
                <div class="font-mono text-[10px] uppercase tracking-widest text-zinc-500">Speed</div>
                <div class="text-2xl font-semibold text-emerald-400">
                  {{ wpmText }} <span class="text-xs font-normal text-zinc-500">WPM</span>
                </div>
                <div class="font-mono text-[11px] text-zinc-500">
                  dit {{ Math.round(m.ditMs) }} ms · dah {{ Math.round(m.dahMs) }} ms · {{ ratio }}:1
                  <span v-if="!m.calibrated && dec.listening.value" class="text-amber-400"> · seeding</span>
                </div>
              </div>
              <div class="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2" title="Readability from decode quality (unknown patterns, timing confidence) and S/N · Strength from signal-over-noise (6 dB per S-unit, noise ≈ S3) · Tone assumed 9">
                <div class="flex items-center justify-between font-mono text-[10px] uppercase tracking-widest text-zinc-500">
                  <span>Signal report</span>
                  <span>{{ snrText }} S/N</span>
                </div>
                <div class="flex items-baseline gap-2">
                  <span class="text-2xl font-semibold" :class="report.r >= 4 ? 'text-emerald-400' : report.r >= 3 ? 'text-amber-400' : 'text-zinc-400'">
                    RST {{ report.rst }}
                  </span>
                  <span class="font-mono text-xs text-zinc-400">{{ strengthText }}</span>
                </div>
                <!-- S-meter -->
                <div class="mt-1.5 flex gap-0.5">
                  <span
                    v-for="(seg, i) in S_SEGMENTS"
                    :key="seg"
                    class="h-2.5 flex-1 rounded-sm transition-colors duration-100"
                    :class="i < litSegments
                      ? (i < 9 ? 'bg-emerald-400 shadow-[0_0_6px_theme(colors.emerald.400/60%)]' : 'bg-rose-400 shadow-[0_0_6px_theme(colors.rose.400/60%)]')
                      : 'bg-zinc-800'"
                  />
                </div>
                <div class="mt-0.5 flex justify-between font-mono text-[9px] text-zinc-600">
                  <span>S1</span><span>S3</span><span>S5</span><span>S7</span><span>S9</span><span>+10</span><span>+20</span><span>+30</span>
                </div>
                <div class="mt-1 font-mono text-[11px] text-zinc-500">
                  copy {{ Math.round(report.copyQuality * 100) }}% · timing {{ Math.round(report.confidence * 100) }}% · gaps {{ Math.round(m.letterGapMs) }}/{{ Math.round(m.wordGapMs) }} ms
                </div>
              </div>
              <!-- element ribbon: the last few dits/dahs as bars -->
              <div class="col-span-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 lg:col-span-1">
                <div class="font-mono text-[10px] uppercase tracking-widest text-zinc-500">Elements</div>
                <div class="mt-1.5 flex h-4 items-center gap-0.5 overflow-hidden">
                  <span
                    v-for="(e, i) in dec.elements.value.slice(-24)"
                    :key="i"
                    class="h-2.5 shrink-0 rounded-sm bg-emerald-400/80"
                    :style="{ width: e.el === '-' ? '14px' : '5px' }"
                    :title="`${e.el} ${Math.round(e.ms)} ms`"
                  />
                  <span v-if="dec.elements.value.length === 0" class="font-mono text-[11px] text-zinc-600">—</span>
                </div>
              </div>
            </div>
          </div>
        </UCard>

        <!-- Terminal -->
        <UCard>
          <div class="mb-2 flex items-center justify-between">
            <div class="font-mono text-[10px] uppercase tracking-widest text-zinc-500">Decoded text</div>
            <div class="flex gap-1.5">
              <UButton size="xs" variant="soft" color="neutral" :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'" :disabled="!dec.text.value" @click="copyText">
                {{ copied ? 'Copied' : 'Copy' }}
              </UButton>
              <UButton size="xs" variant="soft" color="neutral" icon="i-lucide-eraser" :disabled="!dec.text.value && !dec.pattern.value" @click="dec.clear()">
                Clear
              </UButton>
            </div>
          </div>
          <div
            ref="terminal"
            class="h-56 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950 p-4 font-mono text-lg leading-relaxed text-emerald-200 whitespace-pre-wrap break-words lg:h-[26rem]"
            aria-live="polite"
          >
            <template v-if="dec.text.value || dec.pattern.value">
              <CwHighlightedText :text="dec.text.value" />
              <span v-if="dec.pattern.value" class="ml-1 text-sm text-amber-300/80" title="Character in progress">{{ dec.pattern.value }}</span>
              <span
                class="ml-0.5 inline-block h-5 w-2 translate-y-1 bg-emerald-400/80"
                :class="dec.listening.value ? 'animate-pulse' : 'opacity-30'"
              />
            </template>
            <!-- empty log: the placeholder takes the first line; the cursor appears with the first character -->
            <span v-else class="text-sm text-zinc-600">
              {{ dec.listening.value ? 'Listening — nothing decoded yet.' : 'Nothing decoded yet. Pick an input below and press Start listening.' }}
            </span>
          </div>
          <div v-if="dec.playbackProgress.value > 0 && dec.listening.value" class="mt-2">
            <UProgress :model-value="dec.playbackProgress.value * 100" :max="100" size="xs" />
          </div>
          <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
            <span v-for="l in LEGEND" :key="l.label" class="flex items-center gap-1">
              <span class="text-sm leading-none" :class="l.cls">■</span>{{ l.label }}
            </span>
            <span class="text-zinc-600">· hover a word for its meaning</span>
          </div>
        </UCard>

      </div>

      <!-- Controls -->
      <div class="space-y-6">
        <UCard>
          <div class="mb-3 font-mono text-[10px] uppercase tracking-widest text-zinc-500">Source</div>
          <div class="grid grid-cols-3 gap-1.5">
            <button
              v-for="src in SOURCES"
              :key="src.id"
              class="flex flex-col items-center gap-1 rounded border px-2 py-2.5 text-center transition"
              :class="dec.source.value === src.id
                ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300 shadow-[0_0_10px_-2px_theme(colors.emerald.500/60%)]'
                : 'border-zinc-700 bg-zinc-800/60 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'"
              @click="selectSource(src.id)"
            >
              <UIcon :name="src.icon" class="size-5" />
              <span class="font-mono text-xs uppercase tracking-wider">{{ src.label }}</span>
              <span class="text-[10px] leading-tight text-zinc-500">{{ src.hint }}</span>
            </button>
          </div>

          <!-- per-source options -->
          <div v-if="isLive(dec.source.value)" class="mt-4 space-y-3">
            <div class="flex items-center gap-2">
              <USelect
                v-model="inputDevice"
                :items="inputItems"
                value-key="value"
                size="sm"
                class="flex-1"
                icon="i-lucide-audio-lines"
              />
              <UButton
                size="sm"
                variant="soft"
                color="neutral"
                :icon="dec.devicesLabelled.value ? 'i-lucide-refresh-cw' : 'i-lucide-scan-search'"
                :loading="detecting"
                :title="dec.devicesLabelled.value ? 'Refresh device list' : 'Detect devices (asks for audio permission once, so the inputs show their names)'"
                @click="detectDevices"
              >
                <span v-if="!dec.devicesLabelled.value">Detect</span>
              </UButton>
            </div>
            <p v-if="dec.source.value === 'line'" class="text-xs leading-snug text-zinc-500">
              Run a cable from the rig's headphone / speaker jack to the laptop's aux (combo) jack or a USB sound card, and pick that input here — the system default is usually the built-in microphone. Keep the rig's AF gain moderate so the meter sits around −20 dB on a signal, and set the pitch to the rig's CW pitch. Browser AGC, noise suppression and echo cancellation are switched off automatically.
            </p>
            <p v-else class="text-xs leading-snug text-zinc-500">
              Hold the microphone close to the rig's speaker in a quiet room. Wear headphones if you monitor: a mic feeding the speakers is a feedback loop. The keyer sidetone is muted while the microphone is live so it isn't decoded too.
            </p>
          </div>

          <div v-else class="mt-4 space-y-3">
            <div class="flex items-center gap-2">
              <UButton size="sm" variant="soft" color="neutral" icon="i-lucide-folder-open" @click="fileInput?.click()">
                Choose file
              </UButton>
              <span class="truncate font-mono text-xs text-zinc-400">{{ dec.fileName.value || 'no file loaded' }}</span>
            </div>
            <input ref="fileInput" type="file" accept="audio/*" class="hidden" @change="onFile">
            <p class="text-xs leading-snug text-zinc-500">
              Any format the browser can decode — including the WAVs the Rec button saves. The synthesized test clips live under <code class="text-zinc-400">/samples/cw/</code> if you want to play them through a sound card into a real input.
            </p>
          </div>

          <!-- monitor: input → headphones passthrough -->
          <div class="mt-4 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2.5">
            <div class="flex items-center justify-between gap-3">
              <label class="flex items-center gap-2 text-sm">
                <USwitch v-model="monitorOn" size="sm" />
                <span class="flex items-center gap-1.5">
                  <UIcon name="i-lucide-headphones" class="size-4 text-zinc-400" />
                  Monitor in headphones
                </span>
              </label>
              <span class="flex items-center gap-3 font-mono text-xs">
                <span
                  v-if="dec.listening.value && dec.latencyMs.value > 0"
                  :class="dec.latencyMs.value > 60 ? 'text-amber-400' : 'text-zinc-400'"
                  title="Browser audio round trip (capture buffer + output buffer). Not adjustable from the page — see the note below."
                >~{{ dec.latencyMs.value }} ms delay</span>
                <span :class="monitorOn ? 'text-emerald-400' : 'text-zinc-600'">{{ monitorDb }} dB</span>
              </span>
            </div>
            <USlider v-model="s.monitorLevel" :min="0" :max="2" :step="0.05" :disabled="!monitorOn" class="mt-2" />
            <div class="mt-2.5 flex items-center justify-between gap-3">
              <label class="flex items-center gap-2 text-sm" :class="monitorOn ? '' : 'opacity-50'">
                <USwitch v-model="s.monitorAgc" size="sm" :disabled="!monitorOn" />
                <span class="flex items-center gap-1.5">
                  <UIcon name="i-lucide-audio-lines" class="size-4 text-zinc-400" />
                  Level the volume
                </span>
              </label>
              <span
                v-if="s.monitorAgc && monitorOn && dec.listening.value"
                class="font-mono text-xs text-zinc-400"
                title="Gain the leveller is applying right now"
              >AGC {{ agcDb }} dB</span>
            </div>
            <div v-if="dec.canSelectOutput" class="mt-2 flex items-center gap-2">
              <USelect
                v-model="s.outputDeviceId"
                :items="outputItems"
                value-key="value"
                size="sm"
                class="flex-1"
                icon="i-lucide-speaker"
                :disabled="!monitorOn"
              />
            </div>
            <p class="mt-1.5 text-xs leading-snug text-zinc-500">
              <template v-if="dec.source.value === 'mic'">
                Off by default for a microphone — turn it on only with headphones plugged in.
              </template>
              <template v-else>
                Plugging into the rig's headphone jack silences its speaker; the input is passed straight through to your headphones so you still hear the band. The rig's volume sets the decoder level, this sets yours.
                Levelling evens out the rig's loud sidetone and its quieter receive audio, so you stop turning the volume down to transmit and back up to copy. It holds its gain through the gaps of a transmission and recovers over a few seconds after one ends; switch it off to hear the rig's own levels. Between overs it will run up to its <span class="text-zinc-400">+30 dB</span> limit and bring the band noise up with it, so a quiet band sounds far noisier in your headphones than it is on the air — what the decoder sees is the <span class="text-zinc-400">S/N</span> figure on the signal report, not what you are hearing.
                The browser adds a few tens of milliseconds each way, which you will notice when keying. For a zero-delay sidetone, put a Y-splitter on the rig's headphone jack — one leg to the laptop, one to your headphones — and switch this monitor off.
              </template>
            </p>
          </div>

          <div class="mt-4 flex items-center gap-3">
            <UButton
              size="lg"
              :color="dec.listening.value ? 'error' : 'primary'"
              :icon="dec.listening.value ? 'i-lucide-square' : 'i-lucide-play'"
              :loading="busy"
              class="font-mono uppercase tracking-wider"
              @click="toggle"
            >
              {{ dec.listening.value ? 'Stop' : 'Start listening' }}
            </UButton>
            <!-- recorder: Rec → Pause → Resume / Export / Discard -->
            <div class="flex items-center gap-1.5">
              <UButton
                v-if="rec === 'idle'"
                size="lg"
                variant="soft"
                color="neutral"
                icon="i-lucide-circle"
                :disabled="!dec.listening.value"
                class="font-mono uppercase tracking-wider"
                title="Record a WAV take of what you are hearing — the monitor signal, levelling and all, before the volume slider. Switch the leveller off to capture the rig's own levels instead."
                @click="recordOrResume"
              >
                Rec
              </UButton>
              <UButton
                v-else-if="rec === 'recording'"
                size="lg"
                variant="soft"
                color="error"
                icon="i-lucide-pause"
                class="animate-pulse font-mono uppercase tracking-wider"
                title="Pause the take"
                @click="dec.pauseRecording()"
              >
                Rec {{ recordLabel }}
              </UButton>
              <template v-else>
                <UButton
                  size="lg"
                  variant="soft"
                  color="error"
                  icon="i-lucide-circle"
                  :disabled="!dec.listening.value"
                  class="font-mono uppercase tracking-wider"
                  :title="dec.listening.value ? 'Resume the take' : 'Start listening to resume the take'"
                  @click="recordOrResume"
                >
                  {{ recordLabel }}
                </UButton>
                <UButton size="lg" variant="soft" color="primary" icon="i-lucide-download" class="font-mono uppercase tracking-wider" title="Download the take as WAV and start fresh" @click="exportRecording">
                  Export
                </UButton>
                <UButton size="lg" variant="ghost" color="neutral" icon="i-lucide-trash-2" title="Discard the take" @click="discardRecording" />
              </template>
            </div>
            <p v-if="dec.error.value" class="text-xs leading-snug text-rose-400">{{ dec.error.value }}</p>
            <p v-else-if="recordNote" class="text-xs leading-snug text-zinc-400">{{ recordNote }}</p>
            <p v-else-if="dec.listening.value && dec.source.value === 'mic'" class="text-xs leading-snug text-zinc-500">
              Keyer sidetone is muted while the microphone is live.
            </p>
          </div>
        </UCard>

        <UCard>
          <div class="mb-3 flex items-center justify-between">
            <div class="font-mono text-[10px] uppercase tracking-widest text-zinc-500">Filter & threshold</div>
            <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-undo-2" @click="dec.resetSettings()">Defaults</UButton>
          </div>
          <div class="space-y-4">
            <div>
              <div class="mb-1 flex items-center justify-between text-sm">
                <span>Centre pitch</span>
                <span class="font-mono text-emerald-400">{{ s.centerHz }} Hz</span>
              </div>
              <USlider v-model="s.centerHz" :min="400" :max="1000" :step="10" />
            </div>
            <div>
              <div class="mb-1 flex items-center justify-between text-sm">
                <span>Bandwidth <span class="text-zinc-500">(pre-filter Q ≈ {{ prefilterQ }})</span></span>
                <span class="font-mono text-emerald-400">{{ s.bandwidthHz }} Hz</span>
              </div>
              <USlider v-model="s.bandwidthHz" :min="25" :max="400" :step="5" />
              <p class="mt-1 text-xs leading-snug text-zinc-500">
                Narrow to reject QRM; widen for fast code or a drifting signal. 100 Hz suits most 15–30 WPM copy.
              </p>
            </div>

            <div class="border-t border-zinc-800 pt-4">
              <div class="mb-2 flex items-center justify-between text-sm">
                <span>Threshold</span>
                <div class="flex rounded border border-zinc-700 p-0.5">
                  <button
                    v-for="mode in (['auto', 'manual'] as const)"
                    :key="mode"
                    class="rounded px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-wider transition"
                    :class="s.thresholdMode === mode ? 'bg-emerald-500/20 text-emerald-300' : 'text-zinc-500 hover:text-zinc-300'"
                    @click="s.thresholdMode = mode"
                  >
                    {{ mode }}
                  </button>
                </div>
              </div>
              <template v-if="s.thresholdMode === 'manual'">
                <div class="mb-1 flex items-center justify-between text-sm">
                  <span class="text-zinc-400">Key-down level</span>
                  <span class="font-mono text-amber-400">{{ s.manualThresholdDb }} dB</span>
                </div>
                <USlider v-model="s.manualThresholdDb" :min="-60" :max="0" :step="1" />
                <p class="mt-1 text-xs leading-snug text-zinc-500">Set it between the noise (grey mark) and the signal (green mark) on the meter.</p>
              </template>
              <template v-else>
                <div class="mb-1 flex items-center justify-between text-sm">
                  <span class="text-zinc-400">Squelch — minimum signal over noise</span>
                  <span class="font-mono text-amber-400">{{ s.minSnrDb }} dB</span>
                </div>
                <USlider v-model="s.minSnrDb" :min="0" :max="20" :step="1" />
                <p class="mt-1 text-xs leading-snug text-zinc-500">
                  Auto measures the distribution of levels in the passband and keys halfway up a signal it can see, never closer to the noise than a constant-false-alarm gate allows. While that distribution shows no transmission the pill by the meter reads <span class="text-zinc-400">Squelched</span> and nothing is printed, so a dead band stays a blank page instead of a page of E and T. Raise this on a noisy band, lower it for weak signals.
                </p>
              </template>
            </div>

            <div class="border-t border-zinc-800 pt-3">
              <button class="flex w-full items-center justify-between text-sm text-zinc-300" @click="showAdvanced = !showAdvanced">
                <span class="font-mono text-[10px] uppercase tracking-widest text-zinc-500">Timing & noise blanker</span>
                <UIcon :name="showAdvanced ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="size-4 text-zinc-500" />
              </button>
              <div v-if="showAdvanced" class="mt-3 space-y-4">
                <div>
                  <div class="mb-1 flex items-center justify-between text-sm">
                    <span>Expected speed <span class="text-zinc-500">(seed)</span></span>
                    <span class="flex items-center gap-2 font-mono text-emerald-400">
                      {{ s.initialWpm }} WPM
                      <UButton size="xs" variant="soft" color="neutral" icon="i-lucide-rotate-ccw" title="Re-seed the speed tracker" @click="reseedSpeed" />
                    </span>
                  </div>
                  <USlider v-model="s.initialWpm" :min="5" :max="45" :step="1" />
                  <p class="mt-1 text-xs leading-snug text-zinc-500">
                    Where the dit/dah tracker starts; it re-fits itself within a character or two either way.
                  </p>
                </div>
                <div class="flex items-center justify-between text-sm">
                  <span>Lock speed <span class="text-zinc-500">(no adaptation)</span></span>
                  <USwitch v-model="s.lockSpeed" />
                </div>
                <div>
                  <div class="mb-1 flex items-center justify-between text-sm">
                    <span>Speed averaging</span>
                    <span class="font-mono text-emerald-400">{{ s.speedAveraging.toFixed(2) }}</span>
                  </div>
                  <USlider v-model="s.speedAveraging" :min="0.05" :max="1" :step="0.05" />
                  <p class="mt-1 text-xs leading-snug text-zinc-500">Weight of each new element in the timing estimate — low is steady, high follows an erratic fist.</p>
                </div>
                <div>
                  <div class="mb-1 flex items-center justify-between text-sm">
                    <span>Noise blanker</span>
                    <span class="font-mono text-emerald-400">{{ s.noiseBlankerMs }} ms</span>
                  </div>
                  <USlider v-model="s.noiseBlankerMs" :min="2" :max="30" :step="1" />
                  <p class="mt-1 text-xs leading-snug text-zinc-500">Key changes shorter than this are ignored. A 30 WPM dit is 40 ms, so stay well under that.</p>
                </div>
                <div class="flex items-center justify-between text-sm">
                  <span>Bandpass pre-filter <span class="text-zinc-500">(before the detector)</span></span>
                  <USwitch v-model="s.prefilter" />
                </div>
              </div>
            </div>
          </div>
        </UCard>
      </div>
    </div>

    <p class="text-xs leading-relaxed text-zinc-600">
      How it works: the audio is mixed to the centre pitch and integrated over a window set by the bandwidth (a sliding single-bin
      Goertzel detector, as in the QCX/QMX), the envelope is keyed against an adaptive noise-floor/peak threshold, and element
      lengths are clustered into dits and dahs so the speed tracks the sender. Letters print as soon as the gap after them exceeds
      the letter boundary. Unknown patterns print as a dot.
    </p>
  </div>
</template>
