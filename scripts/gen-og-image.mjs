/**
 * Render the social preview image (public/og.png, 1200×630) from
 * scripts/og/og-image.html using the playwright-core Chromium already used
 * for end-to-end checks. Re-run after editing the template:
 *
 *   pnpm run og
 *
 * Set PLAYWRIGHT_CHROMIUM to a browser binary to override the executable
 * (defaults to whatever playwright-core resolves from ~/.cache/ms-playwright).
 */
import { chromium } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const here = path.dirname(fileURLToPath(import.meta.url))
const template = path.join(here, 'og', 'og-image.html')
const out = path.resolve(here, '..', 'public', 'og.png')

// playwright-core pins a browser revision; the one on disk may be a different
// (full, not headless_shell) build, so fall back to whatever Chromium the
// Playwright cache actually contains.
function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM
  const pinned = chromium.executablePath()
  if (existsSync(pinned)) return pinned
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright')
  const candidates = readdirSync(cache)
    .filter(d => d.startsWith('chromium'))
    .map(d => path.join(cache, d, 'chrome-linux', 'chrome'))
    .filter(existsSync)
  if (!candidates.length) throw new Error(`No Chromium under ${cache}; set PLAYWRIGHT_CHROMIUM`)
  return candidates[0]
}

const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
await page.goto('file://' + template)
await page.waitForTimeout(200)
await page.screenshot({ path: out, type: 'png' })
await browser.close()
console.log('wrote', path.relative(process.cwd(), out))
