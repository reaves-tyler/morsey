import { describe, expect, it } from 'vitest'
import { CALLSIGN_ENTITIES, generateCallsign, callsignsAvailable } from '../app/utils/callsigns'
import { TOP_WORDS, HAM_WORDS, wordsFor } from '../app/utils/words'
import { buildQso } from '../app/utils/qso'
import { MORSE } from '../app/utils/morse'

describe('callsign generator', () => {
  it('always produces a valid prefix + digit + suffix shape', () => {
    // covers 1x1 through 2x3 plus digit-bearing prefixes like 9A
    const shape = /^(?:[A-Z]{1,2}|9A)[0-9][A-Z]{1,3}$/
    for (let i = 0; i < 500; i++) {
      const gen = generateCallsign()!
      expect(gen.call, gen.call).toMatch(shape)
    }
  })

  it('only uses prefixes from the entity it reports', () => {
    for (let i = 0; i < 200; i++) {
      const gen = generateCallsign()!
      expect(gen.entity.prefixes.some(p => gen.call.startsWith(p)), gen.call).toBe(true)
    }
  })

  it('respects the allowed-character restriction (Koch progression)', () => {
    // lesson ~24 set: enough letters + the digit 5
    const allowed = ['K', 'M', 'U', 'R', 'E', 'S', 'N', 'A', 'P', 'T', 'L', 'W', 'I', 'J', 'Z', 'F', 'O', 'Y', 'V', 'G', '5']
    const set = new Set(allowed)
    for (let i = 0; i < 300; i++) {
      const gen = generateCallsign(allowed)
      expect(gen).not.toBeNull()
      for (const c of gen!.call) expect(set.has(c), `${gen!.call} uses ${c}`).toBe(true)
    }
  })

  it('is unavailable before any digit is unlocked', () => {
    expect(callsignsAvailable(['K', 'M', 'U', 'R', 'E', 'S', 'N', 'A'])).toBe(false)
    expect(generateCallsign(['K', 'M'])).toBeNull()
  })

  it('every entity has usable prefixes, digits, and QTHs', () => {
    for (const e of CALLSIGN_ENTITIES) {
      expect(e.prefixes.length, e.entity).toBeGreaterThan(0)
      expect(e.digits.length, e.entity).toBeGreaterThan(0)
      expect(e.qths.length, e.entity).toBeGreaterThan(0)
      expect(e.weight, e.entity).toBeGreaterThan(0)
    }
  })
})

describe('word lists', () => {
  it('contains only sendable characters', () => {
    for (const w of [...TOP_WORDS, ...HAM_WORDS]) {
      for (const c of w) expect(MORSE[c], `${w} char ${c}`).toBeTruthy()
    }
  })

  it('wordsFor filters strictly to the unlocked letters', () => {
    const words = wordsFor(['E', 'T', 'A', 'N', 'S', 'O'])
    expect(words.length).toBeGreaterThan(0)
    for (const w of words) expect(w, w).toMatch(/^[ETANSO]+$/)
  })

  it('wordsFor with two letters yields little to nothing (gating works)', () => {
    expect(wordsFor(['K', 'M']).length).toBeLessThan(5)
  })
})

describe('QSO script builder', () => {
  it('follows the canonical listen/send/listen/send/listen structure', () => {
    const qso = buildQso('KD9ABC', 'TYLER')
    expect(qso.steps.map(s => s.type)).toEqual(['listen', 'send', 'listen', 'send', 'listen'])
  })

  it('keeps the station consistent and repeats exchange fields twice, as taught', () => {
    for (let i = 0; i < 50; i++) {
      const qso = buildQso('kd9abc', 'tyler')
      // CQ carries their call three times; copy field answer matches
      const cq = qso.steps[0]!
      expect(cq.text).toContain(`CQ CQ CQ DE ${qso.their} ${qso.their} ${qso.their} K`)
      expect(cq.fields![0]!.answer).toBe(qso.their)
      // our answer uses their call + DE + our call (uppercased)
      expect(qso.steps[1]!.text).toBe(`${qso.their} DE KD9ABC KD9ABC K`)
      // exchange sends RST, name, and QTH twice each
      const exchange = qso.steps[2]!.text
      for (const val of [qso.rst, qso.name, qso.qth]) {
        expect(exchange).toContain(`${val} ${val}`)
      }
      // copy fields carry the exact answers
      const fields = Object.fromEntries(qso.steps[2]!.fields!.map(f => [f.key, f.answer]))
      expect(fields).toEqual({ rst: qso.rst, name: qso.name, qth: qso.qth })
      // sign-off ends the contact with the SK prosign
      expect(qso.steps[4]!.text).toContain('73')
      expect(qso.steps[4]!.text).toContain('<SK>')
      // our sent exchange includes our name twice and the outgoing RST
      expect(qso.steps[3]!.text).toContain('TYLER TYLER')
      expect(qso.steps[3]!.text).toContain(`${qso.rstOut} ${qso.rstOut}`)
    }
  })

  it('QTH belongs to the generated station entity', () => {
    for (let i = 0; i < 50; i++) {
      const qso = buildQso('KD9ABC', 'TYLER')
      const entity = CALLSIGN_ENTITIES.find(e => e.qths.includes(qso.qth))
      expect(entity, qso.qth).toBeTruthy()
      expect(entity!.prefixes.some(p => qso.their.startsWith(p)), `${qso.their} vs ${entity!.entity}`).toBe(true)
    }
  })

  it('every step text is sendable morse (known characters and prosigns only)', () => {
    const qso = buildQso('KD9ABC', 'TYLER')
    for (const step of qso.steps) {
      const tokens = step.text.toUpperCase().split(/\s+/).flatMap(w => w.match(/<[A-Z]+>|./g) ?? [])
      for (const tok of tokens) {
        if (tok.startsWith('<')) {
          for (const l of tok.slice(1, -1)) expect(MORSE[l], `${step.text} → ${tok}`).toBeTruthy()
        } else {
          expect(MORSE[tok], `${step.text} → ${tok}`).toBeTruthy()
        }
      }
    }
  })
})
