/**
 * Explicit service-worker registration. The @vite-pwa/nuxt runtime plugin's
 * lazy workbox-window path doesn't reliably fire on the prerendered static
 * site, so register the generated sw.js directly — with `registerType:
 * 'autoUpdate'` the worker self-updates (skipWaiting + clientsClaim), so a
 * plain register is all that's needed.
 */
export default defineNuxtPlugin(() => {
  if (import.meta.dev || !('serviceWorker' in navigator)) return
  const base = useRuntimeConfig().app.baseURL
  onNuxtReady(() => {
    navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch(() => {
      // offline support is progressive enhancement — never break the app over it
    })
  })
})
