# Morsey — Gamified CW Trainer

A modern, dark-mode morse code (CW) trainer for amateur radio operators. Built with **Nuxt 4**, **Nuxt UI**, and **Tailwind CSS** — no backend, no accounts, everything runs in your browser and persists to `localStorage`.

## Training method

Morsey implements the two techniques the CW community considers non-negotiable:

- **Koch method** — you start with only two characters (K and M) played at *full character speed*, so you learn each character's rhythm rather than counting dits and dahs. A new character is added only when you hold **90% accuracy over your last 30 answers** (the same threshold LCWO uses). Order follows the standard LCWO Koch sequence across 41 characters (A–Z, 0–9, `.` `,` `?` `/` `=`).
- **Farnsworth timing** — characters are keyed at 20 WPM by default while the spacing between characters/words is stretched per the ARRL Farnsworth standard, giving you thinking time that shrinks as you raise your effective speed.

On top of that, training is **gamified**: XP with levels, answer combos, a daily practice streak, adaptive drilling (missed characters and phrases appear more often), and a progressive unlock map.

## Modules

| Module | What it trains |
|---|---|
| **Koch Trainer** (`/learn`) | Receiving single characters (Listen & Choose grid or keyboard), 5-character copy groups, whole **words** (top-100 English + ham shorthand, filtered to your unlocked letters), and realistic **callsigns** built from real ITU country prefixes |
| **Ham Phrases** (`/phrases`) | Q-signals, prosigns (`AR`, `SK`, `BT`…), RST reports (`599`, `5NN`, `559`), and CW shorthand (`CQ`, `UR`, `73`, `QTH`, `DX`…) across six progressive tiers with mastery tracking |
| **Sending Practice** (`/send`) | Keying with any key type — decoded in real time, validated against target characters/phrases, and graded by a **fist analysis** report (dah:dit weight vs the ideal 3:1, element-length consistency) |
| **QSO Simulator** (`/qso`) | A complete scripted first contact: copy a CQ call, answer with your callsign, copy the RST/name/QTH exchange (sent twice, as on the air), key your half, and copy the 73/`SK` sign-off. Receive-only mode available |
| **Stats** (`/stats`) | Per-character accuracy heatmap in Koch order and a 30-day activity chart (answers or XP per day) |
| **Reference** (`/reference` + nav overlay) | Searchable legend of every character, prosign, and abbreviation — also opens as a slideover from any page (search by text, meaning, or pattern like `.-`), with one-click audio |

## The keyer bar

A radio-style control bar sits at the bottom of every page — collapsed it shows lit status pills (key type, REV, WPM, tone, band conditions, USB, TX); pulled up it's the rig menu:

- **Key type**: straight (also sideswipers), bug (auto dits + manual dahs), iambic A, iambic B (Curtis-B memory) — plus paddle reverse. The hardware is always a dumb contact passthrough; this setting decides what the contacts mean, exactly like an HF transceiver's keyer menu.
- **Band conditions**: simulated **QRN** (receiver-filtered atmospheric noise), **QSB** (slow fading), and **QRM** (a weaker off-frequency station) applied to receive training — train through the noise like the G4FON tradition.
- **USB bridge**: connect, live TIP/RING contact-test LEDs, bridge-ready status, and an event counter for wiring-day debugging.

## Hardware support

- **USB keyers that emulate a keyboard/mouse** work out of the box — key presses are captured directly.
- **Serial-wired paddles** connect through the **Web Serial API** (Chrome/Edge): Morsey raises DTR/RTS and polls **CTS (dit)** and **DSR/DCD (dah)** at 5 ms.
- No hardware? Use `Space` as a straight key, `[` / `]` (or Left/Right `Ctrl`) as paddles, or the on-screen touch key.

The audio engine is the native **Web Audio API** — a pure sine sidetone (700 Hz default, adjustable) with 5 ms gain ramps so it never clicks.

Morsey is also an installable **PWA**: every page and asset is precached by a service worker, so the whole trainer works offline once loaded.

## Development

```bash
npm install
npm run dev        # http://localhost:3000
npm run generate   # static build in .output/public
```

## Deployment

Pushes to `main` deploy automatically to **GitHub Pages** via `.github/workflows/deploy.yml` (static `nuxt build --preset github_pages`, base URL set from the repo name). One-time setup: in the repo settings, set **Pages → Source → GitHub Actions**.

73 · DE MORSEY
