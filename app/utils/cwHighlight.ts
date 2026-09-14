import { PHRASE_TIERS, COMMON_ABBREVIATIONS } from '~/utils/abbreviations'

/**
 * Syntax highlighting for decoded CW.
 *
 * Splits decoder output into tokens and classifies the words an operator
 * would recognise on the air: prosigns, Q-signals, RST reports, common
 * abbreviations and callsigns. Everything else is plain text.
 *
 * Two invariants the terminal relies on, both unit-tested:
 *  - the token texts concatenate back to the input exactly, so nothing the
 *    decoder printed is ever hidden, reworded or turned into an icon — a
 *    prosign is shown as the `<KN>` the decoder wrote, just coloured;
 *  - anything that does not match a known form is plain `text`, including
 *    malformed brackets (`<K`, `KN>`, `<>`), so a garbled decode never gets
 *    dressed up as something it is not.
 */

export type TokenKind =
  | 'text'
  | 'space'
  | 'newline'
  /** the decoder's `*` for a pattern that matches no character */
  | 'unknown'
  | 'prosign'
  | 'qsignal'
  | 'rst'
  | 'abbr'
  | 'callsign'

export interface HighlightToken {
  text: string
  kind: TokenKind
  /** hover tip — the meaning, present for every highlighted kind */
  tip?: string
}

/** meanings for the prosigns the decoder can print (`PROSIGN_PATTERNS` + the characters AR/BT collide with) */
export const PROSIGN_MEANINGS: Record<string, string> = {
  AR: 'End of message',
  SK: 'End of contact (silent key)',
  BT: 'Pause / new paragraph',
  KN: 'Go ahead — named station only',
  AS: 'Wait / stand by',
  BK: 'Break — back to you',
  CL: 'Closing station',
  SN: 'Understood',
  AA: 'New line',
  HH: 'Error — disregard',
  SOS: 'International distress signal'
}

/** what `+` and `=` mean when the decoder prints them: they are AR and BT sent as one character */
const CHAR_PROSIGNS: Record<string, string> = {
  '+': 'AR — end of message',
  '=': 'BT — pause / new paragraph'
}

/** Q-signals beyond the quizzed tier, so an unfamiliar one still gets a tip */
const Q_SIGNALS: Record<string, string> = {
  QRA: 'Station name',
  QRB: 'Distance between stations',
  QRG: 'Exact frequency',
  QRH: 'Frequency varies',
  QRI: 'Tone of transmission',
  QRK: 'Readability of signals',
  QRL: 'Frequency in use? / I am busy',
  QRU: 'Nothing for you',
  QRW: 'Please inform … that I am calling',
  QSA: 'Signal strength',
  QSD: 'Keying defective',
  QSK: 'Full break-in — I can hear between my signals',
  QSM: 'Repeat the last message',
  QSP: 'Relay to …',
  QST: 'General call to all amateurs',
  QSU: 'Send on this frequency',
  QSV: 'Send a series of Vs',
  QSW: 'I will send on this frequency',
  QSX: 'I am listening on …',
  QSZ: 'Send each word twice',
  QTC: 'I have messages for you',
  QTR: 'Correct time'
}

interface Entry { kind: TokenKind; tip: string }

/** abbreviation → kind + meaning, built once from the phrase tiers and the common list */
const DICTIONARY: Record<string, Entry> = (() => {
  const d: Record<string, Entry> = {}
  for (const [abbr, tip] of Object.entries(COMMON_ABBREVIATIONS)) d[abbr] = { kind: 'abbr', tip }
  for (const [abbr, tip] of Object.entries(Q_SIGNALS)) d[abbr] = { kind: 'qsignal', tip }
  for (const [abbr, tip] of Object.entries(PROSIGN_MEANINGS)) d[abbr] = { kind: 'prosign', tip: `${tip} (prosign)` }
  for (const tier of PHRASE_TIERS) {
    for (const item of tier.items) {
      if (item.abbr.includes(' ')) continue // multi-word phrases are matched word by word
      const kind: TokenKind = tier.name === 'Q-Signals' ? 'qsignal'
        : tier.name === 'Prosigns' ? 'prosign'
          : /^[1-5][1-9N][1-9N]$/.test(item.abbr) ? 'rst'
            : 'abbr'
      d[item.abbr] = { kind, tip: kind === 'prosign' ? `${item.meaning} (prosign)` : item.meaning }
    }
  }
  return d
})()

/** RST as sent on CW: readability 1–5, strength 1–9, tone 1–9, with N as a cut 9 */
const RST_RE = /^[1-5][1-9N][1-9N]$/

/**
 * Amateur callsign: prefix (1–2 letters, or digit + letter(s) like 4X/9A),
 * separating digit, 1–4 letter suffix, optional portable designator
 * (`/P`, `/QRP`, `/7`, or a prefix such as `DL/`).
 */
const CALLSIGN_RE = /^(?:[A-Z0-9]{1,3}\/)?([A-Z]{1,2}|[0-9][A-Z]{1,2})([0-9])([A-Z]{1,4})(?:\/[A-Z0-9]{1,3})?$/

function classify(word: string): HighlightToken {
  if (word in CHAR_PROSIGNS) return { text: word, kind: 'prosign', tip: CHAR_PROSIGNS[word] }
  const dict = DICTIONARY[word]
  if (dict) return { text: word, kind: dict.kind, tip: dict.tip }
  if (RST_RE.test(word)) {
    const n = (c: string) => (c === 'N' ? 9 : Number(c))
    return { text: word, kind: 'rst', tip: `RST — readability ${word[0]}, strength ${n(word[1]!)}, tone ${n(word[2]!)}` }
  }
  if (/^Q[A-Z]{2}$/.test(word)) return { text: word, kind: 'qsignal', tip: 'Q-signal' }
  const m = CALLSIGN_RE.exec(word)
  if (m) return { text: word, kind: 'callsign', tip: `Callsign (${m[1]!.length}x${m[3]!.length})` }
  return { text: word, kind: 'text' }
}

/** `<KN>`-style prosign the decoder wrote; anything else in angle brackets is plain text */
function classifyProsign(tok: string): HighlightToken {
  const name = tok.slice(1, -1)
  const tip = PROSIGN_MEANINGS[name]
  return tip ? { text: tok, kind: 'prosign', tip: `${tip} (prosign)` } : { text: tok, kind: 'text' }
}

// prosign, unknown dot, newline, run of spaces, word, then any single other character
// (a stray `<` or `>` included — every input character must land in some token)
const TOKEN_RE = /<[A-Z]+>|\*|\n| +|[A-Za-z0-9/]+|[^A-Za-z0-9/* \n]/g

export function highlightCw(text: string): HighlightToken[] {
  const out: HighlightToken[] = []
  for (const tok of text.match(TOKEN_RE) ?? []) {
    if (tok === '\n') out.push({ text: tok, kind: 'newline' })
    else if (tok === '*') out.push({ text: tok, kind: 'unknown', tip: 'Pattern matched no character' })
    else if (tok[0] === ' ') out.push({ text: tok, kind: 'space' })
    else if (tok[0] === '<') out.push(classifyProsign(tok))
    else out.push(classify(tok))
  }
  return out
}
