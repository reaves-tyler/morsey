import { describe, it, expect } from 'vitest'
import { splitPattern } from '../app/utils/cwSplit'

describe('splitPattern', () => {
  it('finds the two letters a missed gap ran together', () => {
    expect(splitPattern('.-.-..').slice(0, 2)).toEqual(['AL', 'RD']) // fewest parts, letters first, then alphabetical
    expect(splitPattern('-.-.--.-')).toContain('CQ')
    expect(splitPattern('-.-.--.-')[0]).toBe('CQ')
  })

  it('prefers fewer characters, then letters and digits over punctuation', () => {
    const guesses = splitPattern('.-.-.-.-')
    // two-part readings exist (AR + AR as the + character would need punctuation — ".-.-." is +)
    expect(guesses[0]!.length).toBeLessThanOrEqual(guesses[guesses.length - 1]!.length)
    for (let i = 1; i < guesses.length; i++) expect(guesses[i]!.length).toBeGreaterThanOrEqual(guesses[i - 1]!.length)
  })

  it('returns nothing for a real character, a single element, junk or an absurd run', () => {
    expect(splitPattern('.-')).toEqual([])
    expect(splitPattern('.')).toEqual([])
    expect(splitPattern('.-x')).toEqual([])
    expect(splitPattern('.'.repeat(30))).toEqual([])
  })

  it('caps the list', () => {
    expect(splitPattern('.........', 3).length).toBeLessThanOrEqual(3)
    expect(splitPattern('.........', 3)[0]).toBe('5....'.slice(0, 1) + 'H') // 5 (.....) + H (....)
  })
})
