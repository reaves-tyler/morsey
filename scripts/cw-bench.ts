/**
 * Decoder benchmark: synthesized band audio with known text, plus the real
 * recordings, scored the same way every time.
 *
 *   node scripts/cw-bench.ts                  # table
 *   node scripts/cw-bench.ts --json out.json  # also write the numbers
 *   node scripts/cw-bench.ts --wav dir        # also write each scenario at 48 kHz, to listen to
 *                                             # or to feed the live page through Chrome's fake capture
 *   node scripts/cw-bench.ts --only novice    # scenarios whose id contains "novice"
 *
 * Per scenario:
 *  - copy   character accuracy with spacing removed (1 − edit distance / length)
 *  - spaced the same with word spaces kept (a split or merged word costs one each)
 *  - junk   characters printed while nothing was being sent (the lead-in and
 *           tail are seconds of band noise), or anything at all for RTTY
 *  - lat    median and 90th-percentile time from the end of a character's last
 *           element to the moment it was printed, over correctly copied ones
 *
 * The real takes are scored on the phrases known to be in them and on junk,
 * as tests/cwDecoder.test.ts asserts. Runs on plain Node (type stripping).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  renderCw, renderRtty, characterEndTimes, decodeWav16, encodeWav16, ITU_CHANNELS,
  type CwSynthOptions
} from '../app/utils/cwSynth.ts'
import { CwDecoder, type CwDecoderConfig } from '../app/utils/cwDecoder.ts'

const FS = 8000
const root = join(import.meta.dirname, '..')
const fixtures = join(root, 'tests', 'fixtures')
const bed = (file: string) => decodeWav16(readFileSync(join(fixtures, file)).buffer as ArrayBuffer).samples
const bandNoise = bed('ft991a/991a-band-noise.wav')
const kenwoodStatic = bed('ts450s/ts450s-static.wav')

const args = process.argv.slice(2)
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const only = flag('--only')
const jsonOut = flag('--json')
const wavDir = flag('--wav')
const cfgPatch: Partial<CwDecoderConfig> = flag('--cfg') ? JSON.parse(flag('--cfg')!) : {}

// --- texts: what is actually on the air -----------------------------------------
const QSO_1 = 'KR4NZN DE W1ABC W1ABC TNX CALL UR RST 579 579 NAME BOB BOB QTH OHIO HW? KR4NZN DE W1ABC KN'
const QSO_2 = 'R R TNX BOB UR RST 599 5NN NAME TYLER QTH TN RIG TS450 PWR 100W ANT DIPOLE 73 <SK>'
const CQ = 'CQ CQ CQ DE KR4NZN KR4NZN K'
const CONTEST = 'CQ TEST K5XYZ K5XYZ TEST W1ABC 5NN 05 TU K5XYZ TEST'
const POTA = 'CQ POTA DE N4ABC N4ABC K KR4NZN 5NN TN TN BK TU 73 EE'

interface Scenario {
  id: string
  /** what the scenario stands for */
  note: string
  cw?: Omit<CwSynthOptions, 'sampleRate' | 'text'> & { text: string }
  rtty?: { text: string; snrDb: number }
  cfg?: Partial<CwDecoderConfig>
}

const LEAD = 4 // seconds of band noise before and after each over
const scenarios: Scenario[] = []
const add = (s: Scenario) => scenarios.push(s)

// machine-sent code across the speeds people run
for (const wpm of [15, 20, 25, 30, 35, 40]) {
  add({ id: `machine-${wpm}-awgn12`, note: `keyer ${wpm} WPM, 12 dB`, cw: { text: wpm >= 30 ? CONTEST : QSO_1, wpm, snrDb: 12, seed: wpm } })
}
// how weak it can get
for (const snr of [8, 5, 3]) {
  add({ id: `machine-20-awgn${snr}`, note: `keyer 20 WPM, ${snr} dB`, cw: { text: QSO_2, wpm: 20, snrDb: snr, seed: 40 + snr } })
}
// real static
add({ id: 'machine-22-band10', note: '22 WPM in real 40 m noise, 10 dB', cw: { text: POTA, wpm: 22, snrDb: 10, noise: bandNoise, seed: 3 } })
add({ id: 'machine-28-kenwood12', note: '28 WPM in the TS-450S static, 12 dB', cw: { text: CONTEST, wpm: 28, snrDb: 12, noise: kenwoodStatic, seed: 4 } })
// the ionosphere
for (const [name, ch] of Object.entries(ITU_CHANNELS)) {
  add({ id: `machine-25-${name}15`, note: `25 WPM, ITU ${name} fading, 15 dB`, cw: { text: QSO_1, wpm: 25, snrDb: 15, fading: ch, seed: 7 } })
}
add({ id: 'machine-18-qsb', note: '18 WPM, 80 % QSB, 15 dB', cw: { text: QSO_2, wpm: 18, snrDb: 15, qsb: { depth: 0.8, rateHz: 0.2 }, seed: 8 } })
// neighbours
add({
  id: 'machine-25-qrm', note: '25 WPM, stations 180 Hz and 450 Hz away',
  cw: { text: QSO_1, wpm: 25, snrDb: 15, qrm: [{ offsetHz: 180, level: 0.7, wpm: 30, text: 'CQ TEST DL1ABC DL1ABC' }, { offsetHz: -450, level: 2, wpm: 18, text: 'QRL? QRL? DE EA3XYZ' }], seed: 9 }
})
// fists
add({ id: 'paddle-24', note: 'paddle 24 WPM, 5 % jitter, 12 dB', cw: { text: QSO_1, wpm: 24, jitter: 0.05, snrDb: 12, seed: 10 } })
add({ id: 'bug-20', note: 'bug 20 WPM, heavy dahs 3.8, 12 % jitter', cw: { text: QSO_2, wpm: 20, weight: 3.8, jitter: 0.12, snrDb: 15, seed: 11 } })
// the operator's own fist as measured off the TS-450S: 17 WPM dits, 1.4-dit element
// gaps, 8–15-dit letter gaps
add({
  id: 'novice-17', note: 'straight key, long letter gaps (the KR4NZN fist)',
  cw: { text: CQ, wpm: 17, jitter: 0.15, weight: 3.1, spacing: { element: 1.4, letter: 3.5, word: 2 }, snrDb: 20, seed: 12 }
})
add({
  id: 'novice-13-band', note: 'slow straight key in real noise',
  cw: { text: CQ + ' ' + QSO_2, wpm: 13, jitter: 0.2, weight: 3.3, spacing: { element: 1.3, letter: 2, word: 1.6 }, snrDb: 12, noise: bandNoise, seed: 13 }
})
add({ id: 'farnsworth-20-10', note: 'Farnsworth 20/10', cw: { text: QSO_1, wpm: 20, effectiveWpm: 10, snrDb: 15, seed: 14 } })
// fast
add({ id: 'machine-40-poor12', note: '40 WPM, ITU poor, 12 dB', cw: { text: CONTEST, wpm: 40, snrDb: 12, fading: ITU_CHANNELS.poor, seed: 15 } })
// what must not print
add({ id: 'rtty-contest', note: 'RTTY 45.45 Bd 170 Hz — not CW', rtty: { text: 'CQ PP5KP PP5KP WW\nK7JQ TU PP5KP WW 599 11\nCQ PP5KP PP5KP WW\n', snrDb: 15 } })
add({ id: 'noise-only-band', note: 'real 40 m noise, nothing sent', cw: { text: '', snrDb: 10, noise: bandNoise, seed: 16 } })

// --- scoring --------------------------------------------------------------------
function editOps(a: string, b: string): { dist: number; match: Map<number, number> } {
  const n = a.length
  const m = b.length
  const d: number[][] = Array.from({ length: n + 1 }, (_, i) => { const r = new Array(m + 1).fill(0); r[0] = i; return r })
  for (let j = 0; j <= m; j++) d[0]![j] = j
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
  }
  // trace back which decoded index matched which truth index
  const match = new Map<number, number>()
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1] && d[i]![j] === d[i - 1]![j - 1]) { match.set(i - 1, j - 1); i--; j-- }
    else if (d[i]![j] === d[i - 1]![j - 1]! + 1) { i--; j-- }
    else if (d[i]![j] === d[i - 1]![j]! + 1) i--
    else j--
  }
  return { dist: d[n]![m]!, match }
}

interface Emitted { ch: string; atSec: number }

function decode(samples: Float32Array, cfg: Partial<CwDecoderConfig>): { text: string; emitted: Emitted[] } {
  let text = ''
  const emitted: Emitted[] = []
  const dec = new CwDecoder({ sampleRate: FS, ...cfg, ...cfgPatch }, {
    onCharacter: ch => { text += ch; emitted.push({ ch, atSec: dec.timeMs / 1000 }) },
    onWordGap: () => { text += ' ' }
  })
  for (let i = 0; i < samples.length; i += 512) dec.process(samples.subarray(i, Math.min(samples.length, i + 512)))
  dec.flush()
  return { text: text.replace(/\s+/g, ' ').trim(), emitted }
}

/** prosigns print as the table's own characters (AR as +, BT as =) or as <XX> */
function flatTruth(text: string): string {
  return text.toUpperCase().replace(/<AR>/g, '+').replace(/<BT>/g, '=').replace(/<KN>/g, '(').replace(/\s+/g, ' ').trim()
}
function flatDecoded(text: string): string {
  return text.replace(/<KN>/g, '(')
}

interface Row {
  id: string
  note: string
  copy: number
  spaced: number
  junk: number
  latMed: number
  latP90: number
  text: string
}

function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!
}

function runScenario(s: Scenario): Row {
  let samples: Float32Array
  let truth = ''
  let ends: { ch: string; end: number }[] = []
  let signalStart = 0
  let signalEnd = 0
  const toneHz = 700
  if (s.rtty) {
    const r = renderRtty({ text: s.rtty.text, snrDb: s.rtty.snrDb, markHz: toneHz, sampleRate: FS, leadInSec: LEAD, tailSec: LEAD, seed: 21 })
    samples = r.samples
    signalStart = signalEnd = r.duration
  } else {
    const r = renderCw({ ...s.cw!, toneHz, sampleRate: FS, amplitude: 0.3, leadInSec: LEAD, tailSec: LEAD })
    samples = r.samples
    truth = flatTruth(s.cw!.text)
    ends = characterEndTimes(s.cw!.text, r.segments)
    signalStart = r.segments[0]?.at ?? r.duration
    const last = r.segments[r.segments.length - 1]
    signalEnd = last ? last.at + last.dur : 0
  }
  if (wavDir) {
    mkdirSync(wavDir, { recursive: true })
    // 48 kHz for Chrome's fake capture (it stays silent on 8 kHz files)
    const hi = s.rtty
      ? renderRtty({ text: s.rtty.text, snrDb: s.rtty.snrDb, markHz: toneHz, sampleRate: 48000, leadInSec: LEAD, tailSec: LEAD, seed: 21 }).samples
      : renderCw({ ...s.cw!, noise: undefined, toneHz, sampleRate: 48000, amplitude: 0.3, leadInSec: LEAD, tailSec: LEAD }).samples
    writeFileSync(join(wavDir, `${s.id}.wav`), Buffer.from(encodeWav16(hi, 48000)))
  }
  const { text, emitted } = decode(samples, { centerHz: toneHz, ...s.cfg })
  const got = flatDecoded(text)
  const junk = emitted.filter(e => e.atSec < signalStart - 0.05 || e.atSec > signalEnd + 3).length
  if (!truth) {
    return { id: s.id, note: s.note, copy: NaN, spaced: NaN, junk: emitted.length, latMed: NaN, latP90: NaN, text: got }
  }
  const gotFlat = got.replace(/ /g, '')
  const truthFlat = truth.replace(/ /g, '')
  const { dist, match } = editOps(gotFlat, truthFlat)
  const spacedDist = editOps(got, truth).dist
  // latency over correctly copied characters: emission time − end of its last element
  const printed = emitted.map(e => e.ch).join('')
  const lat: number[] = []
  if (printed.length === gotFlat.length) {
    for (const [gi, ti] of match) {
      const e = emitted[gi]
      const t = ends[ti]
      if (e && t) lat.push((e.atSec - t.end) * 1000)
    }
  }
  return {
    id: s.id,
    note: s.note,
    copy: Math.max(0, 1 - dist / truthFlat.length),
    spaced: Math.max(0, 1 - spacedDist / truth.length),
    junk,
    latMed: quantile(lat, 0.5),
    latP90: quantile(lat, 0.9),
    text: got
  }
}

// --- real takes: phrases known to be in them ---------------------------------------
interface Take { file: string; phrases: string[]; toneHz?: number; mustBeSilent?: boolean }
const TAKES: Take[] = [
  { file: 'ft991a/991a-iota-cq.wav', phrases: ['CQ VE2/LX1NO/P IOTA NA128'] },
  { file: 'ft991a/991a-dennis-rig.wav', phrases: ['FB DENNIS', 'RIG HR IS'] },
  { file: 'ft991a/991a-wb3bvz-qth.wav', phrases: ['QTHISCAR', 'RST5'] },
  { file: 'ft991a/991a-dead-band.wav', phrases: ['QTEST'] },
  { file: 'ft991a/991a-k5wva-579.wav', phrases: ['KR4NZNK5WVATU579WV', 'CQCQTEST'] },
  { file: 'ft991a/991a-pota-ke2mtk.wav', phrases: ['POTADEKE2MT', 'KR4NZN'] },
  { file: 'ft991a/991a-pota-kg4exy.wav', phrases: ['57N57NBK', 'CQPOTAKG4EXY'] },
  { file: 'ft991a/991a-sota-w3pd029.wav', phrases: ['SOTAREFW3/PD029W3/PD029', 'TNX', 'NOPOTANOPOTA'] },
  { file: 'ft991a/991a-w2lcq-rst.wav', phrases: ['NZNDEW2LCQOKUR', '569569OK'] },
  { file: 'ft991a/991a-w2lcq-de.wav', phrases: ['DEW2LCQ'] },
  { file: 'ts450s/ts450s-own-cq.wav', phrases: ['CQKR4NZN'], toneHz: 885 },
  { file: 'ts450s/ts450s-kr4nzn-calls.wav', phrases: ['KR4NZN', 'KR4NZN', 'KR4NZN', 'KR4NZN', 'KR4NZN', 'KR4NZN'], toneHz: 885 },
  { file: 'ts450s/ts450s-rtty-pp5kp.wav', phrases: [], toneHz: 635, mustBeSilent: true },
  { file: 'ts450s/ts450s-static.wav', phrases: [], toneHz: 885, mustBeSilent: true }
]

interface TakeRow { file: string; found: number; wanted: number; chars: number; et: number; text: string }

function runTake(t: Take): TakeRow {
  const samples = bed(t.file)
  const { text, emitted } = decode(samples, t.toneHz ? { centerHz: t.toneHz } : {})
  let flat = text.replace(/\s+/g, '')
  let found = 0
  for (const p of t.phrases) {
    const q = p.replace(/ /g, '')
    const at = flat.indexOf(q)
    if (at >= 0) { found++; flat = flat.slice(0, at) + flat.slice(at + q.length) }
  }
  const chars = emitted.length
  const et = emitted.filter(e => e.ch === 'E' || e.ch === 'T').length / Math.max(1, chars)
  return { file: t.file, found, wanted: t.phrases.length, chars, et, text }
}

// --- report ------------------------------------------------------------------------
const pct = (x: number) => Number.isNaN(x) ? '   —' : `${(x * 100).toFixed(0).padStart(3)}%`
const ms = (x: number) => Number.isNaN(x) ? '    —' : `${x.toFixed(0).padStart(5)}`
const rows = scenarios.filter(s => !only || s.id.includes(only)).map(runScenario)
console.log(`${'scenario'.padEnd(22)} ${'copy'.padStart(4)} ${'spaced'.padStart(6)} ${'junk'.padStart(4)} ${'lat50'.padStart(5)} ${'lat90'.padStart(5)}  decoded`)
for (const r of rows) {
  console.log(`${r.id.padEnd(22)} ${pct(r.copy)} ${pct(r.spaced).padStart(6)} ${String(r.junk).padStart(4)} ${ms(r.latMed)} ${ms(r.latP90)}  ${r.text.slice(0, 90)}`)
}
const scored = rows.filter(r => !Number.isNaN(r.copy))
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
const lats = scored.map(r => r.latMed).filter(x => !Number.isNaN(x))
console.log(`\nmean copy ${pct(mean(scored.map(r => r.copy)))}  spaced ${pct(mean(scored.map(r => r.spaced)))}  junk ${rows.reduce((a, r) => a + r.junk, 0)}  median latency ${ms(quantile(lats, 0.5))} ms`)

const takeRows = only ? [] : TAKES.map(runTake)
if (takeRows.length) {
  console.log(`\n${'real take'.padEnd(34)} phrases  chars  E/T`)
  for (const r of takeRows) {
    console.log(`${r.file.padEnd(34)} ${`${r.found}/${r.wanted}`.padStart(7)} ${String(r.chars).padStart(6)} ${pct(r.et)}  ${r.text.slice(0, 80)}`)
  }
  const found = takeRows.reduce((a, r) => a + r.found, 0)
  const wanted = takeRows.reduce((a, r) => a + r.wanted, 0)
  console.log(`phrases copied ${found}/${wanted}, characters printed ${takeRows.reduce((a, r) => a + r.chars, 0)}`)
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ rows, takeRows }, null, 2))
