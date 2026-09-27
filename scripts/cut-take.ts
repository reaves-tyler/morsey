/**
 * Cut a decoder test fixture out of a Rec-button take: a time window,
 * resampled to 8 kHz the way the committed fixtures are (windowed-sinc
 * lowpass, then decimation), 16-bit mono.
 *
 *   node scripts/cut-take.ts <take.wav> <out.wav> <startSec> <endSec> [rateHz]
 *
 * Runs on plain Node (type stripping) — no bundler involved.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { decodeWav16, encodeWav16 } from '../app/utils/cwSynth.ts'

const [input, output, startArg, endArg, rateArg] = process.argv.slice(2)
if (!input || !output || startArg === undefined || endArg === undefined) {
  console.error('usage: node scripts/cut-take.ts <take.wav> <out.wav> <startSec> <endSec> [rateHz]')
  process.exit(1)
}

const { samples, sampleRate } = decodeWav16(readFileSync(input).buffer as ArrayBuffer)
const outRate = Number(rateArg ?? 8000)
const s0 = Math.max(0, Math.round(Number(startArg) * sampleRate))
const s1 = Math.min(samples.length, Math.round(Number(endArg) * sampleRate))
const clip = samples.subarray(s0, s1)

function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return Float32Array.from(x)
  const ratio = from / to
  // Blackman-windowed sinc, cutoff just under the new Nyquist
  const cutoff = 0.45 * Math.min(1, to / from)
  const half = 96
  const out = new Float32Array(Math.floor(x.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const centre = i * ratio
    const c0 = Math.floor(centre)
    let acc = 0
    let norm = 0
    for (let k = -half; k <= half; k++) {
      const j = c0 + k
      if (j < 0 || j >= x.length) continue
      const t = j - centre
      const sinc = t === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * t) / (Math.PI * t)
      const w = 0.42 + 0.5 * Math.cos((Math.PI * t) / (half + 1)) + 0.08 * Math.cos((2 * Math.PI * t) / (half + 1))
      acc += x[j]! * sinc * w
      norm += sinc * w
    }
    out[i] = norm ? acc / norm : 0
  }
  return out
}

const out = resample(clip, sampleRate, outRate)
writeFileSync(output, Buffer.from(encodeWav16(out, outRate)))
console.log(`${output}: ${(out.length / outRate).toFixed(1)} s at ${outRate} Hz from ${input} ${startArg}–${endArg} s`)
