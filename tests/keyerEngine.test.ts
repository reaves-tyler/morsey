import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { KeyerEngine, type KeyerConfig } from '../app/utils/keyerEngine'

/**
 * Deterministic tests for the keyer state machines, run under fake timers.
 * At the default 12 WPM test speed one unit (dit) is exactly 100 ms:
 * dit = 100, dah = 300, inter-element gap = 100, letter commit = 450,
 * word gap = 1200, fresh manual dah threshold = 200.
 */

function makeHarness(cfg: Partial<KeyerConfig> = {}) {
  const config: KeyerConfig = { keyType: 'iambic-a', paddleReverse: false, sendWpm: 12, ...cfg }
  const state = {
    symbols: '', decoded: '', tone: false, toneCount: 0, adaptive: 0, preview: '' as string,
    manual: [] as { el: string, dur: number, gap: number }[]
  }
  const engine = new KeyerEngine({
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: h => clearTimeout(h as ReturnType<typeof setTimeout>),
    config: () => config,
    onToneStart: () => { state.tone = true; state.toneCount++ },
    onToneEnd: () => { state.tone = false },
    onSymbols: (s) => { state.symbols = s },
    onLetter: (c) => { state.decoded += c },
    // Same guard as the app adapter: silence only counts as a word boundary
    // when there is decoded text that isn't already spaced
    onWordGap: () => {
      if (state.decoded && !state.decoded.endsWith(' ')) state.decoded += ' '
    },
    onHoldPreview: (p) => { state.preview = p },
    onAdaptiveDit: (ms) => { state.adaptive = ms },
    onManualElement: (el, dur, gap) => { state.manual.push({ el, dur, gap }) }
  })
  return { engine, config, state }
}

const tick = (ms: number) => vi.advanceTimersByTime(ms)

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('straight key', () => {
  it('classifies a short tap as a dit and decodes E', () => {
    const { engine, state } = makeHarness({ keyType: 'straight' })
    engine.contactDown('tip')
    expect(state.tone).toBe(true)
    tick(80)
    engine.contactUp('tip')
    expect(state.tone).toBe(false)
    expect(state.symbols).toBe('.')
    tick(450)
    expect(state.decoded).toBe('E')
  })

  it('classifies a long hold as a dah and decodes T', () => {
    const { engine, state } = makeHarness({ keyType: 'straight' })
    engine.contactDown('tip')
    tick(400)
    engine.contactUp('tip')
    expect(state.symbols).toBe('-')
    tick(450)
    expect(state.decoded).toBe('T')
  })

  it('inserts a word gap after enough silence', () => {
    const { engine, state } = makeHarness({ keyType: 'straight' })
    engine.contactDown('tip')
    tick(80)
    engine.contactUp('tip')
    tick(1200)
    expect(state.decoded).toBe('E ')
  })

  it('ignores the ring contact entirely (mono-plug safety)', () => {
    const { engine, state } = makeHarness({ keyType: 'straight' })
    engine.contactDown('ring')
    expect(state.tone).toBe(false)
    tick(500)
    engine.contactUp('ring')
    tick(2000)
    expect(state.symbols).toBe('')
    expect(state.decoded).toBe('')
  })

  it('discards sub-debounce contact bounce', () => {
    const { engine, state } = makeHarness({ keyType: 'straight' })
    engine.contactDown('tip')
    tick(10)
    engine.contactUp('tip')
    tick(2000)
    expect(state.symbols).toBe('')
    expect(state.decoded).toBe('')
  })

  it('shows a live hold preview that flips to dah at the threshold', () => {
    const { engine, state } = makeHarness({ keyType: 'straight' })
    engine.contactDown('tip')
    expect(state.preview).toBe('.')
    tick(250) // past the fresh 200 ms threshold
    expect(state.preview).toBe('-')
    engine.contactUp('tip')
    expect(state.preview).toBe('')
  })

  it('reports manual element timings for fist analysis', () => {
    const { engine, state } = makeHarness({ keyType: 'straight' })
    engine.contactDown('tip')
    tick(80)
    engine.contactUp('tip') // dit, first of run
    tick(120)
    engine.contactDown('tip')
    tick(320)
    engine.contactUp('tip') // dah, 120 ms gap before
    expect(state.manual).toEqual([
      { el: '.', dur: 80, gap: -1 },
      { el: '-', dur: 320, gap: 120 }
    ])
  })

  it('calibrates the dit estimate toward the operator', () => {
    const { engine, state } = makeHarness({ keyType: 'straight' })
    engine.contactDown('tip')
    tick(150) // slow dit (still < 200 threshold)
    engine.contactUp('tip')
    // est' = 0.7 * 100 + 0.3 * 150
    expect(state.adaptive).toBeCloseTo(115, 5)
    expect(engine.dahThresholdMs()).toBe(230)
  })
})

describe('iambic A', () => {
  it('streams machine-timed dits while the dit paddle is held', () => {
    const { engine, state } = makeHarness({ keyType: 'iambic-a' })
    engine.contactDown('tip')
    tick(560) // three full dit cycles (100 on + 100 off each)
    engine.contactUp('tip')
    tick(1000)
    expect(state.decoded).toBe('S')
  })

  it('alternates on squeeze and stops clean on release (no memory)', () => {
    const { engine, state } = makeHarness({ keyType: 'iambic-a' })
    engine.contactDown('tip')
    tick(10)
    engine.contactDown('ring')
    tick(440) // dit 0-100, gap to 200, dah 200-500: release mid-dah
    engine.contactUp('tip')
    engine.contactUp('ring')
    tick(1000) // past the 450 ms letter commit, short of the 1200 ms word gap
    expect(state.decoded).toBe('A') // .- with NO trailing memory element
  })
})

describe('iambic B', () => {
  it('adds exactly one opposite element when a squeeze is released mid-element', () => {
    const { engine, state } = makeHarness({ keyType: 'iambic-b' })
    engine.contactDown('tip')
    tick(10)
    engine.contactDown('ring')
    tick(440) // release mid-dah, squeeze latched
    engine.contactUp('tip')
    engine.contactUp('ring')
    tick(1000) // past the 450 ms letter commit, short of the 1200 ms word gap
    expect(state.decoded).toBe('R') // .-. — the Curtis-B memory dit
  })

  it('adds no memory element without a squeeze', () => {
    const { engine, state } = makeHarness({ keyType: 'iambic-b' })
    engine.contactDown('tip')
    tick(150) // release during the inter-element gap
    engine.contactUp('tip')
    tick(1000) // past the 450 ms letter commit, short of the 1200 ms word gap
    expect(state.decoded).toBe('E')
  })
})

describe('paddle reverse', () => {
  it('swaps tip to dah', () => {
    const { engine, state } = makeHarness({ keyType: 'iambic-a', paddleReverse: true })
    engine.contactDown('tip')
    tick(150)
    engine.contactUp('tip')
    tick(1000) // past the 450 ms letter commit, short of the 1200 ms word gap
    expect(state.decoded).toBe('T')
  })
})

describe('bug', () => {
  it('streams automatic dits on the dit lever', () => {
    const { engine, state } = makeHarness({ keyType: 'bug' })
    engine.contactDown('tip')
    tick(560)
    engine.contactUp('tip')
    tick(1000)
    expect(state.decoded).toBe('S')
  })

  it('keys manual dahs on the other lever', () => {
    const { engine, state } = makeHarness({ keyType: 'bug' })
    engine.contactDown('ring')
    tick(400)
    engine.contactUp('ring')
    tick(1000)
    expect(state.decoded).toBe('T')
  })

  it('mixes auto dits and a manual dah into one letter', () => {
    const { engine, state } = makeHarness({ keyType: 'bug' })
    engine.contactDown('tip') // two auto dits: cycles end at 200 and 400
    tick(360)
    engine.contactUp('tip')
    tick(60) // brief human transition, well inside the letter gap
    engine.contactDown('ring')
    tick(320)
    engine.contactUp('ring')
    tick(1000)
    expect(state.decoded).toBe('U') // ..-
  })
})

describe('feel knobs — the rig menu', () => {
  it('weight stretches iambic dahs (dah = weight × dit)', () => {
    // At weight 4 a dah is 400 ms. Holding dah for 450 ms covers one
    // dah (400) but releases during its gap → single 'T'. At the standard
    // weight 3 the same hold reaches a second dah → 'M'.
    const heavy = makeHarness({ keyType: 'iambic-a', weight: 4 })
    heavy.engine.contactDown('ring')
    tick(450)
    heavy.engine.contactUp('ring')
    tick(1000)
    expect(heavy.state.decoded).toBe('T')

    const standard = makeHarness({ keyType: 'iambic-a' })
    standard.engine.contactDown('ring')
    tick(450)
    standard.engine.contactUp('ring')
    tick(1000)
    expect(standard.state.decoded).toBe('M')
  })

  it('dah threshold moves the manual classification boundary', () => {
    // 170 ms press at 12 WPM (unit 100 ms): below the default 200 ms
    // threshold it's a dit; with the knob at 1.6 (=160 ms) it's a dah.
    const tight = makeHarness({ keyType: 'straight', dahThresholdUnits: 1.6, adaptive: false })
    tight.engine.contactDown('tip')
    tick(170)
    tight.engine.contactUp('tip')
    expect(tight.state.symbols).toBe('-')

    const standard = makeHarness({ keyType: 'straight', adaptive: false })
    standard.engine.contactDown('tip')
    tick(170)
    standard.engine.contactUp('tip')
    expect(standard.state.symbols).toBe('.')
  })

  it('adaptive off keeps a fixed threshold derived from the keyer speed', () => {
    const { engine, state } = makeHarness({ keyType: 'straight', adaptive: false })
    engine.contactDown('tip')
    tick(150) // a slow dit that would normally recalibrate
    engine.contactUp('tip')
    expect(state.adaptive).toBe(0) // no calibration event
    expect(engine.dahThresholdMs()).toBe(200) // still nominal 2 × 100 ms
  })

  it('debounce knob sets the chatter cutoff', () => {
    const strict = makeHarness({ keyType: 'straight', debounceMs: 50 })
    strict.engine.contactDown('tip')
    tick(30)
    strict.engine.contactUp('tip')
    expect(strict.state.symbols).toBe('') // 30 ms discarded under a 50 ms floor

    const loose = makeHarness({ keyType: 'straight', debounceMs: 10 })
    loose.engine.contactDown('tip')
    tick(30)
    loose.engine.contactUp('tip')
    expect(loose.state.symbols).toBe('.') // same press accepted
  })

  it('letter/word gap knobs change decoder patience', () => {
    // letterGapUnits 3 at 12 WPM → commit at max(300, 3×112.5) = 337.5 ms
    const quick = makeHarness({ keyType: 'straight', letterGapUnits: 3, wordGapUnits: 6 })
    quick.engine.contactDown('tip')
    tick(80)
    quick.engine.contactUp('tip')
    tick(330)
    expect(quick.state.decoded).toBe('') // just before commit
    tick(20)
    expect(quick.state.decoded).toBe('E') // committed ~150 ms sooner than default
    tick(600) // word gap at 6×150 = 900 total
    expect(quick.state.decoded).toBe('E ')
  })
})

describe('housekeeping', () => {
  it('clear() drops pending symbols so no letter commits', () => {
    const { engine, state } = makeHarness({ keyType: 'straight' })
    engine.contactDown('tip')
    tick(80)
    engine.contactUp('tip')
    engine.clear()
    tick(2000)
    expect(state.symbols).toBe('')
    expect(state.decoded).toBe('')
  })

  it('reset() mid-element silences the tone and commits nothing', () => {
    const { engine, state } = makeHarness({ keyType: 'iambic-a' })
    engine.contactDown('tip')
    tick(50) // mid-dit
    engine.reset()
    expect(state.tone).toBe(false)
    tick(2000)
    expect(state.symbols).toBe('')
    expect(state.decoded).toBe('')
  })

  it('follows live key-type changes from config', () => {
    const { engine, state, config } = makeHarness({ keyType: 'straight' })
    engine.contactDown('tip')
    tick(80)
    engine.contactUp('tip')
    tick(450)
    config.keyType = 'iambic-a'
    engine.contactDown('tip')
    tick(160)
    engine.contactUp('tip')
    tick(1000) // past the 450 ms letter commit, short of the 1200 ms word gap
    expect(state.decoded).toBe('EE')
  })
})
