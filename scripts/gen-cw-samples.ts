/**
 * Render the sample library (app/utils/cwSynth.ts → SAMPLE_PRESETS) to WAV
 * files under public/samples/cw so the decode page can stream them and so
 * they can be played into a sound card for hardware bring-up.
 *
 *   pnpm run samples
 *
 * Runs on plain Node (type stripping) — no bundler involved.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderCw, encodeWav16, SAMPLE_PRESETS } from '../app/utils/cwSynth.ts'

const SAMPLE_RATE = 8000
const outDir = join(import.meta.dirname, '..', 'public', 'samples', 'cw')
mkdirSync(outDir, { recursive: true })

const index = SAMPLE_PRESETS.map((preset) => {
  const { samples, duration } = renderCw({ sampleRate: SAMPLE_RATE, ...preset.options })
  const wav = encodeWav16(samples, SAMPLE_RATE)
  const file = `${preset.id}.wav`
  writeFileSync(join(outDir, file), Buffer.from(wav))
  console.log(`${file.padEnd(24)} ${duration.toFixed(1).padStart(5)} s  ${(wav.byteLength / 1024).toFixed(0).padStart(4)} KB  ${preset.name}`)
  return { id: preset.id, file, name: preset.name, description: preset.description, difficulty: preset.difficulty, text: preset.options.text, seconds: Math.round(duration * 10) / 10 }
})
writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n')
console.log(`\n${index.length} samples → ${outDir}`)
