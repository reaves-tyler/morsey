<script setup lang="ts">
const { progress, level } = useProgress()

const pageLinks = [
  { to: '/', label: 'Dashboard', icon: 'i-lucide-layout-dashboard' },
  { to: '/learn', label: 'Learn', icon: 'i-lucide-graduation-cap' },
  { to: '/phrases', label: 'Phrases', icon: 'i-lucide-message-square-code' },
  { to: '/send', label: 'Send', icon: 'i-lucide-radio-tower' }
]

const mobileLinks = [
  ...pageLinks,
  { to: '/reference', label: 'Reference', icon: 'i-lucide-book-open' },
  { to: '/settings', label: 'Settings', icon: 'i-lucide-settings-2' }
]
</script>

<template>
  <UApp>
    <div class="min-h-screen flex flex-col bg-zinc-950 text-zinc-100">
      <header class="sticky top-0 z-40 border-b border-zinc-800/80 bg-zinc-950/80 backdrop-blur">
        <div class="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
          <NuxtLink to="/" class="flex items-center gap-2 font-semibold tracking-tight">
            <span class="flex size-7 items-center justify-center rounded-md bg-emerald-500/15 font-mono text-sm text-emerald-400">-.-</span>
            <span class="text-zinc-100">Morsey</span>
          </NuxtLink>

          <nav class="hidden items-center gap-1 sm:flex">
            <NuxtLink
              v-for="link in pageLinks"
              :key="link.to"
              :to="link.to"
              class="rounded-md px-3 py-1.5 text-sm text-zinc-400 transition hover:text-zinc-100"
              active-class="!text-emerald-400 bg-emerald-500/10"
            >
              {{ link.label }}
            </NuxtLink>

            <!-- Quick reference overlay: opens over any page without leaving it -->
            <USlideover
              title="Reference"
              description="Quick legend — click anything to hear it"
            >
              <button
                class="flex items-center gap-1 rounded-md px-3 py-1.5 text-sm text-zinc-400 transition hover:text-zinc-100"
              >
                Reference
                <UIcon name="i-lucide-panel-right-open" class="size-3.5" />
              </button>
              <template #body>
                <ReferenceLegend compact />
              </template>
            </USlideover>

            <NuxtLink
              to="/settings"
              class="rounded-md px-3 py-1.5 text-sm text-zinc-400 transition hover:text-zinc-100"
              active-class="!text-emerald-400 bg-emerald-500/10"
            >
              Settings
            </NuxtLink>
          </nav>

          <div class="flex items-center gap-3 text-sm">
            <span class="flex items-center gap-1 text-amber-400" title="Daily streak">
              <UIcon name="i-lucide-flame" class="size-4" />
              {{ progress.streakDays }}
            </span>
            <UBadge color="primary" variant="subtle">Lv {{ level }}</UBadge>
          </div>
        </div>

        <nav class="flex items-center justify-around border-t border-zinc-800/80 px-2 py-1.5 sm:hidden">
          <NuxtLink
            v-for="link in mobileLinks"
            :key="link.to"
            :to="link.to"
            class="flex flex-col items-center gap-0.5 rounded-md px-2 py-1 text-[11px] text-zinc-400"
            active-class="!text-emerald-400"
          >
            <UIcon :name="link.icon" class="size-4" />
            {{ link.label }}
          </NuxtLink>
        </nav>
      </header>

      <main class="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <NuxtPage />
      </main>

      <footer class="border-t border-zinc-800/80 py-4 text-center font-mono text-xs text-zinc-600">
        73 DE MORSEY <span class="text-zinc-700">·-·-·</span> CW trainer — Koch method · Farnsworth timing
      </footer>
    </div>
  </UApp>
</template>
