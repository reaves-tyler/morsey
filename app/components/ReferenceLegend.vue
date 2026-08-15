<script setup lang="ts">
import { MORSE, KOCH_ORDER, wordPattern } from '~/utils/morse'
import { PHRASE_TIERS } from '~/utils/abbreviations'
import { PHRASE_MASTERY } from '~/composables/useProgress'

const props = defineProps<{
  /** tighter layout for the nav slideover */
  compact?: boolean
}>()

const { progress, unlockedChars } = useProgress()
const audio = useMorseAudio()

const query = ref('')
const order = ref<'abc' | 'koch'>('abc')

const allChars = Object.keys(MORSE)
const letters = allChars.filter(c => /^[A-Z]$/.test(c))
const numbers = allChars.filter(c => /^[0-9]$/.test(c))
const punctuation = allChars.filter(c => !/^[A-Z0-9]$/.test(c))

function kochIndex(char: string): number {
  const i = (KOCH_ORDER as readonly string[]).indexOf(char)
  return i === -1 ? Number.MAX_SAFE_INTEGER : i
}

function sortChars(chars: string[]): string[] {
  return order.value === 'koch'
    ? [...chars].sort((a, b) => kochIndex(a) - kochIndex(b))
    : chars
}

/**
 * A character matches when it equals the query, or — if the query is written
 * in dits and dahs (e.g. ".-") — when its pattern starts with it.
 */
function charMatches(char: string): boolean {
  const q = query.value.trim().toUpperCase()
  if (!q) return true
  if (/^[.\-·−]+$/.test(q)) {
    return MORSE[char]!.startsWith(q.replace(/·/g, '.').replace(/−/g, '-'))
  }
  return char === q || (q.length === 1 && char.includes(q))
}

const charSections = computed(() =>
  [
    { name: 'Letters', chars: sortChars(letters).filter(charMatches) },
    { name: 'Numbers', chars: sortChars(numbers).filter(charMatches) },
    { name: 'Punctuation & signs', chars: sortChars(punctuation).filter(charMatches) }
  ].filter(s => s.chars.length > 0)
)

const phraseSections = computed(() => {
  const q = query.value.trim().toUpperCase()
  return PHRASE_TIERS
    .map(tier => ({
      name: tier.name,
      items: tier.items.filter(item =>
        !q ||
        item.abbr.toUpperCase().includes(q) ||
        item.meaning.toUpperCase().includes(q)
      )
    }))
    .filter(tier => tier.items.length > 0)
})

function isUnlocked(char: string): boolean {
  return unlockedChars.value.includes(char) || kochIndex(char) === Number.MAX_SAFE_INTEGER
}

function isMastered(abbr: string): boolean {
  return (progress.value.phraseStreaks[abbr] ?? 0) >= PHRASE_MASTERY
}

/** Prettier pattern for display: · and − with spaces. */
function prettyPattern(pattern: string): string {
  return pattern.split('').map(el => (el === '.' ? '·' : '−')).join(' ')
}

const charGridClass = computed(() =>
  props.compact
    ? 'grid grid-cols-4 gap-1.5'
    : 'grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-7'
)
const phraseGridClass = computed(() =>
  props.compact ? 'grid gap-1.5' : 'grid gap-2 sm:grid-cols-2'
)
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-col gap-3" :class="compact ? '' : 'sm:flex-row sm:items-center'">
      <div class="relative flex-1">
        <UIcon name="i-lucide-search" class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
        <input
          v-model="query"
          type="text"
          autocomplete="off"
          spellcheck="false"
          :placeholder="compact ? 'Search — try CQ, roger, or .-' : 'Search a character, abbreviation, meaning — or a pattern like .-'"
          class="w-full rounded-lg border border-zinc-800 bg-zinc-900 py-2.5 pl-9 pr-4 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-emerald-500"
        >
      </div>
      <div class="flex shrink-0 items-center gap-2 self-start rounded-lg border border-zinc-800 bg-zinc-900 p-1">
        <UButton
          :variant="order === 'abc' ? 'solid' : 'ghost'"
          :color="order === 'abc' ? 'primary' : 'neutral'"
          size="xs"
          @click="order = 'abc'"
        >
          A–Z
        </UButton>
        <UButton
          :variant="order === 'koch' ? 'solid' : 'ghost'"
          :color="order === 'koch' ? 'primary' : 'neutral'"
          size="xs"
          @click="order = 'koch'"
        >
          Koch
        </UButton>
      </div>
    </div>

    <!-- Characters -->
    <section v-for="section in charSections" :key="section.name" class="space-y-2">
      <h2 class="text-xs font-medium uppercase tracking-wide text-zinc-500">{{ section.name }}</h2>
      <div :class="charGridClass">
        <button
          v-for="char in section.chars"
          :key="char"
          class="group flex flex-col items-center gap-0.5 rounded-lg border py-2 transition"
          :class="isUnlocked(char)
            ? 'border-zinc-800 bg-zinc-900 hover:border-emerald-500/50'
            : 'border-zinc-800/60 bg-zinc-900/40 opacity-60 hover:border-zinc-600 hover:opacity-100'"
          :title="isUnlocked(char) ? `Play ${char}` : `Play ${char} (not yet unlocked in the Koch trainer)`"
          @click="audio.playText(char)"
        >
          <span class="font-mono text-xl" :class="isUnlocked(char) ? 'text-zinc-100' : 'text-zinc-500'">
            {{ char }}
          </span>
          <span class="font-mono text-[11px] tracking-widest" :class="isUnlocked(char) ? 'text-emerald-400' : 'text-zinc-600'">
            {{ prettyPattern(MORSE[char]!) }}
          </span>
        </button>
      </div>
    </section>

    <!-- Phrases -->
    <section v-for="tier in phraseSections" :key="tier.name" class="space-y-2">
      <h2 class="text-xs font-medium uppercase tracking-wide text-zinc-500">{{ tier.name }}</h2>
      <div :class="phraseGridClass">
        <button
          v-for="item in tier.items"
          :key="item.abbr"
          class="group flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900 p-2.5 text-left transition hover:border-emerald-500/50"
          :title="`Play ${item.abbr}`"
          @click="audio.playText(item.send)"
        >
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="font-mono text-sm font-semibold text-zinc-100">{{ item.abbr }}</span>
              <UBadge v-if="item.send.includes('<')" color="neutral" variant="subtle" size="sm">prosign</UBadge>
              <UIcon v-if="isMastered(item.abbr)" name="i-lucide-star" class="size-3 text-amber-400" />
            </div>
            <div class="truncate text-xs text-zinc-400">{{ item.meaning }}</div>
            <div class="mt-0.5 truncate font-mono text-[11px] tracking-widest text-zinc-600">{{ wordPattern(item.send) }}</div>
          </div>
          <UIcon name="i-lucide-volume-2" class="size-3.5 shrink-0 text-zinc-700 transition group-hover:text-emerald-400" />
        </button>
      </div>
    </section>

    <p
      v-if="charSections.length === 0 && phraseSections.length === 0"
      class="py-12 text-center text-sm text-zinc-500"
    >
      Nothing matches “{{ query }}”.
    </p>

    <div class="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-xs text-zinc-500">
      <span class="font-mono text-emerald-400">·</span> dit (1 unit) ·
      <span class="font-mono text-emerald-400">−</span> dah (3 units).
      Gaps: 1 unit inside a character, 3 between characters, 7 between words.
      Prosigns are sent merged, with no gap. Look things up here — but train with your ears.
    </div>
  </div>
</template>
