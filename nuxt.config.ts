export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  modules: ['@nuxt/ui', '@vite-pwa/nuxt', '@nuxtjs/sitemap', '@nuxtjs/robots'],
  css: ['~/assets/css/main.css'],
  ssr: true,
  devtools: { enabled: false },
  // SEO: canonical origin for sitemap/robots/OG URLs. GitHub Pages serves
  // prerendered routes as /learn/ (301 from /learn), so canonical URLs and the
  // sitemap use trailing slashes to match what the server actually returns.
  site: {
    url: 'https://morsey.net',
    name: 'Morsey',
    description: 'Free, open-source morse code (CW) trainer for ham radio: Koch method, Farnsworth timing, sending practice with a real key, QSO simulator, and a live CW decoder.',
    defaultLocale: 'en',
    trailingSlash: true,
    indexable: true
  },
  // Render every internal <NuxtLink> href with the trailing slash too, so
  // links point straight at the canonical URL instead of costing crawlers a
  // 301 hop (Search Console otherwise files every bare URL under "Page with
  // redirect"). Applies to Nuxt UI's ULink/UButton as well.
  experimental: {
    defaults: {
      nuxtLink: { trailingSlash: 'append' }
    }
  },
  sitemap: {
    // Personal, state-only pages have nothing for a search engine to index
    exclude: ['/settings', '/stats'],
    xsl: false
  },
  robots: {
    // Everything is public. AI search crawlers are welcome — listing them
    // explicitly documents intent (some default to "unless told otherwise").
    groups: [
      { userAgent: ['*'], allow: ['/'], disallow: ['/settings', '/stats'] },
      {
        userAgent: [
          'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot', 'anthropic-ai',
          'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Applebot-Extended', 'Bingbot', 'DuckAssistBot', 'CCBot'
        ],
        allow: ['/']
      }
    ]
  },
  colorMode: {
    preference: 'dark',
    fallback: 'dark'
  },
  icon: {
    clientBundle: {
      scan: true
    }
  },
  // Static production build only: prerender pulls icon data from the Iconify
  // API (the static preset has no server icon endpoint), while browsers use
  // the local client bundle — all icons ship with the site. Dev keeps the
  // default local server provider so no network is involved.
  $production: {
    icon: {
      provider: 'iconify'
    },
    app: {
      head: {
        script: [
          // Cloudflare Web Analytics (beacon, cookie-free). Production only so
          // dev and test runs don't count as visits. Offline/PWA: the script
          // simply fails to load; nothing depends on it.
          {
            type: 'module',
            src: 'https://static.cloudflareinsights.com/beacon.min.js',
            'data-cf-beacon': '{"token": "3846f3821b3b4d798e4f15c2d4dc6fc3"}'
          }
        ]
      }
    }
  },
  app: {
    // Overridden to /<repo>/ by the GitHub Pages workflow
    baseURL: process.env.NUXT_APP_BASE_URL || '/',
    head: {
      // Title/description/OG/canonical/JSON-LD are set per route in app.vue
      // and each page via useSeoMeta; only the invariant bits live here.
      htmlAttrs: { lang: 'en' },
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'theme-color', content: '#09090b' }
      ],
      link: [{ rel: 'icon', type: 'image/svg+xml', href: (process.env.NUXT_APP_BASE_URL || '/') + 'favicon.svg' }]
    }
  },
  nitro: {
    prerender: {
      crawlLinks: true,
      routes: ['/']
    }
  },
  pwa: {
    registerType: 'autoUpdate',
    manifest: {
      name: 'Morsey — CW Trainer',
      short_name: 'Morsey',
      description: 'Gamified morse code trainer: Koch method, Farnsworth timing, sending practice, and a QSO simulator.',
      theme_color: '#09090b',
      background_color: '#09090b',
      display: 'standalone',
      icons: [
        { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
        { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
        { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
      ]
    },
    workbox: {
      // (the CW sample WAVs under /samples are deliberately not precached —
      // they are fetched on demand from the decode page)
      globPatterns: ['**/*.{js,css,html,svg,png,ico,json,woff2}'],
      globIgnores: ['**/samples/**'],
      // No SPA fallback: every route is prerendered and precached, in-app
      // navigation is client-side, and a fallback shell would hijack normal
      // online navigations (serving the '/' document for /learn). Offline,
      // hard navigations resolve via directoryIndex for canonical
      // trailing-slash URLs; the module's default '/' fallback also breaks
      // the SW install outright (non-precached-url).
      navigateFallback: null,
      // The prerendered error/SPA-fallback routes respond with non-200 when
      // fetched by their clean URL, which aborts the whole SW install
      // (Workbox precaching requires 200s) — keep them out of the manifest
      manifestTransforms: [
        async (entries: any[]) => ({
          manifest: entries.filter(e => !/^\/?(200|404)(\.html)?$/.test(e.url)),
          warnings: []
        })
      ]
    }
  }
})
