<script setup lang="ts">
import { PHRASE_TIERS } from '~/utils/abbreviations'
import { patternFor, wordPattern } from '~/utils/morse'

const { progress, unlockedChars, unlockedTierCount, addXp } = useProgress()
const keyer = useKeyer()

type SendMode = 'free' | 'chars' | 'phrases'
const sendMode = ref<SendMode>('chars')

type ChallengeState = 'idle' | 'keying' | 'correct' | 'wrong'
const challengeState = ref<ChallengeState>('idle')
const target = ref('')
const showHint = ref(false)
const sessionCorrect = ref(0)
const sessionTotal = ref(0)
const lastXpGain = ref(0)
const serialError = ref('')
let advanceTimer: ReturnType<typeof setTimeout> | null = null

const keyerMode = computed({
  get: () => progress.value.settings.keyerMode,
  set: (v: 'straight' | 'paddle') => { progress.value.settings.keyerMode = v }
})

const sendWpm = computed({
  get: () => progress.value.settings.sendWpm,
  set: (v: number) => { progress.value.settings.sendWpm = v }
})

// Phrases eligible for sending practice: plain abbreviations from unlocked
// tiers (prosigns are excluded — merged characters don't decode letter by
// letter, so they are receive-side material)
const sendablePhrases = computed(() =>
  PHRASE_TIERS.slice(0, unlockedTierCount.value)
    .flatMap(t => t.items)
    .filter(p => !p.send.includes('<'))
)

function nextTarget() {
  if (advanceTimer) clearTimeout(advanceTimer)
  keyer.clear()
  showHint.value = false
  if (sendMode.value === 'chars') {
    const chars = unlockedChars.value
    let pick = chars[Math.floor(Math.random() * chars.length)]!
    if (chars.length > 2) {
      while (pick === target.value) pick = chars[Math.floor(Math.random() * chars.length)]!
    }
    target.value = pick
  } else {
    const pool = sendablePhrases.value
    target.value = pool[Math.floor(Math.random() * pool.length)]!.send
  }
  challengeState.value = 'keying'
}

const targetClean = computed(() => target.value.trim().toUpperCase())

watch(keyer.decoded, (val) => {
  if (sendMode.value === 'free' || challengeState.value !== 'keying') return
  const attempt = val.trim().replace(/\s+/g, ' ')
  if (attempt.length < targetClean.value.length) return
  const correct = attempt === targetClean.value
  sessionTotal.value++
  if (correct) {
    sessionCorrect.value++
    lastXpGain.value = sendMode.value === 'chars' ? 20 : 40
    addXp(lastXpGain.value)
    challengeState.value = 'correct'
    advanceTimer = setTimeout(nextTarget, 900)
  } else {
    lastXpGain.value = 0
    challengeState.value = 'wrong'
    advanceTimer = setTimeout(nextTarget, 1800)
  }
})

function switchMode(m: SendMode) {
  sendMode.value = m
  challengeState.value = 'idle'
  target.value = ''
  keyer.clear()
}

async function connectSerial() {
  serialError.value = ''
  const err = await keyer.connectSerial()
  if (err) serialError.value = err
}

onMounted(() => keyer.attach())
onBeforeUnmount(() => {
  keyer.detach()
  if (advanceTimer) clearTimeout(advanceTimer)
})
</script>

<template>
  <div class="space-y-6">
    <header class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">Sending Practice</h1>
        <p class="mt-1 text-sm text-zinc-400">
          Key with your keyboard, the on-screen key, or a physical USB paddle. Morsey decodes your fist in real time.
        </p>
      </div>
      <div class="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 p-1">
        <UButton
          v-for="m in ([['chars', 'Characters'], ['phrases', 'Phrases'], ['free', 'Free key']] as const)"
          :key="m[0]"
          :variant="sendMode === m[0] ? 'solid' : 'ghost'"
          :color="sendMode === m[0] ? 'primary' : 'neutral'"
          size="sm"
          @click="switchMode(m[0])"
        >
          {{ m[1] }}
        </UButton>
      </div>
    </header>

    <!-- Input configuration -->
    <UCard>
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div class="flex items-center gap-4">
          <div class="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 p-1">
            <UButton
              :variant="keyerMode === 'straight' ? 'solid' : 'ghost'"
              :color="keyerMode === 'straight' ? 'primary' : 'neutral'"
              size="xs"
              @click="keyerMode = 'straight'"
            >
              Straight key
            </UButton>
            <UButton
              :variant="keyerMode === 'paddle' ? 'solid' : 'ghost'"
              :color="keyerMode === 'paddle' ? 'primary' : 'neutral'"
              size="xs"
              @click="keyerMode = 'paddle'"
            >
              Iambic paddle
            </UButton>
          </div>
          <p class="text-xs text-zinc-500">
            <template v-if="keyerMode === 'straight'">
              Hold <kbd class="rounded bg-zinc-800 px-1.5 py-0.5 font-mono">Space</kbd> —
              release under {{ keyer.dahThresholdMs.value }} ms = dit, hold longer = dah.
              The threshold adapts to your fist as you key.
            </template>
            <template v-else>
              <kbd class="rounded bg-zinc-800 px-1.5 py-0.5 font-mono">[</kbd> / left
              <kbd class="rounded bg-zinc-800 px-1.5 py-0.5 font-mono">Ctrl</kbd> = dit ·
              <kbd class="rounded bg-zinc-800 px-1.5 py-0.5 font-mono">]</kbd> / right
              <kbd class="rounded bg-zinc-800 px-1.5 py-0.5 font-mono">Ctrl</kbd> = dah · squeeze both = alternate
            </template>
          </p>
        </div>
        <div class="flex items-center gap-2">
          <UBadge v-if="keyer.serialConnected.value" color="primary" variant="subtle">
            <UIcon name="i-lucide-usb" class="size-3.5" /> Serial connected
          </UBadge>
          <UButton
            v-if="!keyer.serialConnected.value"
            variant="soft" color="neutral" size="sm" icon="i-lucide-usb"
            @click="connectSerial"
          >
            Connect USB key
          </UButton>
          <UButton
            v-else variant="soft" color="neutral" size="sm"
            @click="keyer.disconnectSerial()"
          >
            Disconnect
          </UButton>
        </div>
      </div>
      <p v-if="serialError" class="mt-2 text-xs text-rose-400">{{ serialError }}</p>

      <div class="mt-4 flex items-center gap-4 border-t border-zinc-800/80 pt-4">
        <label class="shrink-0 text-sm font-medium">Sending speed</label>
        <USlider v-model="sendWpm" :min="8" :max="30" :step="1" class="max-w-xs flex-1" size="sm" />
        <span class="shrink-0 font-mono text-sm text-emerald-400">{{ sendWpm }} WPM</span>
        <span class="hidden text-xs text-zinc-600 sm:inline">Slower = more forgiving timing. Independent of your listening speed.</span>
      </div>

      <p class="mt-3 text-xs text-zinc-600">
        USB keyers that emulate a keyboard or mouse work without connecting — just start keying.
        Serial-wired paddles use the CTS (dit) and DSR (dah) lines via the Web Serial API.
      </p>
    </UCard>

    <!-- Challenge target -->
    <UCard v-if="sendMode !== 'free'">
      <div class="flex flex-col items-center gap-4 py-4">
        <div v-if="challengeState === 'idle'" class="flex flex-col items-center gap-4">
          <p class="text-sm text-zinc-400">
            Morsey shows you a {{ sendMode === 'chars' ? 'character' : 'phrase' }} — you send it.
          </p>
          <UButton color="primary" size="lg" icon="i-lucide-play" @click="nextTarget">
            Start sending
          </UButton>
        </div>
        <template v-else>
          <div class="text-xs uppercase tracking-wide text-zinc-500">Send this</div>
          <div
            class="rounded-xl border-2 px-8 py-4 font-mono text-4xl tracking-widest transition"
            :class="{
              'border-zinc-600 text-zinc-100': challengeState === 'keying',
              'border-emerald-500 bg-emerald-500/10 text-emerald-300 morsey-good': challengeState === 'correct',
              'border-rose-500 bg-rose-500/10 text-rose-300 morsey-bad': challengeState === 'wrong'
            }"
          >
            {{ target }}
          </div>
          <div class="h-5 text-sm">
            <span v-if="challengeState === 'correct'" class="text-emerald-400">Clean fist! +{{ lastXpGain }} XP</span>
            <span v-else-if="challengeState === 'wrong'" class="text-rose-400">
              Copied <span class="font-mono">{{ keyer.decoded.value.trim() || '—' }}</span> — next one coming…
            </span>
            <span v-else class="text-zinc-500">{{ sessionCorrect }} / {{ sessionTotal }} this session</span>
          </div>
          <div class="flex items-center gap-2">
            <UButton variant="soft" color="neutral" size="sm" icon="i-lucide-eye" @click="showHint = !showHint">
              {{ showHint ? 'Hide' : 'Show' }} pattern
            </UButton>
            <UButton variant="soft" color="neutral" size="sm" icon="i-lucide-skip-forward" @click="nextTarget">
              Skip
            </UButton>
          </div>
          <div v-if="showHint" class="font-mono text-lg tracking-[0.3em] text-indigo-300">
            {{ sendMode === 'chars' ? patternFor(target) : wordPattern(target) }}
          </div>
        </template>
      </div>
    </UCard>

    <!-- Key + decoded output -->
    <UCard>
      <div class="flex flex-col items-center gap-6 py-4">
        <!-- On-screen key(s) -->
        <div class="flex gap-4">
          <template v-if="keyerMode === 'straight'">
            <button
              class="flex size-32 select-none items-center justify-center rounded-full border-4 font-semibold uppercase tracking-wide transition active:scale-95"
              :class="keyer.keyed.value
                ? 'border-emerald-400 bg-emerald-500/20 text-emerald-300'
                : 'border-zinc-700 bg-zinc-900 text-zinc-400'"
              @pointerdown.prevent="keyer.inputDown('primary')"
              @pointerup.prevent="keyer.inputUp('primary')"
              @pointerleave="keyer.inputUp('primary')"
              @contextmenu.prevent
            >
              Key
            </button>
          </template>
          <template v-else>
            <button
              class="flex h-32 w-24 select-none items-center justify-center rounded-l-3xl border-4 font-mono text-2xl transition active:scale-95 border-zinc-700 bg-zinc-900 text-zinc-400 active:border-emerald-400 active:text-emerald-300"
              @pointerdown.prevent="keyer.inputDown('primary')"
              @pointerup.prevent="keyer.inputUp('primary')"
              @pointerleave="keyer.inputUp('primary')"
              @contextmenu.prevent
            >
              ·
            </button>
            <button
              class="flex h-32 w-24 select-none items-center justify-center rounded-r-3xl border-4 font-mono text-2xl transition active:scale-95 border-zinc-700 bg-zinc-900 text-zinc-400 active:border-emerald-400 active:text-emerald-300"
              @pointerdown.prevent="keyer.inputDown('secondary')"
              @pointerup.prevent="keyer.inputUp('secondary')"
              @pointerleave="keyer.inputUp('secondary')"
              @contextmenu.prevent
            >
              −
            </button>
          </template>
        </div>

        <!-- Live decode -->
        <div class="w-full max-w-xl space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-xs uppercase tracking-wide text-zinc-500">Decoded</span>
            <UButton
              variant="ghost" color="neutral" size="xs" icon="i-lucide-eraser"
              title="Backspace also clears"
              @click="keyer.clear()"
            >
              Clear
              <kbd class="rounded bg-zinc-800 px-1 py-0.5 font-mono text-[10px] text-zinc-500">⌫</kbd>
            </UButton>
          </div>
          <div class="min-h-16 rounded-lg border border-zinc-800 bg-zinc-950 p-4 font-mono text-xl tracking-wider">
            <span class="text-zinc-100">{{ keyer.decoded.value || ' ' }}</span>
            <span class="text-emerald-400">{{ keyer.currentSymbols.value }}</span>
            <!-- Live preview of the element being held: starts as a dit, flips
                 to a dah the instant the hold crosses the threshold -->
            <span v-if="keyer.holdPreview.value" class="morsey-pulse text-amber-400">{{ keyer.holdPreview.value }}</span>
            <span v-else-if="keyer.keyed.value" class="morsey-pulse text-emerald-400">▊</span>
          </div>
        </div>
      </div>
    </UCard>
  </div>
</template>
