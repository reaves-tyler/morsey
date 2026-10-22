import { highlightCw, type HighlightToken, type TokenKind } from '~/utils/cwHighlight'
import { wordPattern } from '~/utils/morse'

/**
 * The keyword feed under the decode terminal: every callsign, Q-signal, RST
 * report, prosign and abbreviation the highlighter recognises in the log,
 * newest first, each with its meaning and the code to send it back — and every
 * run-on pattern that matched no character, with the elements heard and the
 * letters they could have been, so a missed gap can still be read.
 *
 * It is a pure view of the terminal text (which is itself a persisted log),
 * so it needs no state of its own: a reload shows the same feed, Clear empties
 * both, and the head truncation of a long log drops the oldest lines here too.
 *
 * Two rules keep it honest in real time:
 *  - the last token of the log is still being written (`W1A` becomes `W1AW`,
 *    `CQ` could become `CQD`), so a keyword only joins the feed once something
 *    follows it — a space, a newline or the next word;
 *  - a keyword repeated back to back (`CQ CQ CQ`) is one line with a count,
 *    not three, so a CQ call does not bury the exchange.
 */

export type FeedKind = Exclude<TokenKind, 'text' | 'space' | 'newline'>

export interface FeedItem {
  /** exactly as decoded, e.g. `W1AW`, `5NN`, `<KN>` */
  text: string
  kind: FeedKind
  /** the highlighter's meaning */
  tip: string
  /** dit/dah pattern to send it back, prosigns merged */
  pattern: string
  /** how many times in a row it was copied */
  count: number
  /** ordinal from the start of the log — stable while the log only grows */
  id: number
}

const FEED_KINDS: ReadonlySet<TokenKind> = new Set<TokenKind>(['prosign', 'qsignal', 'rst', 'abbr', 'callsign', 'unknown'])

export function isFeedKind(kind: TokenKind): kind is FeedKind {
  return FEED_KINDS.has(kind)
}

/** Build the feed for a terminal log, newest first, at most `limit` lines. */
export function keywordFeed(text: string, limit = 200): FeedItem[] {
  const tokens: HighlightToken[] = highlightCw(text)
  const items: FeedItem[] = []
  let ordinal = 0
  // the final token may still be growing — only settled tokens count
  for (let i = 0; i < tokens.length - 1; i++) {
    const tok = tokens[i]!
    if (!isFeedKind(tok.kind)) continue
    // a bare `*` carries no elements — nothing to read back
    if (tok.kind === 'unknown' && !tok.pattern) continue
    const prev = items[items.length - 1]
    if (prev && prev.text === tok.text && onlySpacingBetween(tokens, prev, i)) {
      prev.count++
      prev.id = ordinal++
      continue
    }
    items.push({ text: tok.text, kind: tok.kind, tip: tok.tip ?? '', pattern: tok.pattern ?? wordPattern(tok.text), count: 1, id: ordinal++ })
  }
  return items.reverse().slice(0, limit)
}

/** true when nothing but spaces and newlines separate the previous feed item's token from token `i` */
function onlySpacingBetween(tokens: HighlightToken[], prev: FeedItem, i: number): boolean {
  for (let j = i - 1; j >= 0; j--) {
    const t = tokens[j]!
    if (t.kind === 'space' || t.kind === 'newline') continue
    return t.text === prev.text && isFeedKind(t.kind)
  }
  return false
}
