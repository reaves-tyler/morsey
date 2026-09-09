<script setup lang="ts">
/**
 * Live keyer output. Characters the keyer could not match to a Morse pattern
 * arrive as `*` (see `UNKNOWN_CHAR` in keyerEngine) and render as a dim dot,
 * so a fumbled letter never looks like real copy.
 */
import { UNKNOWN_CHAR } from '~/utils/keyerEngine'

const props = defineProps<{ text: string }>()

const tokens = computed(() => props.text.match(/\*|[^*]+/g) ?? [])
</script>

<template>
  <span class="text-zinc-100">
    <template v-for="(tok, i) in tokens" :key="i">
      <span v-if="tok === UNKNOWN_CHAR" class="text-zinc-600" title="Unrecognized pattern">·</span>
      <template v-else>{{ tok }}</template>
    </template>
    <template v-if="!tokens.length">&nbsp;</template>
  </span>
</template>
