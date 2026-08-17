<script setup lang="ts">
import { KOCH_ORDER } from '~/utils/morse'

const { progress, level, lifetimeAccuracy } = useProgress()
const audio = useMorseAudio()

// ---- Character accuracy heatmap (sequential: dark → bright emerald) ----------

interface CharCell {
  char: string
  seen: number
  accuracy: number | null
}

const charCells = computed<CharCell[]>(() =>
  (KOCH_ORDER as readonly string[]).map((char) => {
    const s = progress.value.chars[char]
    return {
      char,
      seen: s?.seen ?? 0,
      accuracy: s && s.seen > 0 ? s.correct / s.seen : null
    }
  })
)

/** Sequential emerald ramp on the dark surface: low recedes, high glows. */
const HEAT_RAMP = ['#064e3b', '#047857', '#059669', '#10b981', '#34d399']

function cellStyle(cell: CharCell) {
  if (cell.accuracy === null) return { backgroundColor: '#18181b', color: '#52525b' }
  const idx = Math.min(HEAT_RAMP.length - 1, Math.floor(cell.accuracy * HEAT_RAMP.length))
  return {
    backgroundColor: HEAT_RAMP[idx],
    // bright cells need dark ink
    color: cell.accuracy >= 0.6 ? '#022c22' : '#d4d4d8'
  }
}

// ---- Daily activity (last 30 days, single series) -----------------------------

type Measure = 'answers' | 'xp'
const measure = ref<Measure>('answers')

interface Day {
  key: string
  label: string
  answers: number
  correct: number
  xp: number
}

const days = computed<Day[]>(() => {
  const out: Day[] = []
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000)
    const key = d.toISOString().slice(0, 10)
    const entry = progress.value.history[key]
    out.push({
      key,
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      answers: entry?.answers ?? 0,
      correct: entry?.correct ?? 0,
      xp: entry?.xp ?? 0
    })
  }
  return out
})

const hasActivity = computed(() => days.value.some(d => d.answers > 0 || d.xp > 0))
const maxValue = computed(() => Math.max(1, ...days.value.map(d => d[measure.value])))

// SVG geometry: 30 slots across a 600x150 plot, 2px gaps between bars
const CHART = { w: 600, h: 150, pad: 2 }
const slotW = CHART.w / 30

function barFor(day: Day, i: number) {
  const v = day[measure.value]
  const h = v === 0 ? 0 : Math.max(2, (v / maxValue.value) * (CHART.h - 8))
  return {
    x: i * slotW + CHART.pad / 2,
    width: slotW - CHART.pad,
    y: CHART.h - h,
    height: h
  }
}

const activeDays = computed(() => days.value.filter(d => d.answers > 0).length)
const showTable = ref(false)
</script>

<template>
  <div class="space-y-8">
    <header>
      <h1 class="text-2xl font-semibold tracking-tight">Stats</h1>
      <p class="mt-1 text-sm text-zinc-400">Your copy accuracy per character and practice activity over time.</p>
    </header>

    <!-- Headline tiles -->
    <section class="grid grid-cols-2 gap-3 sm:grid-cols-5">
      <UCard v-for="tile in [
        { label: 'Level', value: String(level), sub: `${progress.xp} XP` },
        { label: 'Streak', value: `${progress.streakDays}d`, sub: 'daily practice' },
        { label: 'Accuracy', value: `${lifetimeAccuracy}%`, sub: 'lifetime' },
        { label: 'Answers', value: String(progress.totalAnswers), sub: 'all time' },
        { label: 'Best combo', value: `×${progress.bestCombo}`, sub: 'in a row' }
      ]" :key="tile.label">
        <div class="text-xs uppercase tracking-wide text-zinc-500">{{ tile.label }}</div>
        <div class="mt-1 text-2xl font-semibold text-zinc-100">{{ tile.value }}</div>
        <div class="text-xs text-zinc-600">{{ tile.sub }}</div>
      </UCard>
    </section>

    <!-- Character heatmap -->
    <section class="space-y-3">
      <div class="flex flex-wrap items-end justify-between gap-2">
        <h2 class="text-sm font-medium uppercase tracking-wide text-zinc-500">
          Character accuracy — Koch order, click to hear
        </h2>
        <div class="flex items-center gap-1.5 text-[11px] text-zinc-500">
          0%
          <span v-for="c in HEAT_RAMP" :key="c" class="size-3 rounded-sm" :style="{ backgroundColor: c }" />
          100%
        </div>
      </div>
      <div class="flex flex-wrap gap-1.5">
        <button
          v-for="cell in charCells"
          :key="cell.char"
          class="flex size-11 flex-col items-center justify-center rounded-md font-mono transition hover:ring-1 hover:ring-emerald-400/60"
          :style="cellStyle(cell)"
          :title="cell.accuracy === null
            ? `${cell.char} — no attempts yet`
            : `${cell.char} — ${Math.round(cell.accuracy * 100)}% over ${cell.seen} attempts`"
          @click="audio.playText(cell.char)"
        >
          <span class="text-base leading-none">{{ cell.char }}</span>
          <span class="mt-0.5 text-[9px] leading-none opacity-80">
            {{ cell.accuracy === null ? '·' : Math.round(cell.accuracy * 100) + '%' }}
          </span>
        </button>
      </div>
    </section>

    <!-- Daily activity -->
    <section class="space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-sm font-medium uppercase tracking-wide text-zinc-500">
          Last 30 days — {{ activeDays }} active
        </h2>
        <div class="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900 p-0.5">
          <UButton
            v-for="m in (['answers', 'xp'] as const)"
            :key="m"
            :variant="measure === m ? 'solid' : 'ghost'"
            :color="measure === m ? 'primary' : 'neutral'"
            size="xs"
            @click="measure = m"
          >
            {{ m === 'answers' ? 'Answers' : 'XP' }}
          </UButton>
        </div>
      </div>

      <UCard>
        <p v-if="!hasActivity" class="py-8 text-center text-sm text-zinc-600">
          No activity yet — go answer something in the trainer.
        </p>
        <template v-else>
          <svg :viewBox="`0 0 ${CHART.w} ${CHART.h + 22}`" class="w-full" role="img" aria-label="Daily practice activity">
            <!-- hairline gridlines -->
            <line v-for="f in [0.25, 0.5, 0.75]" :key="f" :x1="0" :x2="CHART.w" :y1="CHART.h * f" :y2="CHART.h * f" stroke="#27272a" stroke-width="1" />
            <!-- baseline -->
            <line :x1="0" :x2="CHART.w" :y1="CHART.h" :y2="CHART.h" stroke="#3f3f46" stroke-width="1" />
            <g v-for="(day, i) in days" :key="day.key">
              <rect
                v-bind="barFor(day, i)"
                rx="2"
                fill="#10b981"
                class="transition-opacity hover:opacity-75"
              >
                <title>{{ day.label }} — {{ day.answers }} answers, {{ day.answers ? Math.round((day.correct / day.answers) * 100) + '% correct, ' : '' }}{{ day.xp }} XP</title>
              </rect>
              <text
                v-if="i % 5 === 4"
                :x="i * slotW + slotW / 2"
                :y="CHART.h + 15"
                text-anchor="middle"
                fill="#71717a"
                font-size="10"
                font-family="ui-monospace, monospace"
              >{{ day.label }}</text>
            </g>
          </svg>
          <div class="mt-1 text-right font-mono text-xs text-zinc-600">
            peak {{ maxValue }} {{ measure === 'answers' ? 'answers' : 'XP' }}/day
          </div>
        </template>
      </UCard>

      <!-- Table view (accessibility fallback) -->
      <button
        class="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"
        @click="showTable = !showTable"
      >
        <UIcon :name="showTable ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="size-3.5" />
        {{ showTable ? 'Hide' : 'Show' }} data table
      </button>
      <UCard v-if="showTable">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-xs uppercase tracking-wide text-zinc-500">
              <th class="pb-2">Day</th><th class="pb-2 text-right">Answers</th>
              <th class="pb-2 text-right">Correct</th><th class="pb-2 text-right">XP</th>
            </tr>
          </thead>
          <tbody class="font-mono tabular-nums">
            <tr v-for="day in [...days].reverse().filter(d => d.answers > 0 || d.xp > 0)" :key="day.key" class="border-t border-zinc-800/60">
              <td class="py-1.5 text-zinc-400">{{ day.key }}</td>
              <td class="py-1.5 text-right">{{ day.answers }}</td>
              <td class="py-1.5 text-right">{{ day.correct }}</td>
              <td class="py-1.5 text-right">{{ day.xp }}</td>
            </tr>
          </tbody>
        </table>
      </UCard>
    </section>
  </div>
</template>
