export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  modules: ['@nuxt/ui', '@vite-pwa/nuxt'],
  css: ['~/assets/css/main.css'],
  ssr: true,
  devtools: { enabled: false },
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
    }
  },
  app: {
    // Overridden to /<repo>/ by the GitHub Pages workflow
    baseURL: process.env.NUXT_APP_BASE_URL || '/',
    head: {
      title: 'Morsey — CW Trainer',
      htmlAttrs: { lang: 'en' },
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        {
          name: 'description',
          content:
            'Gamified morse code trainer for ham radio operators. Koch method, Farnsworth timing, Q-signals, and USB paddle support — all in the browser.'
        }
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
      globPatterns: ['**/*.{js,css,html,svg,png,ico,json,woff2}'],
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
