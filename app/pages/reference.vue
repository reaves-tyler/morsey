<script setup lang="ts">
useSeoMeta({
  title: 'Morse Code Reference Chart — Letters, Numbers, Prosigns & Q-Signals',
  description: 'Searchable Morse code chart: every letter, digit and punctuation mark per ITU-R M.1677-1, plus prosigns, Q-signals and common ham abbreviations with their meanings. Search by text, meaning or dit-dah pattern and click any entry to hear it.',
  ogTitle: 'Morse Code Reference Chart · Morsey',
  ogDescription: 'The full ITU alphabet, prosigns, Q-signals and ham abbreviations. Click to hear any of them.'
})
</script>

<template>
  <div class="space-y-6">
    <header>
      <h1 class="text-2xl font-semibold tracking-tight">Reference</h1>
      <p class="mt-1 text-sm text-zinc-400">
        The full legend — every character, prosign, and abbreviation. Click anything to hear it.
        Also available from any page via the book icon in the nav bar.
      </p>
    </header>
    <ReferenceLegend />
  </div>
</template>
