/**
 * Word-training vocabulary: the 100 most common English words (the standard
 * frequency list also used by LCWO-style word trainers) plus everyday CW/ham
 * shorthand. Recognizing whole words by rhythm — instead of letter-by-letter
 * copy — is the bridge from character speed to conversational head copy.
 */

export const TOP_WORDS: string[] = [
  'THE', 'BE', 'TO', 'OF', 'AND', 'A', 'IN', 'THAT', 'HAVE', 'I',
  'IT', 'FOR', 'NOT', 'ON', 'WITH', 'HE', 'AS', 'YOU', 'DO', 'AT',
  'THIS', 'BUT', 'HIS', 'BY', 'FROM', 'THEY', 'WE', 'SAY', 'HER', 'SHE',
  'OR', 'AN', 'WILL', 'MY', 'ONE', 'ALL', 'WOULD', 'THERE', 'THEIR', 'WHAT',
  'SO', 'UP', 'OUT', 'IF', 'ABOUT', 'WHO', 'GET', 'WHICH', 'GO', 'ME',
  'WHEN', 'MAKE', 'CAN', 'LIKE', 'TIME', 'NO', 'JUST', 'HIM', 'KNOW', 'TAKE',
  'PEOPLE', 'INTO', 'YEAR', 'YOUR', 'GOOD', 'SOME', 'COULD', 'THEM', 'SEE', 'OTHER',
  'THAN', 'THEN', 'NOW', 'LOOK', 'ONLY', 'COME', 'ITS', 'OVER', 'THINK', 'ALSO',
  'BACK', 'AFTER', 'USE', 'TWO', 'HOW', 'OUR', 'WORK', 'FIRST', 'WELL', 'WAY',
  'EVEN', 'NEW', 'WANT', 'BECAUSE', 'ANY', 'THESE', 'GIVE', 'DAY', 'MOST', 'US'
]

/** Ham-flavored everyday words heard in almost every QSO. */
export const HAM_WORDS: string[] = [
  'ES', 'DE', 'UR', 'HR', 'HW', 'FB', 'RIG', 'ANT', 'WX', 'PSE',
  'TNX', 'AGN', 'CQ', 'DX', 'QTH', 'QSO', 'QRP', 'NAME', 'CALL', 'WATT',
  'BAND', 'FINE', 'COPY', 'GOOD'
]

/** All training words expressible with the given unlocked letters. */
export function wordsFor(unlockedLetters: string[]): string[] {
  const allowed = new Set(unlockedLetters.map(c => c.toUpperCase()))
  const pool = [...new Set([...TOP_WORDS, ...HAM_WORDS])]
  return pool.filter(word => [...word].every(c => allowed.has(c)))
}
