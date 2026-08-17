<script setup lang="ts">
import { PHRASE_TIERS } from '~/utils/abbreviations'
import { patternFor, wordPattern } from '~/utils/morse'
import { KEY_TYPE_LABELS } from '~/composables/useProgress'

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
let advanceTimer: ReturnType<typeof setTimeout> | null = null

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
          Key with your keyboard, the on-screen key, or a real key through the USB bridge.
          Configure key type and speed in the <span class="font-mono text-xs uppercase tracking-wider text-emerald-400">keyer</span> bar below.
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

    <!-- Challenge target -->
    <UCard v-if="sendMode !== 'free'">
      <div class="flex flex-col items-center gap-4 py-4">
        <div v-if="challengeState === 'idle'" class="flex flex-col items-center gap-4">
          <p class="text-sm text-zinc-400">
            Morsey shows you a {{ sendMode === 'chars' ? 'character' : 'phrase' }} — you send it
            with your {{ KEY_TYPE_LABELS[keyer.keyType.value].toLowerCase() }} key.
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
        <!-- On-screen key(s): left = tip, right = ring, same as the plug -->
        <div class="flex gap-4">
          <template v-if="keyer.keyType.value === 'straight'">
            <button
              class="flex size-32 select-none items-center justify-center rounded-full border-4 font-semibold uppercase tracking-wide transition active:scale-95"
              :class="keyer.keyed.value
                ? 'border-emerald-400 bg-emerald-500/20 text-emerald-300'
                : 'border-zinc-700 bg-zinc-900 text-zinc-400'"
              @pointerdown.prevent="keyer.contactDown('tip')"
              @pointerup.prevent="keyer.contactUp('tip')"
              @pointerleave="keyer.contactUp('tip')"
              @contextmenu.prevent
            >
              Key
            </button>
          </template>
          <template v-else>
            <button
              class="flex h-32 w-24 select-none flex-col items-center justify-center gap-1 rounded-l-3xl border-4 border-zinc-700 bg-zinc-900 font-mono text-zinc-400 transition active:scale-95 active:border-emerald-400 active:text-emerald-300"
              @pointerdown.prevent="keyer.contactDown('tip')"
              @pointerup.prevent="keyer.contactUp('tip')"
              @pointerleave="keyer.contactUp('tip')"
              @contextmenu.prevent
            >
              <span class="text-2xl">{{ progress.settings.paddleReverse ? '−' : '·' }}</span>
              <span class="text-[10px] uppercase tracking-widest text-zinc-600">tip</span>
            </button>
            <button
              class="flex h-32 w-24 select-none flex-col items-center justify-center gap-1 rounded-r-3xl border-4 border-zinc-700 bg-zinc-900 font-mono text-zinc-400 transition active:scale-95 active:border-emerald-400 active:text-emerald-300"
              @pointerdown.prevent="keyer.contactDown('ring')"
              @pointerup.prevent="keyer.contactUp('ring')"
              @pointerleave="keyer.contactUp('ring')"
              @contextmenu.prevent
            >
              <span class="text-2xl">{{ progress.settings.paddleReverse ? '·' : '−' }}</span>
              <span class="text-[10px] uppercase tracking-widest text-zinc-600">ring</span>
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
            <span class="text-zinc-100">{{ keyer.decoded.value || ' ' }}</span>
            <span class="text-emerald-400">{{ keyer.currentSymbols.value }}</span>
            <!-- Live preview of a manual element being held: starts as a dit,
                 flips to a dah the instant the hold crosses the threshold -->
            <span v-if="keyer.holdPreview.value" class="morsey-pulse text-amber-400">{{ keyer.holdPreview.value }}</span>
            <span v-else-if="keyer.keyed.value" class="morsey-pulse text-emerald-400">▊</span>
          </div>
        </div>
      </div>
    </UCard>
  </div>
</template>
