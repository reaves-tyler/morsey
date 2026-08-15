export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  modules: ['@nuxt/ui'],
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
  }
})
