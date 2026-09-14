import { describe, it, expect } from 'vitest'
import { MonitorAgc } from '../app/utils/monitorAgc'

const SR = 48000
const db = (x: number) => 20 * Math.log10(Math.max(1e-9, x))

/** a 700 Hz tone at `levelDb` peak, keyed by `on(t)`; returns the samples */
function tone(seconds: number, levelDb: number, on: (t: number) => boolean = () => true): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR))
  const amp = Math.pow(10, levelDb / 20)
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    out[i] = on(t) ? amp * Math.sin(2 * Math.PI * 700 * t) : 0
  }
  return out
}

function run(agc: MonitorAgc, input: Float32Array, block = 128): Float32Array {
  const out = new Float32Array(input.length)
  for (let p = 0; p < input.length; p += block) {
    const n = Math.min(block, input.length - p)
    agc.process(input.subarray(p, p + n), out.subarray(p, p + n))
  }
  return out
}

function peak(x: Float32Array, from: number, to: number): number {
  let m = 0
  for (let i = Math.floor(from * SR); i < Math.min(x.length, Math.floor(to * SR)); i++) m = Math.max(m, Math.abs(x[i] as number))
  return m
}

describe('MonitorAgc', () => {
  it('lifts a quiet receive tone to the target level', () => {
    const agc = new MonitorAgc(SR)
    const out = run(agc, tone(3, -38))
    // -38 dBFS needs +26 dB: within the +30 dB cap, so it should reach -12 dBFS
    expect(db(peak(out, 2.5, 3))).toBeGreaterThan(-13)
    expect(db(peak(out, 2.5, 3))).toBeLessThan(-11)
    expect(agc.gainDb()).toBeGreaterThan(24)
  })

  it('tames a full-scale sidetone to the same target', () => {
    const agc = new MonitorAgc(SR)
    const out = run(agc, tone(1, 0))
    expect(db(peak(out, 0.5, 1))).toBeGreaterThan(-13)
    expect(db(peak(out, 0.5, 1))).toBeLessThan(-11)
  })

  it('caps the gain so silence and band noise are not lifted to the target', () => {
    const agc = new MonitorAgc(SR)
    run(agc, tone(4, -70))
    expect(agc.gainDb()).toBeLessThanOrEqual(30.01)
  })

  it('catches a loud transmission after a quiet one without a blast', () => {
    const agc = new MonitorAgc(SR)
    const quiet = tone(3, -38)
    const loud = tone(0.5, 0)
    const input = new Float32Array(quiet.length + loud.length)
    input.set(quiet)
    input.set(loud, quiet.length)
    const out = run(agc, input)
    // the lookahead has the gain down before the onset is heard: no full-scale burst
    expect(db(peak(out, 3, 3.03))).toBeLessThan(-6)
    // and it is at the target within 50 ms
    expect(db(peak(out, 3.05, 3.1))).toBeGreaterThan(-13)
    expect(db(peak(out, 3.05, 3.1))).toBeLessThan(-11)
    expect(db(peak(out, 3.4, 3.5))).toBeLessThan(-11)
  })

  it('holds the gain through the gaps of a keyed transmission', () => {
    const agc = new MonitorAgc(SR)
    // 300 ms marks with 700 ms gaps (a slow word gap), -30 dBFS
    const input = tone(6, -30, t => (t % 1) < 0.3)
    const gains: number[] = []
    for (let p = 0; p < input.length; p += 128) {
      agc.process(input.subarray(p, p + 128), new Float32Array(128))
      gains.push(agc.gainDb())
    }
    // once settled (from 3 s on), the gain must not pump in the gaps
    const settled = gains.slice(Math.floor(3 * SR / 128))
    expect(Math.max(...settled) - Math.min(...settled)).toBeLessThan(1)
  })

  it('recovers within a few seconds once a loud transmission ends', () => {
    const agc = new MonitorAgc(SR)
    run(agc, tone(1, 0))
    run(agc, tone(4, -38))
    // 1.2 s hang + 26 dB at 15 dB/s ≈ 3 s
    expect(agc.gainDb()).toBeGreaterThan(24)
  })

  it('passes audio through at unity when disabled', () => {
    const agc = new MonitorAgc(SR)
    agc.setEnabled(false)
    const input = tone(1, -20)
    const out = run(agc, input)
    expect(db(peak(out, 0.5, 1))).toBeCloseTo(-20, 1)
  })

  it('stays self-contained so the browser can embed it in a worklet', () => {
    // the adapter ships `MonitorAgc.toString()` inside an AudioWorklet blob:
    // the class must not depend on anything from this module's scope
    const Embedded = new Function(`return ${MonitorAgc.toString()}`)() as typeof MonitorAgc
    const a = new MonitorAgc(SR)
    const b = new Embedded(SR)
    const input = tone(0.5, -25, t => (t % 0.2) < 0.1)
    const outA = run(a, input)
    const outB = run(b, input)
    expect(Array.from(outB.subarray(0, 2000))).toEqual(Array.from(outA.subarray(0, 2000)))
    expect(b.gainDb()).toBeCloseTo(a.gainDb(), 6)
  })
})
