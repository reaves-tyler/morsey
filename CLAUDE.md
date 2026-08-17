# Morsey — CLAUDE.md

Gamified morse code (CW) trainer for amateur radio. Static Nuxt 4 app, no backend — all state lives in browser localStorage. Live at https://reaves-tyler.github.io/morsey/.

## Commands

```bash
pnpm install          # pnpm ONLY — npm/npx/yarn are not used in this repo
pnpm dev              # dev server on :3000
pnpm run generate     # static production build → .output/public
pnpm test             # vitest — keyer engine, Farnsworth math, generators, backup schema
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
| `app/pages/stats.vue` | Stat tiles, per-char accuracy heatmap (sequential emerald ramp), 30-day activity SVG bars from `progress.history` (recorded in `recordAnswer`/`addXp`), table fallback. |
| `app/utils/callsigns.ts` | Weighted ITU-prefix callsign generator (`generateCallsign(allowedChars?)` respects Koch progression). |
| `app/utils/words.ts` | Top-100 English + ham words; `wordsFor(unlockedLetters)`. |
| `app/components/ReferenceLegend.vue` | Searchable legend (text / meaning / pattern-prefix search), used by the nav slideover (`compact`) and `/reference`. |

## Deployment

Push to `main` → `.github/workflows/deploy.yml` → `pnpm exec nuxt build --preset github_pages` with `NUXT_APP_BASE_URL=/<repo>/` → GitHub Pages. Pages source is "GitHub Actions" (already configured).

Icon gotcha: `icon.provider: 'iconify'` lives under `$production` in `nuxt.config.ts` — prerender fetches icon data from the Iconify API (the static preset has no server icon endpoint) while browsers use the scanned client bundle. Do **not** hoist it to top level: dev must keep the default local server provider or it produces `[Icon] failed to load icon` warnings offline.

PWA gotchas (@vite-pwa/nuxt): the manifest link requires `<NuxtPwaManifest />` in app.vue; the module's own SW registration doesn't fire on the prerendered site, so `app/plugins/register-sw.client.ts` registers explicitly (base-URL aware). Workbox config in `nuxt.config.ts` MUST keep the `manifestTransforms` filter (the `/200`, `/404` precache entries return non-200 and abort the entire SW install — on GitHub Pages too) and `navigateFallback: null` (a fallback shell hijacks online navigations; the default `/` fallback also breaks install with non-precached-url). Verify SW health via CDP `ServiceWorker.workerErrorReported`, not just `register()` resolving.

## Domain rules (do not "fix" these)

- Character speed stays fast (20 WPM default) — Koch method forbids slow characters; only the *spacing* (effective WPM) stretches, per the ARRL Farnsworth formula in `morseTimings`.
- Answer grids stay in fixed Koch order — the challenge belongs in the ears, not button hunting.
- Sending timing is independent of listening speed and adaptive to the user's fist.
- Character codes / prosigns / Koch order are validated against ITU-R M.1677-1 and LCWO's published sequence — change only with a reference in hand.

## Verification

- **Keyer timing/decode logic**: `pnpm test` — deterministic Vitest suite over the pure engine with fake timers (runs in CI before every deploy). Any change to element timing, iambic behavior, classification, or gap policy belongs there first.
- **Everything else**: verify in the real app. Serve `.output/public`, then drive with playwright-core (`~/.cache/ms-playwright/chromium_headless_shell-*`) — keyboard events with realistic hold/gap timings exercise the trainer and keyer end-to-end. Always check the browser console for errors and run `pnpm exec nuxt typecheck` before committing.
