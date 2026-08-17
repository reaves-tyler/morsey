import { describe, expect, it } from 'vitest'
import { MORSE, KOCH_ORDER, morseTimings, textToSchedule, patternFor, wordPattern } from '../app/utils/morse'

describe('morseTimings — ARRL Farnsworth math', () => {
  it('computes standard element lengths at equal speeds', () => {
    const t = morseTimings(20, 20)
    expect(t.dit).toBeCloseTo(0.06, 10) // 1.2 / 20
    expect(t.dah).toBeCloseTo(0.18, 10)
    expect(t.elementGap).toBeCloseTo(0.06, 10)
    // no stretching: nominal 3u / 7u gaps
    expect(t.charGap).toBeCloseTo(0.18, 10)
    expect(t.wordGap).toBeCloseTo(0.42, 10)
  })

  it('stretches spacing per the ARRL Farnsworth formula at 20/10', () => {
    // ta = (60c - 37.2s) / (sc) = (1200 - 372) / 200 = 4.14 s of delay budget,
    // split 3:19 per char gap and 7:19 per word gap
    const t = morseTimings(20, 10)
    expect(t.dit).toBeCloseTo(0.06, 10) // character speed unchanged — Koch rule
    expect(t.charGap).toBeCloseTo((3 * 4.14) / 19, 10)
    expect(t.wordGap).toBeCloseTo((7 * 4.14) / 19, 10)
  })

  it('never compresses below nominal when effective >= char speed', () => {
    const t = morseTimings(20, 25)
    expect(t.charGap).toBeCloseTo(3 * t.dit, 10)
    expect(t.wordGap).toBeCloseTo(7 * t.dit, 10)
  })
})

describe('textToSchedule — the playback compiler', () => {
  const t = morseTimings(20, 20)
  const u = t.dit

  it('gives PARIS its definitional 43 sounded units (50 with the word gap)', () => {
    // PARIS is THE canonical WPM word: 50 units including the trailing 7-unit
    // word gap, i.e. 43 units from first element to end of last element.
    const { total } = textToSchedule('PARIS', t)
    expect(total / u).toBeCloseTo(43, 6)
  })

  it('spaces words by the word gap', () => {
    // "E E" = dit(1) + wordGap(7) + dit(1) = 9 units end-to-end
    const { segments, total } = textToSchedule('E E', t)
    expect(segments).toHaveLength(2)
    expect(total / u).toBeCloseTo(9, 6)
  })

  it('sends prosigns merged with element gaps only', () => {
    // <AR> = .-.-. = 1+3+1+3+1 sounded + 4 single-unit gaps = 13 units,
    // and must equal the canonical AR pattern
    const { segments, total } = textToSchedule('<AR>', t)
    expect(segments).toHaveLength(5)
    expect(total / u).toBeCloseTo(13, 6)
    const pattern = segments.map(s => (s.dur > u * 2 ? '-' : '.')).join('')
    expect(pattern).toBe('.-.-.')
  })

  it('a prosign is shorter than the same letters sent separately', () => {
    const merged = textToSchedule('<AR>', t).total
    const separate = textToSchedule('AR', t).total
    expect(merged).toBeLessThan(separate)
  })

  it('skips unknown characters without corrupting the schedule', () => {
    const clean = textToSchedule('EE', t)
    const dirty = textToSchedule('E#E', t)
    expect(dirty.segments).toHaveLength(clean.segments.length)
  })

  it('produces non-overlapping, ordered segments', () => {
    const { segments } = textToSchedule('CQ DX DE <SK>', t)
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i]!.at).toBeGreaterThanOrEqual(segments[i - 1]!.at + segments[i - 1]!.dur)
    }
  })
})

describe('pattern helpers', () => {
  it('patternFor handles characters and prosign tokens', () => {
    expect(patternFor('K')).toBe('-.-')
    expect(patternFor('<AR>')).toBe('.-.-.')
    expect(patternFor('?')).toBe('..--..')
  })

  it('wordPattern separates characters and words', () => {
    expect(wordPattern('CQ DX')).toBe('-.-. --.- / -.. -..-')
  })

  it('every Koch character has a code', () => {
    for (const char of KOCH_ORDER) expect(MORSE[char], char).toBeTruthy()
  })
})
