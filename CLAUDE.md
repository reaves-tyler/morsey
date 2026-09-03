# Morsey — CLAUDE.md

Gamified morse code (CW) trainer for amateur radio. Static Nuxt 4 app, no backend — all state lives in browser localStorage. Live at https://morsey.net/ (GitHub Pages behind a custom domain; the old https://reaves-tyler.github.io/morsey/ URL 301s there).

## Commands

```bash
pnpm install          # pnpm ONLY — npm/npx/yarn are not used in this repo
pnpm dev              # dev server on :3000
pnpm run generate     # static production build → .output/public
pnpm test             # vitest — keyer engine, Farnsworth math, generators, backup schema, CW stream decoder
pnpm run samples      # re-render the CW sample WAVs (public/samples/cw) from utils/cwSynth presets
pnpm run og           # re-render the social preview public/og.png from scripts/og/og-image.html (playwright-core Chromium)
pnpm exec nuxt typecheck
```

pnpm 11 gates postinstall scripts: approved builds live in `pnpm-workspace.yaml` (`allowBuilds`). To smoke-test the production build locally: `python3 -m http.server 4173 --directory .output/public`.

## Stack

- **Nuxt 4** (`app/` directory layout), **Nuxt UI v4** (+ Tailwind 4 via `@import "@nuxt/ui"` in `app/assets/css/main.css`), lucide icons (`@iconify-json/lucide`)
- **No Pinia** — deliberate choice: state is plain Nuxt `useState` in composables
- Dark mode forced (`colorMode.preference: 'dark'`), zinc/emerald palette set in `app/app.config.ts`

## Architecture

| File | Responsibility |
|---|---|
| `app/utils/morse.ts` | ITU character map (`MORSE`), LCWO Koch order (`KOCH_ORDER`), ARRL Farnsworth timing math (`morseTimings`), text→tone-schedule compiler (`textToSchedule`). Prosigns are written `<AR>` and sent merged (no inter-letter gap). |
| `app/utils/abbreviations.ts` | `PHRASE_TIERS`: six progressive tiers of Q-signals, prosigns, RST reports, abbreviations. `send` is what's keyed; prosigns wrapped in `<>`. |
| `app/composables/useProgress.ts` | All persistent state (XP, streak, Koch lesson + rolling accuracy window, per-char stats, phrase mastery, settings). Persists to localStorage key `morsey-progress-v1`; loads via `onNuxtReady` **after** hydration to avoid SSR mismatches. `parseProgressJson` validates import files. |
| `app/composables/useMorseAudio.ts` | Web Audio engine. Module-level singleton AudioContext; scheduled playback (`playText`, cancellable — `stop()` resolves the pending promise so awaiting callers never hang), zero-latency keyer sidetone (`keyDown`/`keyUp`), feedback cues (`playCue('good'|'bad')`). 5 ms gain ramps prevent clicks. |
| `app/utils/keyerEngine.ts` | Pure keyer engine — every sending-side state machine, no Vue/Nuxt/audio/clock dependencies (host injects `now`/`setTimer` and receives events via callbacks). Raw `tip`/`ring` contacts in; `keyType` decides meaning, like a rig's keyer menu: straight (tip only — mono-plug safe; manual timing, adaptive dit classification), bug (auto dits + manual dahs), iambic A, iambic B (Curtis-B memory latched at element start AND on mid-element squeeze). `paddleReverse` swaps roles. Timing uses `sendWpm`, NOT the receive speed. Feel knobs (all optional in `KeyerConfig`, defaults = standard keyer, surfaced as Settings → "Keyer feel"): `debounceMs`, `weight` (dah:dit, rigs offer 2.8–4.5), `dahThresholdUnits`, `adaptive` on/off, `letterGapUnits`/`wordGapUnits` (decoder patience; per-unit floors keep defaults at 450 ms/1.2 s). Unit-tested in `tests/keyerEngine.test.ts` under fake timers — change the engine, run `pnpm test`. |
| `app/composables/useKeyer.ts` | Thin adapter over the engine, module-level singleton (bar + send page share one keyer and one serial connection, which survives navigation). Wires engine events to refs + Web Audio; feeds it contacts from keyboard (straight: Space; else `[`/`]` or Ctrl keys), on-screen keys, and the USB bridge's `TIP_*`/`RING_*` serial lines. Backspace clears. `keyType` changes hard-reset the engine; `sendWpm` changes reset calibration. |
| `app/components/KeyerBar.vue` | Radio-front-panel bar fixed to the bottom of every page: collapsed strip of lit status pills (key type, REV, WPM, tone, USB, TX), pulls up into a soft-key config panel (key type, reverse, speed/tone/volume sliders, serial connect). |
| `hardware/pico-bridge/` | MicroPython `main.py` for a Raspberry Pi Pico H key→USB bridge (GP14 = tip, GP15 = ring, pull-ups, 5 ms stable-state debounce). Deliberately dumb passthrough: emits only `TIP_DOWN`/`TIP_UP`/`RING_DOWN`/`RING_UP` lines; all interpretation stays in the browser keyer. |
| `app/pages/learn.vue` | Koch trainer. Answers accepted during playback (eyes-free flow); chirp/buzz audio feedback; unlock at ≥90% over `UNLOCK_WINDOW` (30) answers. Four modes: choose grid, copy groups, words (top-100 + ham words filtered to unlocked letters), callsigns (unlocks once a digit is learned). |
| `app/pages/phrases.vue` | Tiered phrase quiz; mastery = 3 consecutive correct; next tier at 80% mastered. |
| `app/pages/send.vue` | Sending practice: char/phrase challenges validated against live decode, plus fist analysis (dah:dit ratio, consistency CV) fed by the engine's `onManualElement`. |
| `app/pages/qso.vue` | Scripted first-contact simulator (`app/utils/qso.ts` builds the steps per the standard FISTS/QRP-Labs structure); listen steps copy fields, send steps validate live decode; receive-only toggle. |
| `app/utils/cwDecoder.ts` | Pure CW **stream decoder** (PCM in → text out; no Web Audio/Vue/clock — time is counted in samples). Pipeline: quadrature mix at `centerHz` → two cascaded boxcars (triangular window, −3 dB width `bandwidthHz`, sidelobes −26 dB for QRM) → CFAR-style adaptive threshold (noise floor mean/σ tracked while key-up, signal peak while key-down, key at floor + 3.5σ *and* halfway to the peak *and* above the `minSnrDb` squelch; key-up edge timed at the on-level crossing so hysteresis doesn't shorten marks; 200 ms warm-up) → noise blanker → two-cluster dit/dah tracker (log-domain 2-means over the last 10 marks, snaps on first calibration / >30 % speed change and re-classifies the character in progress; letter/word gaps tracked as their own clusters so Farnsworth spacing works) → real-time flush at the letter boundary. `PATTERN_TO_CHAR` = `REVERSE_MORSE` + prosigns (`<SK>` `<KN>` …; characters win collisions so AR prints `+`). Unit-tested end-to-end on synthesized audio in `tests/cwDecoder.test.ts`. Known limits: the first character can be wrong when the speed prior is >1.7× off; Farnsworth letter gaps look like word gaps until the first real word gap reveals both spacing classes. |
| `app/utils/cwSynth.ts` | Deterministic CW band-audio synthesizer (`renderCw`): Farnsworth timing via `textToSchedule`, hand-sent weight/jitter, QRN at an SNR quoted in a 2.5 kHz bandwidth, QSB, QRM, drift, keying envelope centred on the nominal edges. `SAMPLE_PRESETS` (8 clips, easiest→hardest) back both the in-app "Test sample" source and `scripts/gen-cw-samples.ts` (→ `public/samples/cw/*.wav`, excluded from the PWA precache). `encodeWav16` writes the files. |
| `app/composables/useCwStreamDecoder.ts` | Browser adapter for the decoder, module-level singleton (keeps running across navigation until Stop). Graph: source → BiquadFilter bandpass (Q = f/2·bw clamped 5–50, toggleable) → inline-Blob AudioWorklet that forwards 1024-sample PCM blocks to the main-thread decoder (ScriptProcessor fallback); an AnalyserNode on the *unfiltered* source feeds the spectrum. Sources: `mic` (getUserMedia with echoCancellation/noiseSuppression/autoGainControl **off** — they destroy CW; never monitored to speakers; mutes the keyer sidetone via `useMorseAudio().setSidetoneMuted`), `sample` (renders a preset into an AudioBuffer at the context rate), `file` (decodeAudioData). A second tap on the *raw* source feeds the **recorder** (`startRecording`/`stopRecording` → 16-bit WAV Blob at the context rate, capped at ~10 min) so real on-air misses can be replayed through the decoder tests. Settings persist to localStorage `morsey-decode-v1`. |
| `app/pages/decode.vue` | Stream decoding UI: spectrum (200–1600 Hz, passband overlay, click/drag or "Tune to peak" to set the pitch), level meter with floor/threshold/peak marks, WPM/SNR/gap readouts, element ribbon, live terminal (prosign chips, unknown = dim dot), source picker with the sample library, pitch/bandwidth sliders, auto/manual threshold + squelch, timing & noise-blanker knobs, Rec button (downloads the WAV when stopped or when listening stops). |
| `app/pages/about.vue` | About & FAQ: crawlable prose on the method (Koch, Farnsworth, real-key sending, on-air readiness) plus an FAQ also emitted as `FAQPage` JSON-LD. Linked from the footer and the landing blurb. Tyler does not want a competitor comparison page — "it's not a competition" — so keep other trainers out of the copy. |
| `app/pages/stats.vue` | Stat tiles, per-char accuracy heatmap (sequential emerald ramp), 30-day activity SVG bars from `progress.history` (recorded in `recordAnswer`/`addXp`), table fallback. |
| `app/utils/callsigns.ts` | Weighted ITU-prefix callsign generator (`generateCallsign(allowedChars?)` respects Koch progression). |
| `app/utils/words.ts` | Top-100 English + ham words; `wordsFor(unlockedLetters)`. |
| `app/components/ReferenceLegend.vue` | Searchable legend (text / meaning / pattern-prefix search), used by the nav slideover (`compact`) and `/reference`. |

## SEO

Site-wide head lives in `app.vue`: title template (`<page> · Morsey`), canonical (trailing slash — matches what Pages serves), OG/Twitter defaults pointing at `public/og.png`, and JSON-LD (`WebSite` + `WebApplication`/`SoftwareApplication` with `isAccessibleForFree` and a zero-price offer + `Person`). Every page sets `useSeoMeta({ title, description, ogTitle, ogDescription })` at the top of its script; `stats` and `settings` are `noindex` and excluded from the sitemap. The landing page (`index.vue`) keeps a descriptive H1 + one-paragraph pitch above the dashboard; the longer method prose and the FAQ (also emitted as `FAQPage` JSON-LD) live on `/about` — keep answers honest (no inflated learning-time claims). `@nuxtjs/sitemap` + `@nuxtjs/robots` (config under `site`/`sitemap`/`robots` in `nuxt.config.ts`) prerender `/sitemap.xml` and `/robots.txt`; AI search crawlers are explicitly allowed. `public/llms.txt` is the AI-search summary — update it when features change. No hidden text or keyword stuffing, ever: it risks the whole domain.

## Deployment

Push to `main` → `.github/workflows/deploy.yml` → `pnpm exec nuxt build --preset github_pages` with `NUXT_APP_BASE_URL=/` → GitHub Pages. Pages source is "GitHub Actions"; custom domain `morsey.net` is set in repo Settings → Pages (not a CNAME file — Actions-sourced sites keep it in settings). DNS lives at Cloudflare: four apex `A` records to the Pages IPs plus `www` CNAME → `reaves-tyler.github.io`. The base URL must stay `/` while the custom domain is active; reverting to `/<repo>/` would break asset paths.

Icon gotcha: `icon.provider: 'iconify'` lives under `$production` in `nuxt.config.ts` — prerender fetches icon data from the Iconify API (the static preset has no server icon endpoint) while browsers use the scanned client bundle. Do **not** hoist it to top level: dev must keep the default local server provider or it produces `[Icon] failed to load icon` warnings offline.

PWA gotchas (@vite-pwa/nuxt): the manifest link requires `<NuxtPwaManifest />` in app.vue; the module's own SW registration doesn't fire on the prerendered site, so `app/plugins/register-sw.client.ts` registers explicitly (base-URL aware). Workbox config in `nuxt.config.ts` MUST keep the `manifestTransforms` filter (the `/200`, `/404` precache entries return non-200 and abort the entire SW install — on GitHub Pages too) and `navigateFallback: null` (a fallback shell hijacks online navigations; the default `/` fallback also breaks install with non-precached-url). Verify SW health via CDP `ServiceWorker.workerErrorReported`, not just `register()` resolving.

## Domain rules (do not "fix" these)

- Character speed stays fast (20 WPM default) — Koch method forbids slow characters; only the *spacing* (effective WPM) stretches, per the ARRL Farnsworth formula in `morseTimings`.
- Answer grids stay in fixed Koch order — the challenge belongs in the ears, not button hunting.
- Sending timing is independent of listening speed and adaptive to the user's fist.
- Character codes / prosigns / Koch order are validated against ITU-R M.1677-1 and LCWO's published sequence — change only with a reference in hand.

## Verification

- **Keyer timing/decode logic**: `pnpm test` — deterministic Vitest suite over the pure engine with fake timers (runs in CI before every deploy). Any change to element timing, iambic behavior, classification, or gap policy belongs there first.
- **Stream decoder**: also `pnpm test` — `tests/cwDecoder.test.ts` synthesizes band audio (`utils/cwSynth.ts`, seeded) and asserts decoded text / speed tracking across speeds 8–45 WPM, Farnsworth and hand-sent spacing, SNR 3–40 dB, QSB, QRM, drift, hard keying, block-size and sample-rate independence, plus every shipped sample preset within its difficulty budget. Tune thresholds there, not by ear. `playwright-core` is a devDependency for driving the built site headlessly (Chrome flags `--use-fake-device-for-media-stream --autoplay-policy=no-user-gesture-required` make the sample source run unattended).
- **Everything else**: verify in the real app. Serve `.output/public`, then drive with playwright-core (`~/.cache/ms-playwright/chromium_headless_shell-*`) — keyboard events with realistic hold/gap timings exercise the trainer and keyer end-to-end. Always check the browser console for errors and run `pnpm exec nuxt typecheck` before committing.
