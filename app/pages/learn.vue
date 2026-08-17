<script setup lang="ts">
import { TOTAL_LESSONS, patternFor } from '~/utils/morse'
import { wordsFor } from '~/utils/words'
import { generateCallsign, callsignsAvailable } from '~/utils/callsigns'
import { UNLOCK_WINDOW } from '~/composables/useProgress'

const {
  progress, unlockedChars, kochWindowAccuracy, canAdvance, kochComplete,
  addXp, recordCharAnswer, advanceLesson
} = useProgress()
const audio = useMorseAudio()

type Mode = 'choose' | 'copy' | 'words' | 'calls'
const mode = ref<Mode>('choose')

// Word/callsign availability grows with the Koch progression
const unlockedLetters = computed(() => unlockedChars.value.filter(c => /^[A-Z]$/.test(c)))
const availableWords = computed(() => wordsFor(unlockedLetters.value))
const wordsReady = computed(() => availableWords.value.length >= 5)
const callsReady = computed(() => callsignsAvailable(unlockedChars.value))

const MODE_TABS: { key: Mode, label: string }[] = [
  { key: 'choose', label: 'Listen & Choose' },
  { key: 'copy', label: 'Copy Groups' },
  { key: 'words', label: 'Words' },
  { key: 'calls', label: 'Callsigns' }
]

function modeReady(m: Mode): boolean {
  if (m === 'words') return wordsReady.value
  if (m === 'calls') return callsReady.value
  return true
}

function modeHint(m: Mode): string {
  if (m === 'words' && !wordsReady.value) return 'Unlock more letters first'
  if (m === 'calls' && !callsReady.value) return 'Needs a digit — keep going in the Koch order'
  return ''
}

const combo = ref(0)
const sessionCorrect = ref(0)
const sessionTotal = ref(0)
const lastXpGain = ref(0)

// ---- Listen & Choose mode --------------------------------------------------

type ChooseState = 'idle' | 'playing' | 'answering' | 'correct' | 'wrong'
const chooseState = ref<ChooseState>('idle')
const target = ref('')
const pickedAnswer = ref('')
let advanceTimer: ReturnType<typeof setTimeout> | null = null

function pickChar(): string {
  const chars = unlockedChars.value
  // 20% bias toward the newest character so fresh material gets reps
  if (chars.length > 2 && Math.random() < 0.2) {
    const newest = chars[chars.length - 1]!
    if (newest !== target.value) return newest
  }
  // Otherwise weight by error rate so weak characters come up more
  const candidates = chars.filter(c => chars.length <= 2 || c !== target.value)
  const weights = candidates.map((c) => {
    const s = progress.value.chars[c]
    const errorRate = s && s.seen > 0 ? 1 - s.correct / s.seen : 0.5
    return 1 + 3 * errorRate
  })
  let roll = Math.random() * weights.reduce((a, b) => a + b, 0)
  for (let i = 0; i < candidates.length; i++) {
    roll -= weights[i]!
    if (roll <= 0) return candidates[i]!
  }
  return candidates[candidates.length - 1]!
}

async function playNext() {
  if (advanceTimer) clearTimeout(advanceTimer)
  target.value = pickChar()
  pickedAnswer.value = ''
  chooseState.value = 'playing'
  await audio.playText(target.value)
  if (chooseState.value === 'playing') chooseState.value = 'answering'
}

async function replay() {
  if (!target.value || chooseState.value === 'playing') return
  chooseState.value = 'playing'
  await audio.playText(target.value)
  if (chooseState.value === 'playing') chooseState.value = 'answering'
}

const answerable = computed(() =>
  // 'playing' included: answer the instant you recognize the sound, without
  // waiting for playback (and its trailing buffer) to finish
  chooseState.value === 'answering' || chooseState.value === 'playing'
)

async function answer(char: string) {
  if (!answerable.value) return
  audio.stop() // cut any in-flight playback when answering early
  pickedAnswer.value = char
  const correct = char === target.value
  sessionTotal.value++
  recordCharAnswer(target.value, correct)

  if (correct) {
    combo.value++
    if (combo.value > progress.value.bestCombo) progress.value.bestCombo = combo.value
    sessionCorrect.value++
    lastXpGain.value = 10 + Math.min(combo.value, 15)
    addXp(lastXpGain.value)
    chooseState.value = 'correct'
    audio.playCue('good')
    advanceTimer = setTimeout(playNext, 700)
  } else {
    combo.value = 0
    lastXpGain.value = 0
    chooseState.value = 'wrong'
    // Distinct buzz first (so eyes-free you know it was a miss), then echo
    // the character it actually was so the sound gets re-associated
    audio.playCue('bad')
    await new Promise(r => setTimeout(r, 300))
    if (chooseState.value !== 'wrong') return
    await audio.playText(target.value)
    advanceTimer = setTimeout(playNext, 1400)
  }
}

// Answer with the keyboard too
function onKeydown(e: KeyboardEvent) {
  if (mode.value !== 'choose') return
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const key = e.key.toUpperCase()
  if (answerable.value && unlockedChars.value.includes(key)) {
    e.preventDefault()
    answer(key)
  } else if (e.code === 'Space' && (chooseState.value === 'idle' || chooseState.value === 'answering')) {
    e.preventDefault()
    chooseState.value === 'idle' ? playNext() : replay()
  }
}

// ---- Typed modes: copy groups, words, callsigns -------------------------------

type CopyState = 'idle' | 'playing' | 'typing' | 'result'
const copyState = ref<CopyState>('idle')
const copyTarget = ref('')
const copyInput = ref('')
const copyResults = ref<{ char: string; typed: string; correct: boolean }[]>([])

/** All-correct bonus scales with difficulty. */
const ALL_CORRECT_BONUS: Record<string, number> = { copy: 25, words: 30, calls: 50 }

function makeTarget(): string {
  if (mode.value === 'words') {
    const pool = availableWords.value
    let word = pool[Math.floor(Math.random() * pool.length)]!
    if (pool.length > 1) {
      while (word === copyTarget.value) word = pool[Math.floor(Math.random() * pool.length)]!
    }
    return word
  }
  if (mode.value === 'calls') {
    return generateCallsign(unlockedChars.value)?.call ?? ''
  }
  const size = progress.value.settings.groupSize
  let out = ''
  for (let i = 0; i < size; i++) out += pickChar()
  return out
}

async function playGroup() {
  copyTarget.value = makeTarget()
  copyInput.value = ''
  copyResults.value = []
  copyState.value = 'playing'
  // characters are separated by standard Farnsworth char gaps
  await audio.playText(copyTarget.value)
  if (copyState.value === 'playing') copyState.value = 'typing'
}

async function replayGroup() {
  if (!copyTarget.value) return
  copyState.value = 'playing'
  await audio.playText(copyTarget.value)
  if (copyState.value === 'playing') copyState.value = 'typing'
}

function submitCopy() {
  if (copyState.value !== 'typing') return
  const typed = copyInput.value.toUpperCase().replace(/\s/g, '')
  const results = copyTarget.value.split('').map((char, i) => ({
    char,
    typed: typed[i] ?? '·',
    correct: typed[i] === char
  }))
  copyResults.value = results
  let gained = 0
  for (const r of results) {
    recordCharAnswer(r.char, r.correct)
    sessionTotal.value++
    if (r.correct) {
      sessionCorrect.value++
      gained += 10
    }
  }
  const allCorrect = results.every(r => r.correct)
  if (allCorrect) {
    combo.value++
    gained += ALL_CORRECT_BONUS[mode.value] ?? 25
    if (combo.value > progress.value.bestCombo) progress.value.bestCombo = combo.value
  } else {
    combo.value = 0
  }
  lastXpGain.value = gained
  if (gained > 0) addXp(gained)
  copyState.value = 'result'
}

// ---- Lesson unlock -----------------------------------------------------------

const justUnlocked = ref('')

function switchMode(m: Mode) {
  mode.value = m
  copyState.value = 'idle'
  copyTarget.value = ''
  audio.stop()
}

function unlockNext() {
  advanceLesson()
  justUnlocked.value = unlockedChars.value[unlockedChars.value.length - 1] ?? ''
  chooseState.value = 'idle'
  copyState.value = 'idle'
  audio.playText(justUnlocked.value)
}

const windowFill = computed(() =>
  Math.min(100, Math.round((progress.value.koch.window.length / UNLOCK_WINDOW) * 100))
)
const accuracyPct = computed(() => Math.round(kochWindowAccuracy.value * 100))

const sessionAccuracy = computed(() =>
  sessionTotal.value === 0 ? 100 : Math.round((sessionCorrect.value / sessionTotal.value) * 100)
)

// Answer grid stays in fixed Koch order so the eyes always know where each
// character lives — the challenge should be in the ears, not a button hunt.
const gridChars = computed(() => unlockedChars.value)

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  if (advanceTimer) clearTimeout(advanceTimer)
  audio.stop()
})
</script>

<template>
  <div class="space-y-6">
    <header class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">Koch Trainer</h1>
        <p class="mt-1 text-sm text-zinc-400">
          <template v-if="kochComplete">All characters unlocked — drill to build speed.</template>
          <template v-else>
            Lesson {{ progress.koch.lesson }} / {{ TOTAL_LESSONS }} —
            reach 90% over your last {{ UNLOCK_WINDOW }} answers to unlock the next character.
          </template>
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900 p-1">
        <UButton
          v-for="tab in MODE_TABS"
          :key="tab.key"
          :variant="mode === tab.key ? 'solid' : 'ghost'"
          :color="mode === tab.key ? 'primary' : 'neutral'"
          size="sm"
          :disabled="!modeReady(tab.key)"
          :title="modeHint(tab.key)"
          @click="switchMode(tab.key)"
        >
          {{ tab.label }}
        </UButton>
      </div>
    </header>

    <!-- Unlock banner -->
    <UCard v-if="canAdvance" class="ring-1 ring-emerald-500/40">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-3">
          <UIcon name="i-lucide-party-popper" class="size-6 text-emerald-400" />
          <div>
            <div class="font-medium text-emerald-300">Character mastered — {{ accuracyPct }}% accuracy!</div>
            <div class="text-sm text-zinc-400">Ready to add the next character to your alphabet.</div>
          </div>
        </div>
        <UButton color="primary" icon="i-lucide-unlock" @click="unlockNext">
          Unlock next character
        </UButton>
      </div>
    </UCard>

    <!-- New character intro -->
    <UCard v-if="justUnlocked" class="ring-1 ring-indigo-500/40">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-4">
          <span class="flex size-14 items-center justify-center rounded-xl bg-indigo-500/15 font-mono text-3xl text-indigo-300">
            {{ justUnlocked }}
          </span>
          <div>
            <div class="font-medium">New character: {{ justUnlocked }}</div>
            <div class="font-mono text-sm tracking-[0.3em] text-indigo-300">{{ patternFor(justUnlocked) }}</div>
            <div class="mt-1 text-xs text-zinc-500">Listen a few times, then forget the pattern — trust your ears.</div>
          </div>
        </div>
        <div class="flex gap-2">
          <UButton variant="soft" color="neutral" icon="i-lucide-volume-2" @click="audio.playText(justUnlocked)">
            Play again
          </UButton>
          <UButton color="primary" icon="i-lucide-check" @click="justUnlocked = ''">
            Got it
          </UButton>
        </div>
      </div>
    </UCard>

    <!-- Progress toward unlock -->
    <div class="grid gap-4 sm:grid-cols-3">
      <UCard>
        <div class="text-xs uppercase tracking-wide text-zinc-500">Rolling accuracy</div>
        <div class="mt-1 text-2xl font-semibold" :class="accuracyPct >= 90 ? 'text-emerald-400' : 'text-zinc-200'">
          {{ accuracyPct }}<span class="text-sm text-zinc-500">% / 90%</span>
        </div>
        <UProgress :model-value="accuracyPct" :max="100" size="sm" class="mt-2" />
      </UCard>
      <UCard>
        <div class="text-xs uppercase tracking-wide text-zinc-500">Window filled</div>
        <div class="mt-1 text-2xl font-semibold">
          {{ progress.koch.window.length }}<span class="text-sm text-zinc-500"> / {{ UNLOCK_WINDOW }}</span>
        </div>
        <UProgress :model-value="windowFill" :max="100" size="sm" class="mt-2" color="neutral" />
      </UCard>
      <UCard>
        <div class="text-xs uppercase tracking-wide text-zinc-500">Session</div>
        <div class="mt-1 flex items-baseline gap-3">
          <span class="text-2xl font-semibold">{{ sessionAccuracy }}%</span>
          <span class="text-sm text-amber-400">
            <UIcon name="i-lucide-zap" class="inline size-3.5" /> combo ×{{ combo }}
          </span>
        </div>
        <div class="mt-2 text-xs text-zinc-500">{{ sessionCorrect }} / {{ sessionTotal }} correct</div>
      </UCard>
    </div>

    <!-- LISTEN & CHOOSE -->
    <UCard v-if="mode === 'choose'">
      <div class="flex flex-col items-center gap-6 py-6">
        <div
          class="flex size-24 items-center justify-center rounded-full border-2 font-mono text-4xl transition"
          :class="{
            'border-zinc-700 text-zinc-600': chooseState === 'idle',
            'border-emerald-500 text-emerald-400 morsey-pulse': chooseState === 'playing',
            'border-zinc-500 text-zinc-500': chooseState === 'answering',
            'border-emerald-500 bg-emerald-500/10 text-emerald-300 morsey-good': chooseState === 'correct',
            'border-rose-500 bg-rose-500/10 text-rose-300 morsey-bad': chooseState === 'wrong'
          }"
        >
          <template v-if="chooseState === 'correct' || chooseState === 'wrong'">{{ target }}</template>
          <template v-else-if="chooseState === 'playing'">
            <UIcon name="i-lucide-audio-lines" class="size-10" />
          </template>
          <template v-else>?</template>
        </div>

        <div class="h-5 text-sm">
          <span v-if="chooseState === 'correct'" class="text-emerald-400">Correct! +{{ lastXpGain }} XP</span>
          <span v-else-if="chooseState === 'wrong'" class="text-rose-400">
            It was <span class="font-mono font-semibold">{{ target }}</span> — listen again…
          </span>
          <span v-else-if="chooseState === 'answering'" class="text-zinc-400">Which character was that?</span>
          <span v-else-if="chooseState === 'playing'" class="text-zinc-500">Listening…</span>
          <span v-else class="text-zinc-500">Press start (or hit space) and identify what you hear.</span>
        </div>

        <div class="flex gap-2">
          <UButton
            v-if="chooseState === 'idle'"
            color="primary"
            size="lg"
            icon="i-lucide-play"
            @click="playNext"
          >
            Start training
          </UButton>
          <template v-else>
            <UButton
              variant="soft"
              color="neutral"
              icon="i-lucide-rotate-ccw"
              :disabled="chooseState === 'playing'"
              @click="replay"
            >
              Replay
            </UButton>
            <UButton
              variant="soft"
              color="neutral"
              icon="i-lucide-skip-forward"
              :disabled="chooseState === 'playing'"
              @click="playNext"
            >
              Skip
            </UButton>
          </template>
        </div>

        <div class="grid w-full max-w-xl grid-cols-5 gap-2 sm:grid-cols-7">
          <button
            v-for="char in gridChars"
            :key="char"
            class="flex h-12 items-center justify-center rounded-lg border font-mono text-lg transition disabled:opacity-40"
            :class="[
              pickedAnswer === char && chooseState === 'correct' ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300' :
              pickedAnswer === char && chooseState === 'wrong' ? 'border-rose-500 bg-rose-500/15 text-rose-300' :
              char === target && chooseState === 'wrong' ? 'border-emerald-500/60 text-emerald-400' :
              'border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-emerald-500/40 hover:text-emerald-300'
            ]"
            :disabled="!answerable"
            @click="answer(char)"
          >
            {{ char }}
          </button>
        </div>
        <p class="max-w-md text-center text-xs text-zinc-600">
          Best trained eyes-free: type the letter on your keyboard the moment you recognize it —
          a chirp means correct, a low buzz means wrong (the missed character replays).
          Space starts/replays.
        </p>
      </div>
    </UCard>

    <!-- TYPED MODES: copy groups / words / callsigns -->
    <UCard v-else>
      <div class="flex flex-col items-center gap-6 py-6">
        <p class="max-w-md text-center text-sm text-zinc-400">
          <template v-if="mode === 'copy'">
            A random group of {{ progress.settings.groupSize }} characters plays with Farnsworth spacing.
            Type what you hear, then submit.
          </template>
          <template v-else-if="mode === 'words'">
            A real word plays — hear the rhythm of the whole word, not the letters.
            {{ availableWords.length }} words available from your unlocked letters.
          </template>
          <template v-else>
            A realistic callsign plays, built from real ITU country prefixes.
            Copying calls is the first skill you need on the air.
          </template>
        </p>

        <div v-if="copyState === 'result'" class="flex gap-2 font-mono text-2xl">
          <div v-for="(r, i) in copyResults" :key="i" class="flex flex-col items-center gap-1">
            <span :class="r.correct ? 'text-emerald-400' : 'text-rose-400 line-through'">{{ r.typed }}</span>
            <span v-if="!r.correct" class="text-sm text-zinc-500">{{ r.char }}</span>
          </div>
        </div>

        <UIcon
          v-if="copyState === 'playing'"
          name="i-lucide-audio-lines"
          class="morsey-pulse size-10 text-emerald-400"
        />

        <input
          v-if="copyState === 'typing' || copyState === 'playing'"
          v-model="copyInput"
          type="text"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          :maxlength="copyTarget.length || progress.settings.groupSize"
          class="w-72 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-center font-mono text-2xl uppercase tracking-[0.4em] text-zinc-100 outline-none focus:border-emerald-500"
          placeholder="·····"
          @keydown.enter="submitCopy"
        >

        <div class="h-5 text-sm">
          <span v-if="copyState === 'result' && lastXpGain > 0" class="text-emerald-400">+{{ lastXpGain }} XP</span>
          <span v-else-if="copyState === 'result'" class="text-rose-400">Keep at it — replay and try a new group.</span>
        </div>

        <div class="flex gap-2">
          <UButton
            v-if="copyState === 'idle' || copyState === 'result'"
            color="primary"
            size="lg"
            icon="i-lucide-play"
            @click="playGroup"
          >
            {{ copyState === 'idle' ? 'Play' : 'Next' }}
          </UButton>
          <template v-if="copyState === 'typing'">
            <UButton variant="soft" color="neutral" icon="i-lucide-rotate-ccw" @click="replayGroup">Replay</UButton>
            <UButton color="primary" icon="i-lucide-check" @click="submitCopy">Submit</UButton>
          </template>
        </div>
      </div>
    </UCard>
  </div>
</template>
