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
| **Koch Trainer** (`/learn`) | Receiving single characters (Listen & Choose grid or keyboard) and full 5-character groups (Copy mode) |
| **Ham Phrases** (`/phrases`) | Q-signals, prosigns (`AR`, `SK`, `BT`…), RST reports (`599`, `5NN`, `559`), and CW shorthand (`CQ`, `UR`, `73`, `QTH`, `DX`…) across six progressive tiers with mastery tracking |
| **Sending Practice** (`/send`) | Keying with a straight key or iambic paddle — decoded in real time and validated against target characters/phrases |
| **Reference** (`/reference` + nav overlay) | Searchable legend of every character, prosign, and abbreviation — also opens as a slideover from any page (search by text, meaning, or pattern like `.-`), with one-click audio |

## Hardware support

- **USB keyers that emulate a keyboard/mouse** work out of the box — key presses are captured directly.
- **Serial-wired paddles** connect through the **Web Serial API** (Chrome/Edge): Morsey raises DTR/RTS and polls **CTS (dit)** and **DSR/DCD (dah)** at 5 ms.
- No hardware? Use `Space` as a straight key, `[` / `]` (or Left/Right `Ctrl`) as paddles, or the on-screen touch key.

The audio engine is the native **Web Audio API** — a pure sine sidetone (700 Hz default, adjustable) with 5 ms gain ramps so it never clicks.

## Development

```bash
npm install
npm run dev        # http://localhost:3000
npm run generate   # static build in .output/public
```

## Deployment

Pushes to `main` deploy automatically to **GitHub Pages** via `.github/workflows/deploy.yml` (static `nuxt build --preset github_pages`, base URL set from the repo name). One-time setup: in the repo settings, set **Pages → Source → GitHub Actions**.

73 · DE MORSEY
