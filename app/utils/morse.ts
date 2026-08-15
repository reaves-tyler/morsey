/**
 * Core morse code data and timing math.
 *
 * Timing follows the ARRL Farnsworth standard ("A Standard for Morse Timing
 * Using the Farnsworth Technique", QST April 1990): characters are always sent
 * at full character speed so the learner internalizes the rhythm, while the
 * gaps between characters and words are stretched to hit a slower effective
 * (overall) speed.
 */

export const MORSE: Record<string, string> = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.',
  H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.',
  O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-',
  V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-',
  '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', '/': '-..-.', '=': '-...-',
  '+': '.-.-.', '-': '-....-', '@': '.--.-.'
}

export const REVERSE_MORSE: Record<string, string> = Object.fromEntries(
  Object.entries(MORSE).map(([char, code]) => [code, char])
)

/**
 * Koch method character order (the sequence used by LCWO.net).
 * Lesson 1 teaches the first two characters; each later lesson adds one more.
 */
export const KOCH_ORDER = [
  'K', 'M', 'U', 'R', 'E', 'S', 'N', 'A', 'P', 'T',
  'L', 'W', 'I', '.', 'J', 'Z', '=', 'F', 'O', 'Y',
  ',', 'V', 'G', '5', '/', 'Q', '9', '2', 'H', '3',
  '8', 'B', '?', '4', '7', 'C', '1', 'D', '6', '0', 'X'
] as const

export const TOTAL_LESSONS = KOCH_ORDER.length - 1 // lesson n unlocks chars 0..n+1

export interface MorseTimings {
  /** seconds for one dit at character speed */
  dit: number
  /** seconds for one dah (3 dits) */
  dah: number
  /** gap between elements inside a character (1 dit) */
  elementGap: number
  /** gap between characters (3 dits, or stretched per Farnsworth) */
  charGap: number
  /** gap between words (7 dits, or stretched per Farnsworth) */
  wordGap: number
}

/**
 * ARRL Farnsworth timing. `charWpm` controls dit/dah length; `effectiveWpm`
 * (when lower) stretches inter-character and inter-word spacing.
 */
export function morseTimings(charWpm: number, effectiveWpm: number): MorseTimings {
  const dit = 1.2 / charWpm
  let charGap = 3 * dit
  let wordGap = 7 * dit

  if (effectiveWpm < charWpm) {
    // Total stretched delay budget per the ARRL formula, split 3:7 across the
    // 19 unit-gaps in the standard "PARIS" word.
    const ta = (60 * charWpm - 37.2 * effectiveWpm) / (effectiveWpm * charWpm)
    charGap = (3 * ta) / 19
    wordGap = (7 * ta) / 19
  }

  return { dit, dah: 3 * dit, elementGap: dit, charGap, wordGap }
}

export interface ToneSegment {
  /** start offset in seconds */
  at: number
  /** duration in seconds */
  dur: number
}

/**
 * Convert text to a schedule of tone segments.
 *
 * Prosigns can be written as `<AR>`: the letters are run together with no
 * inter-character gap, as sent on the air.
 */
export function textToSchedule(text: string, t: MorseTimings): { segments: ToneSegment[]; total: number } {
  const segments: ToneSegment[] = []
  let cursor = 0

  const pushCode = (code: string) => {
    if (!code) return
    for (const el of code) {
      const dur = el === '-' ? t.dah : t.dit
      segments.push({ at: cursor, dur })
      cursor += dur + t.elementGap
    }
    cursor -= t.elementGap // remove trailing element gap
  }

  const words = text.trim().toUpperCase().split(/\s+/)
  words.forEach((word, wi) => {
    if (wi > 0) cursor += t.wordGap

    // Tokenize: either a prosign like <AR> or a single character
    const tokens = word.match(/<[A-Z]+>|./g) ?? []
    tokens.forEach((token, ti) => {
      if (ti > 0) cursor += t.charGap
      if (token.startsWith('<')) {
        // Prosign: letters merged with only element gaps between them
        const letters = token.slice(1, -1).split('')
        letters.forEach((letter, li) => {
          if (li > 0) cursor += t.elementGap
          pushCode(MORSE[letter] ?? '')
        })
      } else {
        const code = MORSE[token]
        if (code) pushCode(code)
      }
    })
  })

  return { segments, total: cursor }
}

/** Human-readable dit/dah pattern for a character or prosign token. */
export function patternFor(token: string): string {
  if (token.startsWith('<')) {
    return token
      .slice(1, -1)
      .split('')
      .map(l => MORSE[l] ?? '')
      .join('')
  }
  return MORSE[token.toUpperCase()] ?? ''
}

/** Dit/dah pattern for a whole phrase, e.g. "CQ DX" → "-.-. --.- / -.. -..-" */
export function wordPattern(text: string): string {
  return text
    .trim()
    .toUpperCase()
    .split(/\s+/)
    .map(word => (word.match(/<[A-Z]+>|./g) ?? []).map(patternFor).join(' '))
    .join(' / ')
}

export function shuffle<T>(arr: T[]): T[] {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}
