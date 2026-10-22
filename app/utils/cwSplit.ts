import { MORSE } from '~/utils/morse'

/**
 * Best guesses for a run-on pattern — what the decoder prints as unknown
 * when a sender leaves no gap between letters, so `.-.-..` arrives as one
 * character that matches nothing.
 *
 * Every way of cutting the pattern into known characters is enumerated;
 * guesses with the fewest cuts come first (one missed gap is far more likely
 * than three), and within a tier the ones made of letters and digits beat
 * the ones that need punctuation. Only the top few are returned: the point is
 * to give the operator a reading to check against the exchange, not a list.
 */

const CHAR_FOR = new Map<string, string>(Object.entries(MORSE).map(([ch, pat]) => [pat, ch]))
const MAX_ELEMENTS = 7 // the longest single character; a part longer than this is never one character
const MAX_PATTERN = 24 // beyond this a run-on is noise, not a word
const MAX_PARTS = 5 // more letters run together than this is not readable either way

export function splitPattern(pattern: string, limit = 4): string[] {
  if (!/^[.-]{2,}$/.test(pattern) || pattern.length > MAX_PATTERN || CHAR_FOR.has(pattern)) return []
  // every segmentation into at most MAX_PARTS characters, as the strings they spell
  const memo = new Map<string, string[]>()
  const from = (i: number, parts: number): string[] => {
    if (i === pattern.length) return ['']
    if (parts === 0) return []
    const key = `${i}:${parts}`
    const hit = memo.get(key)
    if (hit) return hit
    const out: string[] = []
    for (let len = 1; len <= MAX_ELEMENTS && i + len <= pattern.length; len++) {
      const ch = CHAR_FOR.get(pattern.slice(i, i + len))
      if (!ch) continue
      for (const rest of from(i + len, parts - 1)) out.push(ch + rest)
    }
    memo.set(key, out)
    return out
  }
  const plain = (s: string) => /^[A-Z0-9]+$/.test(s)
  return from(0, MAX_PARTS)
    .filter(s => s.length > 1)
    .sort((a, b) => a.length - b.length || Number(plain(b)) - Number(plain(a)) || a.localeCompare(b))
    .slice(0, limit)
}
