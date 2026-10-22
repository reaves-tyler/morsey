<script setup lang="ts">
/**
 * Live keyword feed under the decode terminal (see utils/cwFeed.ts): the
 * callsigns, Q-signals, RST reports, prosigns and abbreviations copied so far,
 * newest at the top, each with its meaning and the dit/dah pattern to send it
 * back. Rows reuse CwHighlightedText so the colour, the hover tip and the QRZ
 * link are exactly what the terminal shows. The kind chips filter the feed —
 * the point is to pull a signal report or a callsign out of an exchange.
 */
import { keywordFeed, type FeedKind } from '~/utils/cwFeed'

const props = defineProps<{ text: string }>()

const KINDS: { kind: FeedKind; label: string; cls: string; dot: string }[] = [
  { kind: 'callsign', label: 'Callsign', cls: 'text-amber-300', dot: 'bg-amber-300' },
  { kind: 'rst', label: 'RST', cls: 'text-sky-300', dot: 'bg-sky-300' },
  { kind: 'qsignal', label: 'Q-signal', cls: 'text-cyan-300', dot: 'bg-cyan-300' },
  { kind: 'prosign', label: 'Prosign', cls: 'text-violet-300', dot: 'bg-violet-300' },
  { kind: 'abbr', label: 'Abbreviation', cls: 'text-emerald-400', dot: 'bg-emerald-400' },
  { kind: 'unknown', label: 'Unknown', cls: 'text-zinc-500', dot: 'bg-zinc-500' }
]
const LABEL = Object.fromEntries(KINDS.map(k => [k.kind, k.label])) as Record<FeedKind, string>
const CHIP = Object.fromEntries(KINDS.map(k => [k.kind, k.cls])) as Record<FeedKind, string>

/** empty = everything */
const only = ref<Set<FeedKind>>(new Set())
function toggle(kind: FeedKind) {
  const next = new Set(only.value)
  if (next.has(kind)) next.delete(kind)
  else next.add(kind)
  only.value = next
}

const feed = computed(() => keywordFeed(props.text))
const shown = computed(() => (only.value.size ? feed.value.filter(f => only.value.has(f.kind)) : feed.value))
</script>

<template>
  <div>
    <div class="mb-2 flex flex-wrap items-center gap-1.5">
      <button
        v-for="k in KINDS"
        :key="k.kind"
        type="button"
        class="flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition"
        :class="only.has(k.kind)
          ? 'border-zinc-500 bg-zinc-800 text-zinc-100'
          : only.size ? 'border-zinc-800 text-zinc-600 hover:text-zinc-400' : 'border-zinc-800 text-zinc-400 hover:text-zinc-200'"
        :aria-pressed="only.has(k.kind)"
        :title="`Show only ${k.label.toLowerCase()}s`"
        @click="toggle(k.kind)"
      >
        <span class="size-1.5 rounded-full" :class="k.dot" />{{ k.label }}
      </button>
      <span class="ml-auto font-mono text-[10px] text-zinc-600">{{ shown.length }} / {{ feed.length }}</span>
    </div>
    <ol v-if="shown.length" class="max-h-80 divide-y divide-zinc-800/80 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950" aria-live="polite">
      <li v-for="f in shown" :key="f.id" class="grid grid-cols-[auto_1fr] items-baseline gap-x-3 px-3 py-1.5 sm:grid-cols-[7rem_auto_1fr]">
        <span class="hidden font-mono text-[10px] uppercase tracking-wider sm:inline" :class="CHIP[f.kind]">{{ LABEL[f.kind] }}</span>
        <span class="font-mono text-base whitespace-nowrap">
          <CwHighlightedText :text="f.text" /><span v-if="f.count > 1" class="ml-1 text-xs text-zinc-500">×{{ f.count }}</span>
        </span>
        <span class="min-w-0 text-sm text-zinc-400">
          {{ f.tip }}
          <span v-if="f.kind !== 'unknown'" class="ml-2 font-mono text-xs tracking-widest text-zinc-500" :title="`Send: ${f.pattern}`">{{ f.pattern }}</span>
        </span>
      </li>
    </ol>
    <p v-else class="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-4 text-sm text-zinc-600">
      {{ feed.length ? 'Nothing of that kind yet.' : 'Callsigns, signal reports, Q-signals, prosigns, shorthand — and any pattern that matched no letter, with what it could have been — will line up here as they are copied.' }}
    </p>
  </div>
</template>
