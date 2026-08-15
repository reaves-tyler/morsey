# Morsey — CLAUDE.md

Gamified morse code (CW) trainer for amateur radio. Static Nuxt 4 app, no backend — all state lives in browser localStorage. Live at https://reaves-tyler.github.io/morsey/.

## Commands

```bash
pnpm install          # pnpm ONLY — npm/npx/yarn are not used in this repo
pnpm dev              # dev server on :3000
pnpm run generate     # static production build → .output/public
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
| `app/composables/useKeyer.ts` | Sending-side input → dits/dahs → text. Straight key (adaptive dit-length classification, calibrates to the operator per press) and iambic paddle (machine-timed elements). Timing uses `settings.sendWpm`, NOT the receive speed. Letter/word commit gaps are stretched (4u/8u, 450 ms/1.2 s floors). Web Serial: polls CTS (dit) / DSR (dah) at 5 ms. Backspace clears. |
| `app/pages/learn.vue` | Koch trainer. Answers accepted during playback (eyes-free flow); chirp/buzz audio feedback; unlock at ≥90% over `UNLOCK_WINDOW` (30) answers. |
| `app/pages/phrases.vue` | Tiered phrase quiz; mastery = 3 consecutive correct; next tier at 80% mastered. |
| `app/pages/send.vue` | Sending practice: char/phrase challenges validated against live decode. |
| `app/components/ReferenceLegend.vue` | Searchable legend (text / meaning / pattern-prefix search), used by the nav slideover (`compact`) and `/reference`. |

## Deployment

Push to `main` → `.github/workflows/deploy.yml` → `pnpm exec nuxt build --preset github_pages` with `NUXT_APP_BASE_URL=/<repo>/` → GitHub Pages. Pages source is "GitHub Actions" (already configured).

Icon gotcha: `icon.provider: 'iconify'` lives under `$production` in `nuxt.config.ts` — prerender fetches icon data from the Iconify API (the static preset has no server icon endpoint) while browsers use the scanned client bundle. Do **not** hoist it to top level: dev must keep the default local server provider or it produces `[Icon] failed to load icon` warnings offline.

## Domain rules (do not "fix" these)

- Character speed stays fast (20 WPM default) — Koch method forbids slow characters; only the *spacing* (effective WPM) stretches, per the ARRL Farnsworth formula in `morseTimings`.
- Answer grids stay in fixed Koch order — the challenge belongs in the ears, not button hunting.
- Sending timing is independent of listening speed and adaptive to the user's fist.
- Character codes / prosigns / Koch order are validated against ITU-R M.1677-1 and LCWO's published sequence — change only with a reference in hand.

## Verification

No test suite; verify behavior in the real app. Serve `.output/public`, then drive with playwright-core (`~/.cache/ms-playwright/chromium_headless_shell-*`) — keyboard events with realistic hold/gap timings exercise the trainer and keyer end-to-end. Always check the browser console for errors and run `pnpm exec nuxt typecheck` before committing.
