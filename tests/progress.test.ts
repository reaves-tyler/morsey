import { describe, expect, it } from 'vitest'
import { parseProgressJson } from '../app/composables/useProgress'

/**
 * The backup/import path guards user data and must survive schema evolution —
 * settings fields have been added several times already.
 */

const minimalV1 = {
  xp: 1234,
  koch: { lesson: 5, window: [true, false], attemptsInLesson: 7 }
}

describe('parseProgressJson', () => {
  it('rejects invalid JSON with a readable error', () => {
    const r = parseProgressJson('{oops')
    expect('error' in r && r.error).toMatch(/not valid JSON/)
  })

  it('rejects JSON that is not a progress object', () => {
    for (const bad of ['[1,2,3]', '"hi"', 'null', '{"hello":"world"}', '{"xp":"lots"}']) {
      const r = parseProgressJson(bad)
      expect('error' in r, bad).toBe(true)
    }
  })

  it('accepts a minimal old backup and fills every newer field with defaults', () => {
    const r = parseProgressJson(JSON.stringify(minimalV1))
    expect('state' in r).toBe(true)
    const state = ('state' in r && r.state)!
    // core data preserved
    expect(state.xp).toBe(1234)
    expect(state.koch.lesson).toBe(5)
    expect(state.koch.window).toEqual([true, false])
    // fields added after v1 get defaults instead of undefined
    expect(state.history).toEqual({})
    expect(state.chars).toEqual({})
    expect(state.phraseStreaks).toEqual({})
    expect(state.settings.charWpm).toBe(20)
    expect(state.settings.keyType).toBe('iambic-a')
    expect(state.settings.qrnLevel).toBe(0)
    expect(state.settings.myCall).toBe('N0CALL')
    // keyer feel knobs (newest additions)
    expect(state.settings.debounceMs).toBe(20)
    expect(state.settings.keyerWeight).toBe(3)
    expect(state.settings.dahThresholdUnits).toBe(2)
    expect(state.settings.adaptiveDit).toBe(true)
    expect(state.settings.letterGapUnits).toBe(4)
    expect(state.settings.wordGapUnits).toBe(8)
  })

  it('a partial settings object merges over defaults without losing either side', () => {
    const r = parseProgressJson(JSON.stringify({
      ...minimalV1,
      settings: { sendWpm: 18, keyType: 'bug' }
    }))
    const state = ('state' in r && r.state)!
    expect(state.settings.sendWpm).toBe(18)
    expect(state.settings.keyType).toBe('bug')
    expect(state.settings.effectiveWpm).toBe(10) // default retained
  })

  it('round-trips a full state exactly (export → parse → identical)', () => {
    const first = parseProgressJson(JSON.stringify({
      ...minimalV1,
      totalAnswers: 50,
      totalCorrect: 44,
      streakDays: 3,
      chars: { K: { seen: 10, correct: 9 } },
      phraseStreaks: { CQ: 3 },
      history: { '2026-08-17': { answers: 5, correct: 4, xp: 60 } }
    }))
    const state = ('state' in first && first.state)!
    const second = parseProgressJson(JSON.stringify(state))
    expect(('state' in second && second.state)).toEqual(state)
  })
})
