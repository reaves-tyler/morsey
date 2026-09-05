<script setup lang="ts">
const { progress, level, freePlay } = useProgress()

// ---- Site-wide SEO -------------------------------------------------------
// Each page sets its own title/description via useSeoMeta; this supplies the
// title template, canonical URL, Open Graph / Twitter defaults and JSON-LD.
const SITE_URL = 'https://morsey.net'
const SITE_NAME = 'Morsey'
const DEFAULT_TITLE = 'Morsey — Free Morse Code (CW) Trainer for Ham Radio'
const DEFAULT_DESCRIPTION =
  'Learn Morse code by ear with a free, open-source CW trainer: Koch method, Farnsworth timing, Q-signals, sending practice with a real key or paddle, a QSO simulator and a live on-air decoder. Runs in the browser, works offline.'

const route = useRoute()
// GitHub Pages serves prerendered routes at /learn/ and 301s /learn there, so
// the canonical (and og:url) must carry the trailing slash to match.
const canonical = computed(() => {
  const path = route.path === '/' ? '/' : route.path.replace(/\/?$/, '/')
  return SITE_URL + path
})

useHead({
  titleTemplate: (title?: string) => (title ? `${title} · ${SITE_NAME}` : DEFAULT_TITLE),
  link: [{ rel: 'canonical', href: canonical }],
  script: [
    {
      type: 'application/ld+json',
      // Structured data: the site, the app, and who makes it. Prices are
      // explicit zeros so "free" is machine-readable, not just marketing copy.
      innerHTML: JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
          {
            '@type': 'WebSite',
            '@id': `${SITE_URL}/#website`,
            url: `${SITE_URL}/`,
            name: SITE_NAME,
            description: DEFAULT_DESCRIPTION,
            inLanguage: 'en'
          },
          {
            '@type': ['WebApplication', 'SoftwareApplication'],
            '@id': `${SITE_URL}/#app`,
            name: SITE_NAME,
            alternateName: 'Morsey CW Trainer',
            url: `${SITE_URL}/`,
            description: DEFAULT_DESCRIPTION,
            applicationCategory: 'EducationalApplication',
            applicationSubCategory: 'Morse code trainer',
            operatingSystem: 'Any — runs in a web browser (Chrome, Edge, Firefox, Safari); installable as a PWA',
            browserRequirements: 'Requires JavaScript and Web Audio. Web Serial (Chrome/Edge) for USB keys.',
            isAccessibleForFree: true,
            offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
            license: 'https://www.gnu.org/licenses/agpl-3.0.html',
            codeRepository: 'https://github.com/reaves-tyler/morsey',
            keywords: [
              'morse code trainer', 'CW trainer', 'learn morse code', 'Koch method', 'Farnsworth timing',
              'ham radio', 'amateur radio', 'CW decoder', 'morse code practice', 'iambic keyer', 'QSO simulator'
            ].join(', '),
            featureList: [
              'Koch method character training at full character speed',
              'Farnsworth spacing per the ARRL formula',
              'Q-signals, prosigns and ham abbreviations in progressive tiers',
              'Sending practice with keyboard, on-screen key, or a real straight key / paddle over USB',
              'Iambic A, iambic B, bug and straight-key modes with adjustable keyer feel',
              'Scripted first-QSO simulator',
              'Live CW decoder for your transceiver audio with spectrum display',
              'Simulated band conditions: QRN, QSB, QRM',
              'Progress, streaks and per-character accuracy stats',
              'Installable PWA that works offline; no account, no tracking'
            ],
            author: { '@id': `${SITE_URL}/#author` },
            publisher: { '@id': `${SITE_URL}/#author` }
          },
          {
            '@type': 'Person',
            '@id': `${SITE_URL}/#author`,
            name: 'Tyler Reaves',
            url: 'https://github.com/reaves-tyler'
          }
        ]
      })
    }
  ]
})

useSeoMeta({
  description: DEFAULT_DESCRIPTION,
  ogType: 'website',
  ogSiteName: SITE_NAME,
  ogTitle: DEFAULT_TITLE,
  ogDescription: DEFAULT_DESCRIPTION,
  ogUrl: canonical,
  ogImage: `${SITE_URL}/og.png`,
  ogImageWidth: 1200,
  ogImageHeight: 630,
  ogImageAlt: 'Morsey — free Morse code trainer for ham radio',
  ogLocale: 'en_US',
  twitterCard: 'summary_large_image',
  twitterTitle: DEFAULT_TITLE,
  twitterDescription: DEFAULT_DESCRIPTION,
  twitterImage: `${SITE_URL}/og.png`,
  applicationName: SITE_NAME,
  appleMobileWebAppTitle: SITE_NAME,
  robots: 'index, follow, max-image-preview:large, max-snippet:-1'
})

const pageLinks = [
  { to: '/', label: 'Dashboard', icon: 'i-lucide-layout-dashboard' },
  { to: '/learn', label: 'Learn', icon: 'i-lucide-graduation-cap' },
  { to: '/phrases', label: 'Phrases', icon: 'i-lucide-message-square-code' },
  { to: '/send', label: 'Send', icon: 'i-lucide-radio-tower' },
  { to: '/qso', label: 'QSO', icon: 'i-lucide-antenna' },
  { to: '/decode', label: 'Decode', icon: 'i-lucide-audio-waveform' },
  { to: '/stats', label: 'Stats', icon: 'i-lucide-activity' }
]

const mobileLinks = [
  ...pageLinks,
  { to: '/reference', label: 'Reference', icon: 'i-lucide-book-open' },
  { to: '/settings', label: 'Settings', icon: 'i-lucide-settings-2' }
]
</script>

<template>
  <UApp>
    <NuxtPwaManifest />
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
            <button
              type="button"
              class="flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset transition"
              :class="freePlay
                ? 'bg-orange-500/15 text-orange-300 ring-orange-500/40 shadow-[0_0_10px_rgba(249,115,22,0.3)]'
                : 'bg-zinc-800/60 text-zinc-400 ring-zinc-700 hover:bg-zinc-800 hover:text-zinc-200'"
              :aria-pressed="freePlay"
              :title="freePlay
                ? 'Free play is on — every character and phrase tier is open. Click to return to your Koch progress.'
                : 'Free play: unlock everything for this session without touching your progress'"
              @click="freePlay = !freePlay"
            >
              <span
                class="size-2 rounded-[2px] transition"
                :class="freePlay ? 'bg-orange-400 shadow-[0_0_6px_rgba(251,146,60,0.9)]' : 'bg-zinc-600'"
              />
              Free play
            </button>
          </div>
        </div>

        <nav class="flex items-center justify-around border-t border-zinc-800/80 px-1 py-1.5 sm:hidden">
          <NuxtLink
            v-for="link in mobileLinks"
            :key="link.to"
            :to="link.to"
            class="flex flex-col items-center gap-0.5 rounded-md px-1.5 py-1 text-[10px] text-zinc-400"
            active-class="!text-emerald-400"
            :aria-label="link.label"
          >
            <UIcon :name="link.icon" class="size-4" />
            {{ link.label }}
          </NuxtLink>
        </nav>
      </header>

      <main class="mx-auto w-full max-w-5xl flex-1 px-4 py-8 pb-20">
        <NuxtPage />
      </main>

      <footer class="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-t border-zinc-800/80 py-4 pb-14 text-center font-mono text-xs text-zinc-600">
        <span>73 DE MORSEY <span class="text-zinc-700">·-·-·</span> Free &amp; open-source CW trainer — Koch method · Farnsworth timing</span>
        <NuxtLink to="/about" class="text-zinc-500 transition hover:text-emerald-400">
          About &amp; FAQ
        </NuxtLink>
        <a
          href="https://github.com/reaves-tyler/morsey"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex items-center gap-1 text-zinc-500 transition hover:text-emerald-400"
          aria-label="Morsey on GitHub"
        >
          <UIcon name="i-lucide-github" class="size-3.5" />
          GitHub
        </a>
      </footer>

      <KeyerBar />
    </div>
  </UApp>
</template>
