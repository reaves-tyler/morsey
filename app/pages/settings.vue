<script setup lang="ts">
import { parseProgressJson, type ProgressState } from '~/composables/useProgress'

const { progress, resetProgress, resetSettings } = useProgress()
const audio = useMorseAudio()

const s = computed(() => progress.value.settings)

// Effective speed can never exceed character speed
watch(() => s.value.charWpm, (charWpm) => {
  if (s.value.effectiveWpm > charWpm) s.value.effectiveWpm = charWpm
})

const confirmingReset = ref(false)
function doReset() {
  resetProgress()
  confirmingReset.value = false
}

const settingsResetDone = ref(false)
function doResetSettings() {
  resetSettings()
  settingsResetDone.value = true
  setTimeout(() => { settingsResetDone.value = false }, 2000)
}

// ---- Backup & restore --------------------------------------------------------

const fileInput = ref<HTMLInputElement>()
const pendingImport = ref<ProgressState | null>(null)
const importError = ref('')
const importDone = ref(false)

function doExport() {
  const blob = new Blob([JSON.stringify(progress.value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `morsey-progress-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
}

async function onImportFile(event: Event) {
  importError.value = ''
  importDone.value = false
  pendingImport.value = null
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const result = parseProgressJson(await file.text())
  if ('error' in result) importError.value = result.error
  else pendingImport.value = result.state
  input.value = '' // allow re-picking the same file
}

function levelOf(state: ProgressState) {
  return Math.floor(Math.sqrt(state.xp / 100)) + 1
}

function applyImport() {
  if (!pendingImport.value) return
  progress.value = pendingImport.value
  pendingImport.value = null
  importDone.value = true
  setTimeout(() => { importDone.value = false }, 3000)
}
</script>

<template>
  <div class="mx-auto max-w-2xl space-y-6">
    <header>
      <h1 class="text-2xl font-semibold tracking-tight">Settings</h1>
      <p class="mt-1 text-sm text-zinc-400">
        Character speed stays fast so you learn rhythm, not counting. Grow the effective speed over time.
      </p>
    </header>

    <UCard>
      <div class="space-y-6">
        <div>
          <div class="mb-2 flex items-center justify-between">
            <label class="text-sm font-medium">Character speed</label>
            <span class="font-mono text-sm text-emerald-400">{{ s.charWpm }} WPM</span>
          </div>
          <USlider v-model="s.charWpm" :min="15" :max="35" :step="1" />
          <p class="mt-1.5 text-xs text-zinc-500">How fast each character itself is keyed. Keep at 20+ — never learn slow characters.</p>
        </div>

        <div>
          <div class="mb-2 flex items-center justify-between">
            <label class="text-sm font-medium">Effective speed (Farnsworth)</label>
            <span class="font-mono text-sm text-emerald-400">{{ s.effectiveWpm }} WPM</span>
          </div>
          <USlider v-model="s.effectiveWpm" :min="5" :max="s.charWpm" :step="1" />
          <p class="mt-1.5 text-xs text-zinc-500">Overall pace — the spacing between characters stretches to hit this. Raise it as you improve.</p>
        </div>

        <div>
          <div class="mb-2 flex items-center justify-between">
            <label class="text-sm font-medium">Copy-mode group size</label>
            <span class="font-mono text-sm text-emerald-400">{{ s.groupSize }} chars</span>
          </div>
          <USlider v-model="s.groupSize" :min="3" :max="8" :step="1" />
        </div>

        <div class="flex flex-wrap items-center justify-end gap-2">
          <span v-if="settingsResetDone" class="text-xs text-emerald-400">Settings restored to defaults.</span>
          <UButton variant="soft" color="neutral" icon="i-lucide-undo-2" @click="doResetSettings">
            Reset to defaults
          </UButton>
          <UButton variant="soft" color="neutral" icon="i-lucide-volume-2" @click="audio.playText('PARIS')">
            Test tone (PARIS)
          </UButton>
        </div>

        <p class="text-xs text-zinc-500">
          Sending-side settings — key type, iambic mode, paddle reverse, keyer speed, sidetone pitch,
          and volume — live in the <span class="font-mono uppercase tracking-wider text-emerald-400">keyer</span> bar at the bottom of every page.
        </p>
      </div>
    </UCard>

    <UCard>
      <h2 class="font-medium">How Morsey trains you</h2>
      <ul class="mt-3 space-y-2 text-sm text-zinc-400">
        <li class="flex gap-2">
          <UIcon name="i-lucide-ear" class="mt-0.5 size-4 shrink-0 text-emerald-400" />
          <span><strong class="text-zinc-200">Koch method:</strong> start with just K and M at full speed; a new character unlocks only when you hit 90% accuracy, so you're always challenged but never drowning.</span>
        </li>
        <li class="flex gap-2">
          <UIcon name="i-lucide-timer" class="mt-0.5 size-4 shrink-0 text-emerald-400" />
          <span><strong class="text-zinc-200">Farnsworth timing:</strong> characters are always keyed fast (rhythm recognition), while extra thinking space between them shrinks as your effective speed rises.</span>
        </li>
        <li class="flex gap-2">
          <UIcon name="i-lucide-repeat" class="mt-0.5 size-4 shrink-0 text-emerald-400" />
          <span><strong class="text-zinc-200">Adaptive drilling:</strong> characters and phrases you miss are weighted to appear more often until they stick.</span>
        </li>
        <li class="flex gap-2">
          <UIcon name="i-lucide-flame" class="mt-0.5 size-4 shrink-0 text-emerald-400" />
          <span><strong class="text-zinc-200">Streaks, combos & XP:</strong> short daily sessions beat marathon cramming — the streak keeps you honest.</span>
        </li>
      </ul>
    </UCard>

    <UCard>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 class="font-medium">Backup & restore</h2>
          <p class="text-sm text-zinc-500">
            Progress lives in this browser's localStorage. Export a JSON backup to move it to another
            device or browser, or to keep it safe from a "clear site data".
          </p>
        </div>
        <div class="flex gap-2">
          <UButton variant="soft" color="neutral" size="sm" icon="i-lucide-download" @click="doExport">
            Export
          </UButton>
          <UButton variant="soft" color="neutral" size="sm" icon="i-lucide-upload" @click="fileInput?.click()">
            Import…
          </UButton>
          <input
            ref="fileInput"
            type="file"
            accept=".json,application/json"
            class="hidden"
            @change="onImportFile"
          >
        </div>
      </div>

      <p v-if="importError" class="mt-3 text-sm text-rose-400">{{ importError }}</p>
      <p v-if="importDone" class="mt-3 text-sm text-emerald-400">Progress imported.</p>

      <!-- Import preview: show what's in the file before replacing anything -->
      <div v-if="pendingImport" class="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
        <p class="text-sm text-zinc-300">
          Replace your current progress
          <span class="text-zinc-500">(Lv {{ levelOf(progress) }}, {{ progress.totalAnswers }} answers, lesson {{ progress.koch.lesson }})</span>
          with this backup?
        </p>
        <p class="mt-1 font-mono text-sm text-amber-300">
          Lv {{ levelOf(pendingImport) }} · {{ pendingImport.xp }} XP · {{ pendingImport.totalAnswers }} answers ·
          lesson {{ pendingImport.koch.lesson }} · {{ pendingImport.streakDays }}-day streak
        </p>
        <div class="mt-3 flex gap-2">
          <UButton color="primary" size="sm" icon="i-lucide-check" @click="applyImport">
            Replace with backup
          </UButton>
          <UButton variant="soft" color="neutral" size="sm" @click="pendingImport = null">
            Cancel
          </UButton>
        </div>
      </div>
    </UCard>

    <UCard class="ring-1 ring-rose-500/20">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 class="font-medium text-rose-300">Reset progress</h2>
          <p class="text-sm text-zinc-500">Wipes XP, lessons, and stats. Settings are kept. Cannot be undone.</p>
        </div>
        <div class="flex gap-2">
          <template v-if="confirmingReset">
            <UButton variant="soft" color="neutral" size="sm" @click="confirmingReset = false">Cancel</UButton>
            <UButton color="error" size="sm" icon="i-lucide-trash-2" @click="doReset">Yes, reset everything</UButton>
          </template>
          <UButton v-else color="error" variant="soft" size="sm" @click="confirmingReset = true">
            Reset…
          </UButton>
        </div>
      </div>
    </UCard>
  </div>
</template>
