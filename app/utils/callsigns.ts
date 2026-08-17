/**
 * Realistic amateur radio callsign generator.
 *
 * Callsign anatomy (ITU): prefix (1-2 chars, allocated per country) +
 * separating digit + suffix (1-3 letters). The "2x3" style notation is
 * prefix-length x suffix-length; 1x3/2x3 are the most common formats on air.
 * Prefix blocks below follow the ITU allocations (K/N/W + AA-AL USA, VE/VA
 * Canada, G/M UK, DA-DR Germany, JA-JS Japan, etc.).
 */

export interface CallsignEntity {
  entity: string
  /** candidate prefixes within the entity's ITU block */
  prefixes: string[]
  /** digits this entity actually uses in the separating position */
  digits: string
  /** rough on-air commonality weighting */
  weight: number
  /** example QTHs for QSO simulation */
  qths: string[]
}

export const CALLSIGN_ENTITIES: CallsignEntity[] = [
  { entity: 'USA', prefixes: ['K', 'N', 'W', 'KB', 'KC', 'KD', 'KE', 'NA', 'ND', 'WA', 'WB', 'AA', 'AB'], digits: '0123456789', weight: 30, qths: ['OHIO', 'TEXAS', 'MAINE', 'IDAHO', 'UTAH', 'IOWA', 'TAMPA', 'RENO', 'BOISE', 'DENVER'] },
  { entity: 'Germany', prefixes: ['DL', 'DJ', 'DK', 'DF', 'DD'], digits: '0123456789', weight: 8, qths: ['BERLIN', 'KOELN', 'MUNICH', 'HAMBURG'] },
  { entity: 'Japan', prefixes: ['JA', 'JE', 'JH', 'JR', 'JF'], digits: '0123456789', weight: 6, qths: ['TOKYO', 'OSAKA', 'KOBE', 'NAGOYA'] },
  { entity: 'UK', prefixes: ['G', 'M'], digits: '0123456789', weight: 6, qths: ['LONDON', 'LEEDS', 'YORK', 'DOVER'] },
  { entity: 'Canada', prefixes: ['VE', 'VA', 'VY'], digits: '123456789', weight: 6, qths: ['TORONTO', 'OTTAWA', 'CALGARY'] },
  { entity: 'Italy', prefixes: ['I', 'IK', 'IZ'], digits: '012345678', weight: 5, qths: ['ROMA', 'MILANO', 'TORINO'] },
  { entity: 'France', prefixes: ['F'], digits: '12345689', weight: 5, qths: ['PARIS', 'LYON', 'NICE'] },
  { entity: 'Spain', prefixes: ['EA', 'EB'], digits: '12345678', weight: 4, qths: ['MADRID', 'SEVILLA', 'BILBAO'] },
  { entity: 'Brazil', prefixes: ['PY', 'PP', 'PU'], digits: '1234567', weight: 4, qths: ['RIO', 'RECIFE', 'SANTOS'] },
  { entity: 'Argentina', prefixes: ['LU', 'LW'], digits: '123456789', weight: 3, qths: ['SALTA', 'ROSARIO'] },
  { entity: 'Russia', prefixes: ['UA', 'RA', 'RZ'], digits: '0134679', weight: 4, qths: ['MOSCOW', 'KAZAN'] },
  { entity: 'Australia', prefixes: ['VK'], digits: '12345678', weight: 4, qths: ['SYDNEY', 'PERTH', 'DARWIN'] },
  { entity: 'New Zealand', prefixes: ['ZL'], digits: '1234', weight: 2, qths: ['NELSON', 'NAPIER'] },
  { entity: 'Sweden', prefixes: ['SM', 'SA'], digits: '01234567', weight: 3, qths: ['MALMO', 'UPPSALA'] },
  { entity: 'Finland', prefixes: ['OH'], digits: '012345678', weight: 3, qths: ['TURKU', 'ESPOO'] },
  { entity: 'Netherlands', prefixes: ['PA', 'PD'], digits: '0123456789', weight: 3, qths: ['DELFT', 'LEIDEN'] },
  { entity: 'Poland', prefixes: ['SP', 'SQ'], digits: '123456789', weight: 3, qths: ['KRAKOW', 'GDANSK'] },
  { entity: 'Czechia', prefixes: ['OK'], digits: '1247', weight: 2, qths: ['PRAGUE', 'BRNO'] },
  { entity: 'Switzerland', prefixes: ['HB'], digits: '9', weight: 2, qths: ['BERN', 'GENEVA'] },
  { entity: 'Croatia', prefixes: ['9A'], digits: '123456789', weight: 2, qths: ['ZAGREB', 'SPLIT'] }
]

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
/** Suffix length distribution: 1x1/x1 rare, x2 common, x3 most common. */
const SUFFIX_LENGTH_WEIGHTS: [number, number][] = [[1, 1], [2, 4], [3, 6]]

function pickWeighted<T>(items: T[], weightOf: (item: T) => number): T | null {
  const total = items.reduce((sum, item) => sum + weightOf(item), 0)
  if (total <= 0) return null
  let roll = Math.random() * total
  for (const item of items) {
    roll -= weightOf(item)
    if (roll <= 0) return item
  }
  return items[items.length - 1] ?? null
}

function usable(entity: CallsignEntity, allowed: Set<string> | null) {
  if (!allowed) return { prefixes: entity.prefixes, digits: [...entity.digits], letters: [...LETTERS] }
  const prefixes = entity.prefixes.filter(p => [...p].every(c => allowed.has(c)))
  const digits = [...entity.digits].filter(d => allowed.has(d))
  const letters = [...LETTERS].filter(l => allowed.has(l))
  return { prefixes, digits, letters }
}

/**
 * Generate one realistic callsign. When `allowedChars` is given (Koch
 * progression), only entities/suffixes expressible with those characters are
 * used. Returns null if no entity is expressible yet.
 */
export function generateCallsign(allowedChars?: string[]): { call: string, entity: CallsignEntity } | null {
  const allowed = allowedChars ? new Set(allowedChars.map(c => c.toUpperCase())) : null
  const candidates = CALLSIGN_ENTITIES
    .map(entity => ({ entity, pools: usable(entity, allowed) }))
    .filter(c => c.pools.prefixes.length > 0 && c.pools.digits.length > 0 && c.pools.letters.length >= 3)
  const chosen = pickWeighted(candidates, c => c.entity.weight)
  if (!chosen) return null

  const { entity, pools } = chosen
  const prefix = pools.prefixes[Math.floor(Math.random() * pools.prefixes.length)]!
  const digit = pools.digits[Math.floor(Math.random() * pools.digits.length)]!
  const lenPick = pickWeighted(SUFFIX_LENGTH_WEIGHTS, w => w[1])!
  let suffix = ''
  for (let i = 0; i < lenPick[0]; i++) {
    suffix += pools.letters[Math.floor(Math.random() * pools.letters.length)]!
  }
  return { call: prefix + digit + suffix, entity }
}

/** Can any callsign be built from these characters? (needs a digit + letters) */
export function callsignsAvailable(allowedChars: string[]): boolean {
  return generateCallsign(allowedChars) !== null
}
