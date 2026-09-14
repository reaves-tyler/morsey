/**
 * Monitor AGC — levels the headphone passthrough on the decode page.
 *
 * A rig's headphone jack carries two very different levels: its own sidetone
 * while transmitting (near full scale on a line input) and whatever the AF
 * gain is set to while receiving (often 20–30 dB lower, because the operator
 * turned it down so the sidetone wouldn't hurt). Without leveling the
 * operator rides the computer's volume between every over and back.
 *
 * This is a radio-style AGC rather than a speech compressor, because the
 * signal is a keyed tone: the peak envelope is held through the gaps of a
 * transmission (`hangMs`) so the band noise between characters is not pumped
 * up, and only after a transmission ends does the gain climb back at
 * `decayDbPerSec`. A loud first dit is caught before it is heard: the audio
 * is delayed by `lookaheadMs` while the detector runs on the undelayed input,
 * so a fast attack (`attackMs`) has the gain down by the time the onset
 * reaches the output, with a soft limiter behind it for whatever is left.
 * Gain is capped at `maxGainDb` so silence and band noise cannot be lifted
 * to the target, and floored at `minGainDb`.
 *
 * Pure DSP, no Web Audio: the browser adapter embeds this class *verbatim*
 * in an AudioWorklet blob via `MonitorAgc.toString()`, so it must stay
 * self-contained — no imports, no module-level constants, no class fields
 * (which a bundler may lower to helper calls); everything is set up in the
 * constructor and uses only `Math`.
 */

export interface MonitorAgcOptions {
  /** peak envelope the output is levelled to, dBFS */
  targetDb: number
  /** most gain the leveller will add, dB (limits how far silence/noise is lifted) */
  maxGainDb: number
  /** most attenuation it will apply to a hot input, dB (negative) */
  minGainDb: number
  /** gain-reduction time constant, ms — how fast a loud onset is tamed */
  attackMs: number
  /** how long the peak is held after the last louder sample before the gain may recover, ms */
  hangMs: number
  /** gain recovery rate once the hang has expired, dB per second */
  decayDbPerSec: number
  /** delay applied to the audio so the gain reduction leads a loud onset, ms */
  lookaheadMs: number
}

/** the class default for `lookaheadMs` (kept as a literal inside the class, which must stay self-contained) */
export const MONITOR_AGC_LOOKAHEAD_MS = 8

export class MonitorAgc {
  // options (resolved)
  target: number
  maxGain: number
  minGain: number
  attackCoef: number
  releaseCoef: number
  envAttackCoef: number
  envReleaseCoef: number
  hangSamples: number
  holdDecay: number
  holdFloor: number
  delay: Float32Array
  dpos: number
  // state
  env: number
  hold: number
  hang: number
  gain: number
  enabled: boolean

  constructor(sampleRate: number, opts?: Partial<MonitorAgcOptions>) {
    const o = opts || {}
    const targetDb = o.targetDb == null ? -12 : o.targetDb
    const maxGainDb = o.maxGainDb == null ? 30 : o.maxGainDb
    const minGainDb = o.minGainDb == null ? -30 : o.minGainDb
    const attackMs = o.attackMs == null ? 1 : o.attackMs
    const lookaheadMs = o.lookaheadMs == null ? 8 : o.lookaheadMs
    const hangMs = o.hangMs == null ? 1200 : o.hangMs
    const decayDbPerSec = o.decayDbPerSec == null ? 15 : o.decayDbPerSec
    const coef = (ms: number) => 1 - Math.exp(-1000 / (Math.max(0.01, ms) * sampleRate))
    this.target = Math.pow(10, targetDb / 20)
    this.maxGain = Math.pow(10, maxGainDb / 20)
    this.minGain = Math.pow(10, minGainDb / 20)
    this.attackCoef = coef(attackMs)
    // recovery is paced by the hold decay; this only smooths the steps
    this.releaseCoef = coef(50)
    // peak follower: near-instant attack, lets go over a few cycles of any CW pitch
    this.envAttackCoef = coef(0.2)
    this.envReleaseCoef = coef(30)
    this.delay = new Float32Array(Math.max(1, Math.round(lookaheadMs / 1000 * sampleRate)))
    this.dpos = 0
    this.hangSamples = Math.round(hangMs / 1000 * sampleRate)
    this.holdDecay = Math.pow(10, -decayDbPerSec / 20 / sampleRate)
    // below this peak the gain is already at its cap: nothing to track
    this.holdFloor = this.target / this.maxGain
    this.env = 0
    this.hold = this.holdFloor
    this.hang = 0
    this.gain = 1
    this.enabled = true
  }

  setEnabled(on: boolean): void {
    this.enabled = on
  }

  /** current gain in dB (what the readout shows) */
  gainDb(): number {
    return 20 * Math.log10(Math.max(1e-9, this.gain))
  }

  /** forget the levels (the gain fades from its current value rather than jumping) */
  reset(): void {
    this.env = 0
    this.hold = this.holdFloor
    this.hang = 0
    this.delay.fill(0)
  }

  /** level `input` into `output` (same length; may be the same array) */
  process(input: Float32Array, output: Float32Array): void {
    let env = this.env
    let hold = this.hold
    let hang = this.hang
    let gain = this.gain
    let dpos = this.dpos
    const delay = this.delay
    const dlen = delay.length
    const n = input.length
    for (let i = 0; i < n; i++) {
      const x = input[i] as number
      const a = x < 0 ? -x : x
      env += (a - env) * (a > env ? this.envAttackCoef : this.envReleaseCoef)
      if (env >= hold) {
        hold = env
        hang = this.hangSamples
      } else if (hang > 0) {
        hang--
      } else {
        hold *= this.holdDecay
        if (hold < this.holdFloor) hold = this.holdFloor
      }
      let want = 1
      if (this.enabled) {
        want = this.target / hold
        if (want > this.maxGain) want = this.maxGain
        else if (want < this.minGain) want = this.minGain
      }
      gain += (want - gain) * (want < gain ? this.attackCoef : this.releaseCoef)
      // the gain computed from this sample is applied to the one `lookahead` earlier
      const delayed = delay[dpos] as number
      delay[dpos] = x
      dpos = dpos + 1 === dlen ? 0 : dpos + 1
      let y = delayed * gain
      // soft limiter above 0.7 so the attack window cannot clip
      if (y > 0.7) y = 0.7 + 0.3 * Math.tanh((y - 0.7) / 0.3)
      else if (y < -0.7) y = -0.7 - 0.3 * Math.tanh((-y - 0.7) / 0.3)
      output[i] = y
    }
    this.env = env
    this.hold = hold
    this.hang = hang
    this.gain = gain
    this.dpos = dpos
  }
}
