import { PHRASE_TIERS } from '~/utils/abbreviations'
import { KOCH_ORDER, TOTAL_LESSONS } from '~/utils/morse'

/** Rolling-window size and accuracy bar to unlock the next Koch character. */
export const UNLOCK_WINDOW = 30
export const UNLOCK_ACCURACY = 0.9
/** Consecutive correct answers required to master a phrase. */
export const PHRASE_MASTERY = 3
/** Fraction of a tier that must be mastered to unlock the next tier. */
export const TIER_UNLOCK = 0.8

export interface ProgressState {
  xp: number
  streakDays: number
  lastPracticeDay: string | null
  bestCombo: number
  totalAnswers: number
  totalCorrect: number
  koch: {
    /** 1-based lesson number; lesson n unlocks KOCH_ORDER[0..n] */
    lesson: number
    /** rolling window of recent answers within the current lesson */
    window: boolean[]
    attemptsInLesson: number
  }
  /** per-character lifetime stats */
  chars: Record<string, { seen: number; correct: number }>
  /** per-phrase consecutive-correct streaks, keyed by abbr */
  phraseStreaks: Record<string, number>
  /** daily activity aggregates, keyed by ISO date (for the stats page) */
  history: Record<string, { answers: number, correct: number, xp: number }>
  /** high-water mark of unlocked phrase tiers — once open, a tier stays open */
  tierHighWater: number
  settings: {
    charWpm: number
    effectiveWpm: number
    /** sending-side speed: paddle element timing and straight-key thresholds */
    sendWpm: number
    freq: number
    volume: number
    groupSize: number
    /** how the keyer interprets the key's contact closures, like a rig's keyer menu */
    keyType: KeyType
    /** swap tip/ring roles (standard is tip = dit) */
    paddleReverse: boolean
    /** keyer feel knobs — see KeyerConfig in utils/keyerEngine.ts */
    debounceMs: number
    keyerWeight: number
    dahThresholdUnits: number
    adaptiveDit: boolean
    letterGapUnits: number
    wordGapUnits: number
    /** simulated band conditions for receive training (0 = off) */
    qrnLevel: number
    qsbDepth: number
    qrm: boolean
    /** operator identity for the QSO simulator */
    myCall: string
    myName: string
  }
}

export type KeyType = 'straight' | 'bug' | 'iambic-a' | 'iambic-b'

export const KEY_TYPE_LABELS: Record<KeyType, string> = {
  'straight': 'Straight',
  'bug': 'Bug',
  'iambic-a': 'Iambic A',
  'iambic-b': 'Iambic B'
}

const STORAGE_KEY = 'morsey-progress-v1'

function defaultState(): ProgressState {
  return {
    xp: 0,
    streakDays: 0,
    lastPracticeDay: null,
    bestCombo: 0,
    totalAnswers: 0,
    totalCorrect: 0,
    koch: { lesson: 1, window: [], attemptsInLesson: 0 },
    chars: {},
    phraseStreaks: {},
    history: {},
    tierHighWater: 1,
    settings: {
      charWpm: 20,
      effectiveWpm: 10,
      sendWpm: 12,
      freq: 700,
      volume: 0.6,
      groupSize: 5,
      keyType: 'iambic-a',
      paddleReverse: false,
      debounceMs: 20,
      keyerWeight: 3,
      dahThresholdUnits: 2,
      adaptiveDit: true,
      letterGapUnits: 4,
      wordGapUnits: 8,
      qrnLevel: 0,
      qsbDepth: 0,
      qrm: false,
      myCall: 'N0CALL',
      myName: 'OP'
    }
  }
}

/** Merge a saved/imported partial state over defaults so new fields survive schema evolution. */
function mergeSaved(saved: Partial<ProgressState>): ProgressState {
  const base = defaultState()
  return {
    ...base,
    ...saved,
    koch: { ...base.koch, ...saved.koch },
    settings: { ...base.settings, ...saved.settings },
    chars: saved.chars ?? {},
    phraseStreaks: saved.phraseStreaks ?? {},
    history: saved.history ?? {}
  }
}

/**
 * Parse an exported progress file. Returns the merged state, or an error
 * message when the JSON isn't a Morsey progress backup.
 */
export function parseProgressJson(json: string): { state: ProgressState } | { error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { error: 'That file is not valid JSON.' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'That file does not look like a Morsey progress backup.' }
  }
  const p = parsed as Partial<ProgressState>
  if (typeof p.xp !== 'number' || !p.koch || typeof p.koch !== 'object') {
    return { error: 'That file does not look like a Morsey progress backup (missing xp/koch fields).' }
  }
  return { state: mergeSaved(p) }
}

/** Tier count earned purely from current mastery (before the high-water mark). */
function rawTierCount(streaks: Record<string, number>): number {
  let unlocked = 1
  for (let i = 0; i < PHRASE_TIERS.length - 1; i++) {
    const tier = PHRASE_TIERS[i]!
    const mastered = tier.items.filter(item => (streaks[item.abbr] ?? 0) >= PHRASE_MASTERY).length
    if (mastered / tier.items.length >= TIER_UNLOCK) unlocked = i + 2
    else break
  }
  return unlocked
}

let persistenceAttached = false

export function useProgress() {
  const progress = useState<ProgressState>('morsey-progress', defaultState)

  if (import.meta.client && !persistenceAttached) {
    persistenceAttached = true
    // Load after hydration so server-rendered HTML (default state) matches the
    // first client render; the restore then updates reactively.
    onNuxtReady(() => {
      try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (raw) progress.value = mergeSaved(JSON.parse(raw) as Partial<ProgressState>)
      } catch {
        // corrupted storage — start fresh
      }
      watch(progress, (val) => {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(val))
        } catch {
          // storage full/unavailable — training still works, just not persisted
        }
      }, { deep: true })
    })
  }

  // ---- Derived state -------------------------------------------------------

  const level = computed(() => Math.floor(Math.sqrt(progress.value.xp / 100)) + 1)
  const xpForLevel = (lvl: number) => (lvl - 1) ** 2 * 100
  const levelProgress = computed(() => {
    const cur = xpForLevel(level.value)
    const next = xpForLevel(level.value + 1)
    return Math.round(((progress.value.xp - cur) / (next - cur)) * 100)
  })
  const xpToNextLevel = computed(() => xpForLevel(level.value + 1) - progress.value.xp)

  const unlockedChars = computed(() =>
    KOCH_ORDER.slice(0, progress.value.koch.lesson + 1) as string[]
  )

  const kochWindowAccuracy = computed(() => {
    const w = progress.value.koch.window
    if (w.length === 0) return 0
    return w.filter(Boolean).length / w.length
  })

  const canAdvance = computed(() =>
    progress.value.koch.lesson <= TOTAL_LESSONS &&
    progress.value.koch.window.length >= UNLOCK_WINDOW &&
    kochWindowAccuracy.value >= UNLOCK_ACCURACY
  )

  const kochComplete = computed(() => progress.value.koch.lesson > TOTAL_LESSONS)

  const masteredPhrases = computed(() =>
    Object.entries(progress.value.phraseStreaks)
      .filter(([, streak]) => streak >= PHRASE_MASTERY)
      .map(([abbr]) => abbr)
  )

  // Once open, a tier stays open (high-water mark) — review mistakes on an
  // earlier tier must never re-lock the tier you're currently working on
  const unlockedTierCount = computed(() =>
    Math.max(rawTierCount(progress.value.phraseStreaks), progress.value.tierHighWater)
  )

  const lifetimeAccuracy = computed(() =>
    progress.value.totalAnswers === 0
      ? 0
      : Math.round((progress.value.totalCorrect / progress.value.totalAnswers) * 100)
  )

  /** Characters with the worst accuracy (min 5 attempts), weakest first. */
  const weakestChars = computed(() =>
    Object.entries(progress.value.chars)
      .filter(([, s]) => s.seen >= 5)
      .map(([char, s]) => ({ char, accuracy: s.correct / s.seen }))
      .sort((a, b) => a.accuracy - b.accuracy)
      .slice(0, 5)
  )

  // ---- Mutations -----------------------------------------------------------

  function touchStreak() {
    const today = new Date().toISOString().slice(0, 10)
    const p = progress.value
    if (p.lastPracticeDay === today) return
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    p.streakDays = p.lastPracticeDay === yesterday ? p.streakDays + 1 : 1
    p.lastPracticeDay = today
  }

  function todayEntry() {
    const key = new Date().toISOString().slice(0, 10)
    const p = progress.value
    const entry = p.history[key] ?? { answers: 0, correct: 0, xp: 0 }
    p.history[key] = entry
    return entry
  }

  function addXp(amount: number) {
    progress.value.xp += amount
    todayEntry().xp += amount
    touchStreak()
  }

  function recordAnswer(correct: boolean) {
    progress.value.totalAnswers++
    if (correct) progress.value.totalCorrect++
    const entry = todayEntry()
    entry.answers++
    if (correct) entry.correct++
  }

  function recordCharAnswer(char: string, correct: boolean) {
    const p = progress.value
    const stats = p.chars[char] ?? { seen: 0, correct: 0 }
    stats.seen++
    if (correct) stats.correct++
    p.chars[char] = stats
    p.koch.attemptsInLesson++
    p.koch.window.push(correct)
    if (p.koch.window.length > UNLOCK_WINDOW) p.koch.window.shift()
    recordAnswer(correct)
  }

  function advanceLesson() {
    const p = progress.value
    if (!canAdvance.value) return
    p.koch.lesson++
    p.koch.window = []
    p.koch.attemptsInLesson = 0
    addXp(100) // lesson-clear bonus
  }

  function recordPhraseAnswer(abbr: string, correct: boolean) {
    const p = progress.value
    p.phraseStreaks[abbr] = correct ? (p.phraseStreaks[abbr] ?? 0) + 1 : 0
    const raw = rawTierCount(p.phraseStreaks)
    if (raw > p.tierHighWater) p.tierHighWater = raw
    recordAnswer(correct)
  }

  function resetProgress() {
    const settings = { ...progress.value.settings }
    progress.value = { ...defaultState(), settings }
  }

  /** Restore default settings only — progress and stats are untouched. */
  function resetSettings() {
    progress.value.settings = { ...defaultState().settings }
  }

  return {
    progress,
    level,
    levelProgress,
    xpToNextLevel,
    unlockedChars,
    kochWindowAccuracy,
    canAdvance,
    kochComplete,
    masteredPhrases,
    unlockedTierCount,
    lifetimeAccuracy,
    weakestChars,
    addXp,
    recordCharAnswer,
    recordPhraseAnswer,
    advanceLesson,
    resetProgress,
    resetSettings
  }
}
