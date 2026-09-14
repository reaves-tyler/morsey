<script setup lang="ts">
/**
 * Decoded CW with syntax highlighting (see utils/cwHighlight.ts): prosigns,
 * Q-signals, RST reports, abbreviations and callsigns each get a colour, and
 * hovering any of them shows its meaning at once.
 *
 * Every token is rendered as the exact text the decoder produced — a
 * prosign is the literal `<KN>`, just coloured — so the terminal never turns
 * copy into icons or labels. The only substitution is the decoder's `*`
 * (pattern matched no character), drawn as a dim dot like the keyer pages.
 *
 * The tooltip is one fixed-position element for the whole block, placed from
 * the hovered span's rectangle, so it appears with no delay and is never
 * clipped by the scrolling terminal.
 */
import { highlightCw, type TokenKind } from '~/utils/cwHighlight'

const props = defineProps<{ text: string }>()

const tokens = computed(() => highlightCw(props.text))

const KIND_CLASS: Record<TokenKind, string> = {
  text: '',
  space: '',
  newline: '',
  unknown: 'text-zinc-600',
  prosign: 'text-violet-300 cw-tip',
  qsignal: 'text-cyan-300 cw-tip',
  rst: 'text-sky-300 cw-tip',
  abbr: 'text-emerald-400 underline decoration-dotted decoration-emerald-500/40 underline-offset-4 cw-tip',
  callsign: 'text-amber-300 font-semibold cw-tip'
}

const tip = ref<{ text: string; x: number; y: number; below: boolean } | null>(null)

function onOver(e: MouseEvent) {
  const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-tip]')
  if (!el) { tip.value = null; return }
  const r = el.getBoundingClientRect()
  // above the word, unless that would leave the viewport
  const below = r.top < 48
  tip.value = { text: el.dataset.tip!, x: r.left + r.width / 2, y: below ? r.bottom + 6 : r.top - 6, below }
}
function onOut(e: MouseEvent) {
  const to = e.relatedTarget as HTMLElement | null
  if (!to || !to.closest?.('[data-tip]')) tip.value = null
}
</script>

<template>
  <span @mouseover="onOver" @mouseout="onOut">
    <template v-for="(tok, i) in tokens" :key="i">
      <template v-if="tok.kind === 'text' || tok.kind === 'space' || tok.kind === 'newline'">{{ tok.text }}</template>
      <span v-else-if="tok.kind === 'unknown'" :class="KIND_CLASS.unknown" :data-tip="tok.tip">·</span>
      <span v-else :class="KIND_CLASS[tok.kind]" :data-tip="tok.tip">{{ tok.text }}</span>
    </template>
    <Teleport to="body">
      <div
        v-if="tip"
        class="pointer-events-none fixed z-50 max-w-xs -translate-x-1/2 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-sans text-xs text-zinc-100 shadow-lg"
        :class="tip.below ? '' : '-translate-y-full'"
        :style="{ left: `${tip.x}px`, top: `${tip.y}px` }"
        role="tooltip"
      >
        {{ tip.text }}
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
.cw-tip {
  cursor: help;
}
</style>
