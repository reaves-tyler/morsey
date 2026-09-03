<script setup lang="ts">
useSeoMeta({
  title: 'Live CW Decoder for Your Transceiver Audio',
  description: 'Decode Morse code from your radio in real time, in the browser. Feed line-in or a USB sound card, tune the passband on a live spectrum display, and read a text terminal with automatic speed tracking, adaptive noise threshold and prosign detection. Test it first with built-in clean, noisy, QSB and QRM samples.',
  ogTitle: 'Live CW Decoder · Morsey',
  ogDescription: 'Browser-based Morse decoder for rig audio: spectrum tuning, adaptive threshold, speed tracking.'
})

import type { SamplePreset } from '~/utils/cwSynth'
import { DEFAULT_DEVICE } from '~/composables/useCwStreamDecoder'

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

const SOURCES: { id: 'mic' | 'sample' | 'file'; label: string; icon: string; hint: string }[] = [
  { id: 'mic', label: 'Radio input', icon: 'i-lucide-radio', hint: 'Line-in / microphone from the rig' },
  { id: 'sample', label: 'Test sample', icon: 'i-lucide-flask-conical', hint: 'Synthesized band audio' },
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

const recordNote = ref('')
function toggleRecording() {
  if (dec.recording.value) {
    saveRecording()
    return
  }
  if (dec.startRecording()) recordNote.value = ''
}
function saveRecording() {
  const rec = dec.stopRecording()
  if (!rec) {
    recordNote.value = 'Nothing captured.'
    return
  }
  const url = URL.createObjectURL(rec.blob)
  const a = document.createElement('a')
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
  a.href = url
  a.download = `morsey-rx-${stamp}.wav`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  recordNote.value = `Saved ${a.download} · ${rec.seconds.toFixed(0)} s at ${(rec.sampleRate / 1000).toFixed(1)} kHz`
}
const recordLabel = computed(() => {
  const sec = dec.recordedSeconds.value
  const mb = dec.recordedBytes.value / 1048576
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')} · ${mb.toFixed(1)} MB`
})
// a recording in progress is finalized (and offered for download) when listening stops
watch(() => dec.listening.value, (on) => { if (!on && dec.recording.value) saveRecording() })

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

function pickSample(p: SamplePreset) {
  dec.sampleId.value = p.id
  dec.source.value = 'sample'
  if (dec.listening.value) dec.stop()
  toggle()
}

// (a select item may not carry an empty-string value, hence the sentinel)
const deviceItems = computed(() => [
  { label: 'Default input', value: DEFAULT_DEVICE },
  ...dec.devices.value.filter(d => d.deviceId).map(d => ({ label: d.label, value: d.deviceId }))
])

function selectSource(id: 'mic' | 'sample' | 'file') {
  if (dec.listening.value) dec.stop()
  dec.source.value = id
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

/** Render decoded text with prosigns as chips and unknowns dimmed */
const tokens = computed(() => dec.text.value.match(/<[A-Z]+>|\*| |[^<* ]+/g) ?? [])

// ---- Advanced ------------------------------------------------------------------------

const showAdvanced = ref(false)
function reseedSpeed() {
  dec.resetTiming()
}
function matchRigPitch() {
  s.value.centerHz = progress.value.settings.freq
}

const difficultyDots = (d: number) => Array.from({ length: 5 }, (_, i) => i < d)
</script>

<template>
  <div class="space-y-6">
    <section class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">Stream decoding</h1>
        <p class="mt-1 text-sm text-zinc-400">
          Live over-the-air CW terminal. Feed it your rig's audio, or run a test sample to see it work before the hardware arrives.
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

    <!-- Signal display -->
    <UCard>
      <div class="grid gap-4 lg:grid-cols-[1fr_auto]">
        <div class="space-y-3">
          <div class="flex items-center justify-between">
            <div class="font-mono text-[10px] uppercase tracking-widest text-zinc-500">
              Spectrum · click or drag to tune
            </div>
            <div class="flex gap-1.5">
              <UButton size="xs" variant="soft" color="neutral" icon="i-lucide-crosshair" :disabled="!dec.listening.value" @click="tuneToPeak">
                Tune to peak
              </UButton>
              <UButton size="xs" variant="soft" color="neutral" icon="i-lucide-music-2" @click="matchRigPitch">
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
              <span>Tone level in passband</span>
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
        <div class="grid grid-cols-2 gap-2 lg:w-56 lg:grid-cols-1">
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
        class="h-48 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950 p-4 font-mono text-lg leading-relaxed text-emerald-200 whitespace-pre-wrap break-words"
        aria-live="polite"
      >
        <template v-for="(tok, i) in tokens" :key="i">
          <span v-if="tok.startsWith('<')" class="mx-0.5 rounded bg-emerald-500/15 px-1 text-sm text-emerald-300">{{ tok.slice(1, -1) }}</span>
          <span v-else-if="tok === '*'" class="text-zinc-600" title="unknown pattern">·</span>
          <span v-else>{{ tok }}</span>
        </template>
        <span v-if="dec.pattern.value" class="ml-1 rounded bg-zinc-800 px-1.5 text-sm text-amber-300">{{ dec.pattern.value }}</span>
        <span
          class="ml-0.5 inline-block h-5 w-2 translate-y-1 bg-emerald-400/80"
          :class="dec.listening.value ? 'animate-pulse' : 'opacity-30'"
        />
        <p v-if="!dec.text.value && !dec.listening.value" class="text-sm text-zinc-600">
          Nothing decoded yet. Pick a source below and press Start — or click a test sample.
        </p>
      </div>
      <div v-if="dec.playbackProgress.value > 0 && dec.listening.value" class="mt-2">
        <UProgress :model-value="dec.playbackProgress.value * 100" :max="100" size="xs" />
      </div>
    </UCard>

    <!-- Controls -->
    <div class="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
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
        <div v-if="dec.source.value === 'mic'" class="mt-4 space-y-3">
          <div class="flex items-center gap-2">
            <USelect
              v-model="s.deviceId"
              :items="deviceItems"
              value-key="value"
              size="sm"
              class="flex-1"
              placeholder="Default input"
            />
            <UButton size="sm" variant="soft" color="neutral" icon="i-lucide-refresh-cw" title="Refresh device list" @click="dec.refreshDevices()" />
          </div>
          <p class="text-xs leading-snug text-zinc-500">
            Connect the rig's headphone / line-out to your computer's line-in or a USB sound card, keep the rig's AF gain moderate (the meter should sit around −20 dB on a signal), and set the pitch to the rig's CW pitch — the QMX defaults to 700 Hz. Browser audio processing (AGC, noise suppression, echo cancellation) is disabled automatically. Device names appear after the first permission grant.
          </p>
        </div>

        <div v-else-if="dec.source.value === 'sample'" class="mt-4 space-y-2">
          <div class="flex items-center justify-between">
            <span class="font-mono text-[10px] uppercase tracking-widest text-zinc-500">Sample library · easiest to hardest</span>
            <label class="flex items-center gap-2 text-xs text-zinc-400">
              <USwitch v-model="s.monitor" size="xs" /> Hear it
            </label>
          </div>
          <div class="grid gap-1.5 sm:grid-cols-2">
            <button
              v-for="p in dec.presets"
              :key="p.id"
              class="flex items-start gap-2 rounded border px-3 py-2 text-left transition"
              :class="dec.sampleId.value === p.id
                ? 'border-emerald-500/70 bg-emerald-500/10'
                : 'border-zinc-800 bg-zinc-900/60 hover:border-zinc-600'"
              @click="pickSample(p)"
            >
              <UIcon
                :name="dec.listening.value && dec.sampleId.value === p.id ? 'i-lucide-square' : 'i-lucide-play'"
                class="mt-0.5 size-3.5 shrink-0"
                :class="dec.sampleId.value === p.id ? 'text-emerald-400' : 'text-zinc-500'"
              />
              <span class="min-w-0 flex-1">
                <span class="flex items-center justify-between gap-2">
                  <span class="text-sm font-medium text-zinc-200">{{ p.name }}</span>
                  <span class="flex gap-0.5" :title="`difficulty ${p.difficulty} of 5`">
                    <span
                      v-for="(on, i) in difficultyDots(p.difficulty)"
                      :key="i"
                      class="size-1.5 rounded-full"
                      :class="on ? (p.difficulty >= 4 ? 'bg-rose-400' : p.difficulty === 3 ? 'bg-amber-400' : 'bg-emerald-400') : 'bg-zinc-700'"
                    />
                  </span>
                </span>
                <span class="block text-[11px] leading-snug text-zinc-500">{{ p.description }}</span>
                <span class="mt-0.5 block truncate font-mono text-[10px] text-zinc-600">{{ p.options.text }}</span>
              </span>
            </button>
          </div>
        </div>

        <div v-else class="mt-4 space-y-3">
          <div class="flex items-center gap-2">
            <UButton size="sm" variant="soft" color="neutral" icon="i-lucide-folder-open" @click="fileInput?.click()">
              Choose file
            </UButton>
            <span class="truncate font-mono text-xs text-zinc-400">{{ dec.fileName.value || 'no file loaded' }}</span>
            <label class="ml-auto flex items-center gap-2 text-xs text-zinc-400">
              <USwitch v-model="s.monitor" size="xs" /> Hear it
            </label>
          </div>
          <input ref="fileInput" type="file" accept="audio/*" class="hidden" @change="onFile">
          <p class="text-xs leading-snug text-zinc-500">
            Any format the browser can decode. The generated sample WAVs live under <code class="text-zinc-400">/samples/cw/</code> if you want to play them through a sound card into a real input.
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
          <UButton
            size="lg"
            variant="soft"
            :color="dec.recording.value ? 'error' : 'neutral'"
            :icon="dec.recording.value ? 'i-lucide-square' : 'i-lucide-circle'"
            :disabled="!dec.listening.value && !dec.recording.value"
            class="font-mono uppercase tracking-wider"
            :class="dec.recording.value ? 'animate-pulse' : ''"
            title="Record the raw input to a WAV file (what the decoder heard, before filtering) — useful for replaying real on-air audio through the decoder tests"
            @click="toggleRecording"
          >
            {{ dec.recording.value ? `Rec ${recordLabel}` : 'Rec' }}
          </UButton>
          <p v-if="dec.error.value" class="text-xs leading-snug text-rose-400">{{ dec.error.value }}</p>
          <p v-else-if="recordNote" class="text-xs leading-snug text-zinc-400">{{ recordNote }}</p>
          <p v-else-if="dec.listening.value && dec.source.value === 'mic'" class="text-xs leading-snug text-zinc-500">
            Keyer sidetone is muted while the radio is connected.
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
                Auto tracks the noise floor and the signal peak and keys halfway between them, with a constant-false-alarm gate against noise bursts. Raise the squelch on a noisy band, lower it for weak signals.
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

    <p class="text-xs leading-relaxed text-zinc-600">
      How it works: the audio is mixed to the centre pitch and integrated over a window set by the bandwidth (a sliding single-bin
      Goertzel detector, as in the QCX/QMX), the envelope is keyed against an adaptive noise-floor/peak threshold, and element
      lengths are clustered into dits and dahs so the speed tracks the sender. Letters print as soon as the gap after them exceeds
      the letter boundary. Unknown patterns print as a dot.
    </p>
  </div>
</template>
