import { describe, it, expect } from 'vitest'
import { keywordFeed } from '../app/utils/cwFeed'

describe('keywordFeed', () => {
  it('lists every recognised keyword newest first, with meaning and code', () => {
    const feed = keywordFeed('CQ CQ DE W1AW W1AW K ')
    expect(feed.map(f => `${f.text}:${f.kind}×${f.count}`)).toEqual(['K:abbr×1', 'W1AW:callsign×2', 'DE:abbr×1', 'CQ:abbr×2'])
    const call = feed.find(f => f.text === 'W1AW')!
    expect(call.tip).toMatch(/callsign/i)
    expect(call.pattern).toBe('.-- .---- .- .--')
    expect(feed.find(f => f.text === 'CQ')!.pattern).toBe('-.-. --.-')
  })

  it('holds the last word back until something follows it — it may still be growing', () => {
    expect(keywordFeed('CQ DE W1A').map(f => f.text)).toEqual(['DE', 'CQ'])
    expect(keywordFeed('CQ DE W1AW').map(f => f.text)).toEqual(['DE', 'CQ'])
    expect(keywordFeed('CQ DE W1AW ').map(f => f.text)).toEqual(['W1AW', 'DE', 'CQ'])
    expect(keywordFeed('CQ DE W1AW\n').map(f => f.text)).toEqual(['W1AW', 'DE', 'CQ'])
  })

  it('merges a prosign into one pattern and explains it', () => {
    const [sk] = keywordFeed('73 <SK> ')
    expect(sk).toMatchObject({ text: '<SK>', kind: 'prosign', pattern: '...-.-' })
    expect(sk!.tip).toMatch(/end of contact/i)
    const [plus] = keywordFeed('UR 5NN + ')
    expect(plus).toMatchObject({ text: '+', kind: 'prosign', pattern: '.-.-.' })
  })

  it('reads an RST report', () => {
    const [rst] = keywordFeed('UR RST 5NN 5NN <BT> ')
    expect(rst!.kind).toBe('prosign')
    const report = keywordFeed('UR RST 5NN 5NN <BT> ').find(f => f.kind === 'rst')!
    expect(report).toMatchObject({ text: '5NN', count: 2 })
    expect(report.tip).toMatch(/599/)
  })

  it('collapses only back-to-back repeats, across line breaks', () => {
    expect(keywordFeed('CQ CQ\nCQ DE CQ ').map(f => `${f.text}×${f.count}`)).toEqual(['CQ×1', 'DE×1', 'CQ×3'])
  })

  it('lists a run-on unknown with its elements and the letters it could be', () => {
    const [row] = keywordFeed('CQ {-.-.--.-} DE ').filter(f => f.kind === 'unknown')
    expect(row).toMatchObject({ text: '{-.-.--.-}', pattern: '-.-.--.-' })
    expect(row!.tip).toMatch(/CQ/)
  })

  it('ignores plain text and the bare unknown dot, and is empty for an empty log', () => {
    expect(keywordFeed('')).toEqual([])
    expect(keywordFeed('HELLO * WORLD ')).toEqual([])
    expect(keywordFeed('GARBLED <> <XYZ> ')).toEqual([])
  })

  it('caps the feed at the limit, keeping the newest', () => {
    const log = Array.from({ length: 30 }, (_, i) => `K${i % 10}${String.fromCharCode(65 + (i % 26))}X`).join(' ') + ' '
    const feed = keywordFeed(log, 5)
    expect(feed.length).toBe(5)
    expect(feed[0]!.text).toBe('K9DX')
  })

  it('keeps ids increasing with the log so a row can be keyed', () => {
    const feed = keywordFeed('CQ DE W1AW K ')
    const ids = feed.map(f => f.id)
    expect([...ids].sort((a, b) => b - a)).toEqual(ids)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
