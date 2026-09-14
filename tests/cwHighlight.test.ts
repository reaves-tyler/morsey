import { describe, it, expect } from 'vitest'
import { highlightCw, type TokenKind } from '../app/utils/cwHighlight'

const kinds = (text: string) => highlightCw(text).filter(t => t.kind !== 'space').map(t => `${t.text}:${t.kind}`)
const kindOf = (word: string): TokenKind => highlightCw(word)[0]!.kind

describe('highlightCw', () => {
  it('reproduces the input exactly — nothing is hidden or rewritten', () => {
    const samples = [
      'CQ CQ DE W1AW W1AW K',
      'NR7Y DE W1AW <KN>',
      'UR RST 5NN 5NN <BT> NAME TYLER <AR>',
      'R R TU 73 ES GL <SK> E E',
      'GARBLED <K KN> <> <kn> <XYZ> ** A*B',
      'LINE ONE\nLINE  TWO   \n\n',
      '?? / +  = 73+'
    ]
    for (const s of samples) expect(highlightCw(s).map(t => t.text).join('')).toBe(s)
  })

  it('shows a decoded prosign as the literal <KN> the decoder wrote, coloured as a prosign', () => {
    const [tok] = highlightCw('<KN>')
    expect(tok).toMatchObject({ text: '<KN>', kind: 'prosign' })
    expect(tok!.tip).toMatch(/named station/i)
    expect(kindOf('<SK>')).toBe('prosign')
    expect(kindOf('<BT>')).toBe('prosign')
    expect(kindOf('<AS>')).toBe('prosign')
    expect(kindOf('<HH>')).toBe('prosign')
  })

  it('treats the AR and BT characters as prosigns', () => {
    expect(highlightCw('+')[0]).toMatchObject({ kind: 'prosign' })
    expect(highlightCw('=')[0]).toMatchObject({ kind: 'prosign' })
  })

  it('leaves malformed or unknown bracket text as plain text', () => {
    expect(kinds('<K KN> <> <kn> <XYZ> <>')).toEqual([
      '<:text', 'K:abbr', 'KN:prosign', '>:text', '<:text', '>:text', '<:text', 'kn:text', '>:text', '<XYZ>:text', '<:text', '>:text'
    ])
  })

  it('classifies Q-signals, RST reports, abbreviations and callsigns', () => {
    expect(kindOf('QTH')).toBe('qsignal')
    expect(kindOf('QSK')).toBe('qsignal')
    expect(kindOf('QZZ')).toBe('qsignal') // unknown Q-signal still reads as one
    expect(kindOf('599')).toBe('rst')
    expect(kindOf('5NN')).toBe('rst')
    expect(kindOf('579')).toBe('rst')
    expect(highlightCw('57N')[0]!.tip).toMatch(/readability 5, strength 7, tone 9/)
    expect(kindOf('TNX')).toBe('abbr')
    expect(kindOf('73')).toBe('abbr')
    expect(kindOf('OM')).toBe('abbr')
    expect(kindOf('W1AW')).toBe('callsign')
    expect(kindOf('NR7Y')).toBe('callsign')
    expect(kindOf('KD5XYZ')).toBe('callsign')
    expect(kindOf('4X4ABC')).toBe('callsign')
    expect(kindOf('W1AW/7')).toBe('callsign')
    expect(kindOf('DL/W1AW')).toBe('callsign')
    expect(kindOf('G4ABC/P')).toBe('callsign')
    expect(highlightCw('W1AW')[0]!.tip).toBe('Callsign (1x2)')
    expect(highlightCw('KD5XYZ')[0]!.tip).toBe('Callsign (2x3)')
  })

  it('does not mistake shorthand or plain words for callsigns or reports', () => {
    for (const w of ['CQ', 'DE', 'K', '73', '88', 'B4', 'TEST', 'HELLO', '12345', 'A1', '1A', '5NN', '599', 'ABCDE1F']) {
      expect(kindOf(w)).not.toBe('callsign')
    }
    expect(kindOf('699')).toBe('text') // readability only goes to 5
    expect(kindOf('590')).toBe('text')
    expect(kindOf('HELLO')).toBe('text')
  })

  it('splits punctuation from words so HW? still highlights HW', () => {
    expect(kinds('HW? BK')).toEqual(['HW:abbr', '?:text', 'BK:prosign'])
  })

  it('marks the unknown-pattern dot and newlines as their own tokens', () => {
    expect(kinds('A*B\nC')).toEqual(['A:text', '*:unknown', 'B:text', '\n:newline', 'C:text'])
  })

  it('highlights a whole exchange the way an operator reads it', () => {
    expect(kinds('NR7Y DE W1AW UR RST 5NN 5NN QTH CT CT NAME BOB HW? <KN>')).toEqual([
      'NR7Y:callsign', 'DE:abbr', 'W1AW:callsign', 'UR:abbr', 'RST:abbr', '5NN:rst', '5NN:rst',
      'QTH:qsignal', 'CT:text', 'CT:text', 'NAME:abbr', 'BOB:text', 'HW:abbr', '?:text', '<KN>:prosign'
    ])
  })
})
