<script setup lang="ts">
import { PHRASE_TIERS, type Phrase } from '~/utils/abbreviations'
import { shuffle, wordPattern } from '~/utils/morse'
import { PHRASE_MASTERY, TIER_UNLOCK } from '~/composables/useProgress'

const { progress, unlockedTierCount, addXp, recordPhraseAnswer } = useProgress()
const audio = useMorseAudio()

const activeTierIndex = ref(0)
onMounted(() => {
  activeTierIndex.value = unlockedTierCount.value - 1
})

const activeTier = computed(() => PHRASE_TIERS[activeTierIndex.value]!)

type AnswerMode = 'choose' | 'type'
const answerMode = ref<AnswerMode>('choose')

type QuizState = 'idle' | 'playing' | 'answering' | 'correct' | 'wrong'
const quizState = ref<QuizState>('idle')
const target = ref<Phrase | null>(null)
const options = ref<Phrase[]>([])
const picked = ref('')
const typed = ref('')
const combo = ref(0)
const lastXpGain = ref(0)
const showStudyList = ref(false)
let advanceTimer: ReturnType<typeof setTimeout> | null = null

function streakFor(item: Phrase) {
  return progress.value.phraseStreaks[item.abbr] ?? 0
}
function isMastered(item: Phrase) {
  return streakFor(item) >= PHRASE_MASTERY
}

function tierMasteredCount(tier: { items: Phrase[] }) {
  return tier.items.filter(isMastered).length
}

function pickPhrase(): Phrase {
  const items = activeTier.value.items
  // Weight unmastered phrases 4x so mastered ones only show up for review
  const weights = items.map(item => (isMastered(item) ? 1 : 4))
  let roll = Math.random() * weights.reduce((a, b) => a + b, 0)
  for (let i = 0; i < items.length; i++) {
    roll -= weights[i]!
    if (roll <= 0 && items[i]!.abbr !== target.value?.abbr) return items[i]!
  }
  return items[Math.floor(Math.random() * items.length)]!
}

function buildOptions(correct: Phrase): Phrase[] {
  const pool = PHRASE_TIERS.slice(0, unlockedTierCount.value)
    .flatMap(t => t.items)
    .filter(p => p.abbr !== correct.abbr)
  return shuffle([correct, ...shuffle(pool).slice(0, 3)])
}

async function playNext() {
  if (advanceTimer) clearTimeout(advanceTimer)
  target.value = pickPhrase()
  options.value = buildOptions(target.value)
  picked.value = ''
  typed.value = ''
  quizState.value = 'playing'
  await audio.playText(target.value.send)
  if (quizState.value === 'playing') quizState.value = 'answering'
}

async function replay() {
  if (!target.value || quizState.value === 'playing') return
  quizState.value = 'playing'
  await audio.playText(target.value.send)
  if (quizState.value === 'playing') quizState.value = 'answering'
}

async function settle(correct: boolean) {
  if (!target.value) return
  recordPhraseAnswer(target.value.abbr, correct)
  if (correct) {
    combo.value++
    if (combo.value > progress.value.bestCombo) progress.value.bestCombo = combo.value
    lastXpGain.value = (answerMode.value === 'type' ? 25 : 15) + Math.min(combo.value, 15)
    addXp(lastXpGain.value)
    quizState.value = 'correct'
    advanceTimer = setTimeout(playNext, 1100)
  } else {
    combo.value = 0
    lastXpGain.value = 0
    quizState.value = 'wrong'
    await audio.playText(target.value.send)
    advanceTimer = setTimeout(playNext, 2000)
  }
}

function choose(option: Phrase) {
  if (quizState.value !== 'answering') return
  picked.value = option.abbr
  settle(option.abbr === target.value?.abbr)
}

function submitTyped() {
  if (quizState.value !== 'answering' || !typed.value.trim()) return
  const guess = typed.value.trim().toUpperCase().replace(/\s+/g, ' ')
  settle(guess === target.value?.abbr)
}

function selectTier(i: number) {
  if (i >= unlockedTierCount.value) return
  activeTierIndex.value = i
  quizState.value = 'idle'
  target.value = null
  audio.stop()
}

onBeforeUnmount(() => {
  if (advanceTimer) clearTimeout(advanceTimer)
  audio.stop()
})
</script>

<template>
  <div class="space-y-6">
    <header>
      <h1 class="text-2xl font-semibold tracking-tight">Ham Phrases</h1>
      <p class="mt-1 text-sm text-zinc-400">
        Q-signals, prosigns, and CW shorthand — hear it on the air before you ever need it.
        Answer a phrase correctly {{ PHRASE_MASTERY }} times in a row to master it;
        master {{ Math.round(TIER_UNLOCK * 100) }}% of a tier to unlock the next.
      </p>
    </header>

    <!-- Tier picker -->
    <div class="flex flex-wrap gap-2">
      <button
        v-for="(tier, i) in PHRASE_TIERS"
        :key="tier.name"
        class="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition"
        :class="[
          i === activeTierIndex ? 'border-emerald-500 bg-emerald-500/10 text-emerald-300' :
          i < unlockedTierCount ? 'border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-zinc-600' :
          'cursor-not-allowed border-zinc-800/60 bg-zinc-900/40 text-zinc-600'
        ]"
        @click="selectTier(i)"
      >
        <UIcon :name="i < unlockedTierCount ? 'i-lucide-unlock' : 'i-lucide-lock'" class="size-3.5" />
        {{ tier.name }}
        <span class="text-xs text-zinc-500">{{ tierMasteredCount(tier) }}/{{ tier.items.length }}</span>
      </button>
    </div>

    <UCard>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div class="font-medium">{{ activeTier.name }}</div>
          <div class="text-sm text-zinc-400">{{ activeTier.description }}</div>
        </div>
        <div class="flex items-center gap-3">
          <span class="text-sm text-amber-400">
            <UIcon name="i-lucide-zap" class="inline size-3.5" /> combo ×{{ combo }}
          </span>
          <div class="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 p-1">
            <UButton
              :variant="answerMode === 'choose' ? 'solid' : 'ghost'"
              :color="answerMode === 'choose' ? 'primary' : 'neutral'"
              size="xs"
              @click="answerMode = 'choose'"
            >
              Multiple choice
            </UButton>
            <UButton
              :variant="answerMode === 'type' ? 'solid' : 'ghost'"
              :color="answerMode === 'type' ? 'primary' : 'neutral'"
              size="xs"
              @click="answerMode = 'type'"
            >
              Type it (+XP)
            </UButton>
          </div>
        </div>
      </div>
      <UProgress
        :model-value="Math.round((tierMasteredCount(activeTier) / activeTier.items.length) * 100)"
        :max="100"
        size="sm"
        class="mt-4"
      />
    </UCard>

    <UCard>
      <div class="flex flex-col items-center gap-6 py-6">
        <div
          class="flex h-20 min-w-40 items-center justify-center rounded-xl border-2 px-6 transition"
          :class="{
            'border-zinc-700': quizState === 'idle',
            'border-emerald-500 morsey-pulse': quizState === 'playing',
            'border-zinc-500': quizState === 'answering',
            'border-emerald-500 bg-emerald-500/10 morsey-good': quizState === 'correct',
            'border-rose-500 bg-rose-500/10 morsey-bad': quizState === 'wrong'
          }"
        >
          <template v-if="quizState === 'correct' || quizState === 'wrong'">
            <div class="text-center">
              <div class="font-mono text-2xl" :class="quizState === 'correct' ? 'text-emerald-300' : 'text-rose-300'">
                {{ target?.abbr }}
              </div>
              <div class="text-xs text-zinc-400">{{ target?.meaning }}</div>
            </div>
          </template>
          <UIcon v-else-if="quizState === 'playing'" name="i-lucide-audio-lines" class="size-8 text-emerald-400" />
          <span v-else class="font-mono text-2xl text-zinc-600">? ? ?</span>
        </div>

        <div class="h-5 text-sm">
          <span v-if="quizState === 'correct'" class="text-emerald-400">Correct! +{{ lastXpGain }} XP</span>
          <span v-else-if="quizState === 'wrong'" class="text-rose-400">
            That was <span class="font-mono font-semibold">{{ target?.abbr }}</span> — hear it again…
          </span>
          <span v-else-if="quizState === 'answering' && answerMode === 'choose'" class="text-zinc-400">What did you hear?</span>
          <span v-else-if="quizState === 'answering'" class="text-zinc-400">Type the abbreviation you heard.</span>
        </div>

        <div class="flex gap-2">
          <UButton
            v-if="quizState === 'idle'"
            color="primary"
            size="lg"
            icon="i-lucide-play"
            @click="playNext"
          >
            Start quiz
          </UButton>
          <template v-else>
            <UButton
              variant="soft" color="neutral" icon="i-lucide-rotate-ccw"
              :disabled="quizState === 'playing'" @click="replay"
            >
              Replay
            </UButton>
            <UButton
              variant="soft" color="neutral" icon="i-lucide-skip-forward"
              :disabled="quizState === 'playing'" @click="playNext"
            >
              Skip
            </UButton>
          </template>
        </div>

        <!-- Multiple choice -->
        <div v-if="answerMode === 'choose'" class="grid w-full max-w-2xl gap-2 sm:grid-cols-2">
          <button
            v-for="option in options"
            :key="option.abbr"
            class="flex items-center justify-between gap-3 rounded-lg border p-3 text-left transition disabled:opacity-40"
            :class="[
              picked === option.abbr && quizState === 'correct' ? 'border-emerald-500 bg-emerald-500/15' :
              picked === option.abbr && quizState === 'wrong' ? 'border-rose-500 bg-rose-500/15' :
              option.abbr === target?.abbr && quizState === 'wrong' ? 'border-emerald-500/60' :
              'border-zinc-800 bg-zinc-900 hover:border-emerald-500/40'
            ]"
            :disabled="quizState !== 'answering'"
            @click="choose(option)"
          >
            <div>
              <div class="font-mono font-semibold text-zinc-100">{{ option.abbr }}</div>
              <div class="text-sm text-zinc-400">{{ option.meaning }}</div>
            </div>
            <UIcon
              v-if="isMastered(option)"
              name="i-lucide-star"
              class="size-4 shrink-0 text-amber-400"
            />
          </button>
        </div>

        <!-- Type it -->
        <div v-else class="flex w-full max-w-md items-center gap-2">
          <input
            v-model="typed"
            type="text"
            autocomplete="off"
            autocapitalize="characters"
            spellcheck="false"
            :disabled="quizState !== 'answering'"
            class="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-center font-mono text-xl uppercase tracking-widest text-zinc-100 outline-none focus:border-emerald-500 disabled:opacity-40"
            placeholder="CQ"
            @keydown.enter="submitTyped"
          >
          <UButton color="primary" :disabled="quizState !== 'answering'" @click="submitTyped">
            Check
          </UButton>
        </div>
      </div>
    </UCard>

    <!-- Study list -->
    <UCard>
      <button
        class="flex w-full items-center justify-between text-left"
        @click="showStudyList = !showStudyList"
      >
        <span class="text-sm font-medium uppercase tracking-wide text-zinc-500">
          Study list — {{ activeTier.name }}
        </span>
        <UIcon :name="showStudyList ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="size-4 text-zinc-500" />
      </button>
      <div v-if="showStudyList" class="mt-4 grid gap-2 sm:grid-cols-2">
        <div
          v-for="item in activeTier.items"
          :key="item.abbr"
          class="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900 p-3"
        >
          <div>
            <div class="flex items-center gap-2">
              <span class="font-mono font-semibold">{{ item.abbr }}</span>
              <UIcon v-if="isMastered(item)" name="i-lucide-star" class="size-3.5 text-amber-400" />
              <span v-else class="text-xs text-zinc-600">{{ streakFor(item) }}/{{ PHRASE_MASTERY }}</span>
            </div>
            <div class="text-sm text-zinc-400">{{ item.meaning }}</div>
            <div class="mt-0.5 font-mono text-xs tracking-widest text-zinc-600">{{ wordPattern(item.send) }}</div>
          </div>
          <UButton
            variant="ghost" color="neutral" icon="i-lucide-volume-2" size="sm"
            @click="audio.playText(item.send)"
          />
        </div>
      </div>
    </UCard>
  </div>
</template>
