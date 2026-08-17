<script setup lang="ts">
import { KOCH_ORDER, TOTAL_LESSONS } from '~/utils/morse'
import { PHRASE_TIERS } from '~/utils/abbreviations'
import { KEY_TYPE_LABELS } from '~/composables/useProgress'

const {
  progress, level, levelProgress, xpToNextLevel, unlockedChars,
  kochWindowAccuracy, kochComplete, masteredPhrases, unlockedTierCount,
  lifetimeAccuracy, weakestChars
} = useProgress()
const audio = useMorseAudio()

const totalPhrases = PHRASE_TIERS.reduce((n, t) => n + t.items.length, 0)

const modules = computed(() => [
  {
    to: '/learn',
    icon: 'i-lucide-graduation-cap',
    title: 'Koch Trainer',
    subtitle: kochComplete.value
      ? 'All 41 characters unlocked — keep drilling!'
      : `Lesson ${progress.value.koch.lesson} of ${TOTAL_LESSONS} · ${unlockedChars.value.length} characters unlocked`,
    stat: `${Math.round(kochWindowAccuracy.value * 100)}%`,
    statLabel: 'recent accuracy'
  },
  {
    to: '/phrases',
    icon: 'i-lucide-message-square-code',
    title: 'Ham Phrases',
    subtitle: `Tier ${unlockedTierCount.value} of ${PHRASE_TIERS.length} · Q-signals, prosigns & abbreviations`,
    stat: `${masteredPhrases.value.length}/${totalPhrases}`,
    statLabel: 'mastered'
  },
  {
    to: '/send',
    icon: 'i-lucide-radio-tower',
    title: 'Sending Practice',
    subtitle: 'Key with your keyboard, screen, or a USB paddle',
    stat: KEY_TYPE_LABELS[progress.value.settings.keyType],
    statLabel: 'key type'
  },
  {
    to: '/qso',
    icon: 'i-lucide-antenna',
    title: 'QSO Simulator',
    subtitle: 'A complete first contact — CQ to 73, both directions',
    stat: progress.value.settings.myCall,
    statLabel: 'your call'
  },
  {
    to: '/stats',
    icon: 'i-lucide-activity',
    title: 'Stats',
    subtitle: 'Per-character accuracy heatmap and daily activity',
    stat: `${lifetimeAccuracy.value}%`,
    statLabel: 'lifetime'
  }
])
</script>

<template>
  <div class="space-y-8">
    <section>
      <h1 class="text-2xl font-semibold tracking-tight">
        Operator dashboard
      </h1>
      <p class="mt-1 text-sm text-zinc-400">
        Train your ears daily. Characters at full speed, spacing that grows with you.
      </p>
    </section>

    <section class="grid gap-4 sm:grid-cols-3">
      <UCard>
        <div class="flex items-center justify-between">
          <div>
            <div class="text-xs uppercase tracking-wide text-zinc-500">Level</div>
            <div class="mt-1 text-3xl font-semibold text-emerald-400">{{ level }}</div>
            <div class="mt-1 text-xs text-zinc-500">{{ xpToNextLevel }} XP to next level</div>
          </div>
          <UIcon name="i-lucide-trophy" class="size-8 text-emerald-500/50" />
        </div>
        <UProgress :model-value="levelProgress" :max="100" size="sm" class="mt-3" />
      </UCard>

      <UCard>
        <div class="flex items-center justify-between">
          <div>
            <div class="text-xs uppercase tracking-wide text-zinc-500">Daily streak</div>
            <div class="mt-1 text-3xl font-semibold text-amber-400">
              {{ progress.streakDays }}<span class="text-base text-zinc-500"> days</span>
            </div>
            <div class="mt-1 text-xs text-zinc-500">
              {{ progress.lastPracticeDay ? `Last practice ${progress.lastPracticeDay}` : 'Answer anything to start' }}
            </div>
          </div>
          <UIcon name="i-lucide-flame" class="size-8 text-amber-500/50" />
        </div>
      </UCard>

      <UCard>
        <div class="flex items-center justify-between">
          <div>
            <div class="text-xs uppercase tracking-wide text-zinc-500">Lifetime accuracy</div>
            <div class="mt-1 text-3xl font-semibold">{{ lifetimeAccuracy }}%</div>
            <div class="mt-1 text-xs text-zinc-500">{{ progress.totalAnswers }} answers · best combo {{ progress.bestCombo }}</div>
          </div>
          <UIcon name="i-lucide-target" class="size-8 text-zinc-600" />
        </div>
      </UCard>
    </section>

    <section class="grid gap-4 md:grid-cols-3">
      <NuxtLink v-for="mod in modules" :key="mod.to" :to="mod.to" class="group">
        <UCard class="h-full transition group-hover:ring-emerald-500/50">
          <div class="flex items-start justify-between">
            <UIcon :name="mod.icon" class="size-6 text-emerald-400" />
            <UIcon name="i-lucide-arrow-right" class="size-4 text-zinc-600 transition group-hover:translate-x-1 group-hover:text-emerald-400" />
          </div>
          <h2 class="mt-3 font-semibold">{{ mod.title }}</h2>
          <p class="mt-1 text-sm text-zinc-400">{{ mod.subtitle }}</p>
          <div class="mt-4 text-2xl font-semibold text-zinc-200">
            {{ mod.stat }}
            <span class="text-xs font-normal text-zinc-500">{{ mod.statLabel }}</span>
          </div>
        </UCard>
      </NuxtLink>
    </section>

    <section v-if="weakestChars.length" class="space-y-3">
      <h2 class="text-sm font-medium uppercase tracking-wide text-zinc-500">Weakest characters — click to hear</h2>
      <div class="flex flex-wrap gap-2">
        <button
          v-for="w in weakestChars"
          :key="w.char"
          class="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono transition hover:border-emerald-500/50"
          @click="audio.playText(w.char)"
        >
          <span class="text-lg">{{ w.char }}</span>
          <span class="text-xs text-rose-400">{{ Math.round(w.accuracy * 100) }}%</span>
          <UIcon name="i-lucide-volume-2" class="size-3.5 text-zinc-500" />
        </button>
      </div>
    </section>

    <section class="space-y-3">
      <h2 class="text-sm font-medium uppercase tracking-wide text-zinc-500">
        Character progression ({{ unlockedChars.length }} / {{ KOCH_ORDER.length }})
      </h2>
      <div class="flex flex-wrap gap-1.5">
        <span
          v-for="(char, i) in KOCH_ORDER"
          :key="char"
          class="flex size-8 items-center justify-center rounded-md font-mono text-sm"
          :class="i < unlockedChars.length
            ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30'
            : 'bg-zinc-900 text-zinc-600'"
        >
          {{ char }}
        </span>
      </div>
    </section>
  </div>
</template>
