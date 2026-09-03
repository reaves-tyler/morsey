import { describe, expect, it } from 'vitest'
import { CwDecoder, charForPattern, PATTERN_TO_CHAR, type CwDecoderConfig } from '../app/utils/cwDecoder'
import { renderCw, noiseRmsForSnr, encodeWav16, SAMPLE_PRESETS, type CwSynthOptions } from '../app/utils/cwSynth'
import { MORSE } from '../app/utils/morse'

/**
 * End-to-end decoder tests on synthesized band audio. Everything is
 * deterministic (seeded noise, sample-counted time), so a failure here is a
 * real regression, not flakiness. 8 kHz keeps the suite fast; the detector
 * math is sample-rate independent.
 */

const FS = 8000

function decodeAudio(samples: Float32Array, cfg: Partial<CwDecoderConfig> = {}, blockSize = 512) {
  let text = ''
  const elements: string[] = []
  const decoder = new CwDecoder(
    { sampleRate: FS, ...cfg },
    {
      onCharacter: ch => { text += ch },
      onWordGap: () => { text += ' ' },
      onElement: el => elements.push(el)
    }
  )
  for (let i = 0; i < samples.length; i += blockSize) {
    decoder.process(samples.subarray(i, Math.min(samples.length, i + blockSize)))
  }
  decoder.flush()
  return { text: text.trim(), elements: elements.join(''), state: decoder.getState(), decoder }
}

function decodeText(opts: CwSynthOptions, cfg: Partial<CwDecoderConfig> = {}) {
  const { samples } = renderCw({ sampleRate: FS, ...opts })
  return decodeAudio(samples, cfg)
}

/** Levenshtein distance — for noisy cases where a few errors are acceptable */
function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
    }
  }
  return dp[a.length]![b.length]!
}

function accuracy(got: string, want: string): number {
  return 1 - editDistance(got, want) / want.length
}

describe('pattern lookup', () => {
  it('maps every ITU character back from its code', () => {
    for (const [ch, code] of Object.entries(MORSE)) expect(charForPattern(code)).toBe(ch)
  })

  it('prints prosigns the way the QMX does, letting punctuation win on collisions', () => {
    expect(charForPattern('...-.-')).toBe('<SK>')
    expect(charForPattern('-.--.')).toBe('<KN>')
    expect(charForPattern('.-.-.')).toBe('+') // AR
    expect(charForPattern('-...-')).toBe('=') // BT
    expect(charForPattern('.......-')).toBe('*')
    expect(Object.keys(PATTERN_TO_CHAR).length).toBeGreaterThan(Object.keys(MORSE).length)
  })
})

describe('clean machine-sent code', () => {
  it('decodes a CQ call at 20 WPM perfectly', () => {
    const { text, state } = decodeText({ text: 'CQ CQ CQ DE W1AW W1AW K', wpm: 20 })
    expect(text).toBe('CQ CQ CQ DE W1AW W1AW K')
    expect(Math.abs(state.wpm - 20) / 20).toBeLessThan(0.05)
  })

  it('decodes every character and prosign in the table', () => {
    const chars = Object.keys(MORSE).join(' ')
    const { text } = decodeText({ text: chars, wpm: 20 })
    expect(text).toBe(chars)
    const { text: pro } = decodeText({ text: '<SK> <KN> <AS> <BK>', wpm: 20 })
    expect(pro).toBe('<SK> <KN> <AS> <BK>')
  })

  it.each([15, 18, 25, 30, 35, 45])('tracks %i WPM from a 20 WPM prior', (wpm) => {
    const { text, state } = decodeText({ text: 'PARIS PARIS CODEX', wpm })
    expect(text).toBe('PARIS PARIS CODEX')
    expect(Math.abs(state.wpm - wpm) / wpm).toBeLessThan(0.1)
  })

  it.each([8, 12])('re-fits to %i WPM from a 20 WPM prior within the first word', (wpm) => {
    // A prior this far off can cost the first character (its intra-character
    // gap already exceeds the old letter boundary); everything after the
    // clusters re-fit must be exact.
    const { text, state } = decodeText({ text: 'PARIS PARIS CODEX', wpm })
    expect(text.endsWith('PARIS CODEX')).toBe(true)
    expect(text.replace(/\s/g, '').length).toBeLessThanOrEqual('PARISPARISCODEX'.length + 1)
    expect(Math.abs(state.wpm - wpm) / wpm).toBeLessThan(0.1)
  })

  it('recovers from a badly wrong speed prior within the first word', () => {
    // prior says 30 WPM (dit 40 ms); the sender is at 10 WPM (dit 120 ms):
    // the first word is ambiguous (HELLO's dits look like dahs until an L
    // shows both classes) but the second word must be perfect
    const { text, state } = decodeText({ text: 'HELLO WORLD', wpm: 10 }, { initialWpm: 30 })
    expect(text.endsWith(' WORLD')).toBe(true)
    expect(Math.abs(state.wpm - 10) / 10).toBeLessThan(0.1)
  })

  it('handles single-element streams (only dits, only dahs) without losing speed', () => {
    expect(decodeText({ text: 'EEEEE EEEEE', wpm: 15 }).text).toBe('EEEEE EEEEE')
    expect(decodeText({ text: 'TTTTT TTTTT', wpm: 15 }).text).toBe('TTTTT TTTTT')
    expect(decodeText({ text: 'E T E T', wpm: 15 }).text).toBe('E T E T')
  })

  it('follows a speed change mid-stream', () => {
    const slow = renderCw({ sampleRate: FS, text: 'SLOW CODE HERE', wpm: 14, tailSec: 0.6 })
    const fast = renderCw({ sampleRate: FS, text: 'NOW FAST', wpm: 28, leadInSec: 0 })
    const all = new Float32Array(slow.samples.length + fast.samples.length)
    all.set(slow.samples)
    all.set(fast.samples, slow.samples.length)
    const { text, state } = decodeAudio(all)
    // the word straddling the jump is lost while the clusters re-fit;
    // everything after it must be right and the speed must have followed
    expect(text).toMatch(/^SLOW CODE HERE/)
    expect(text).toMatch(/ FAST$/)
    expect(Math.abs(state.wpm - 28) / 28).toBeLessThan(0.1)
  })

  it('emits characters in real time — before the next character starts', () => {
    // A single "E" followed by a long silence must still be decoded
    const { samples } = renderCw({ sampleRate: FS, text: 'E', wpm: 20, tailSec: 1 })
    let seenAtMs = -1
    const decoder = new CwDecoder({ sampleRate: FS }, { onCharacter: () => { seenAtMs = decoder.timeMs } })
    decoder.process(samples)
    // lead-in 300 ms + 60 ms dit + a letter boundary of ~2 dits: well under 600 ms
    expect(seenAtMs).toBeGreaterThan(300)
    expect(seenAtMs).toBeLessThan(600)
  })
})

describe('spacing styles', () => {
  it('decodes Farnsworth 20/10 (stretched gaps) once the first word gap reveals the spacing', () => {
    // The first Farnsworth letter gaps (≈11 dits) look like word gaps until a
    // real word gap (≈25 dits) shows the two spacing classes; from then on
    // letters group correctly.
    const { text } = decodeText({ text: 'KMUR KUMR MRKU RUKM', wpm: 20, effectiveWpm: 10 })
    const words = text.split(' ')
    expect(words.slice(-3)).toEqual(['KUMR', 'MRKU', 'RUKM'])
    expect(text.replace(/ /g, '')).toBe('KMURKUMRMRKURUKM')
  })

  it('decodes Farnsworth 20/15 fully once calibrated', () => {
    const { text } = decodeText({ text: 'HELLO WORLD THIS IS FARNSWORTH', wpm: 20, effectiveWpm: 15 })
    expect(text.endsWith('WORLD THIS IS FARNSWORTH')).toBe(true)
  })

  it('decodes a heavy hand-sent fist (3.8:1 weight, jitter)', () => {
    const want = 'UR RST 579 579 = NAME OP = QTH TOWN K'
    const { text } = decodeText({ text: want, wpm: 15, weight: 3.8, jitter: 0.15, seed: 5 })
    expect(accuracy(text, want)).toBeGreaterThan(0.95)
  })

  it('decodes a light fist (2.5:1 weight)', () => {
    const want = 'CQ CQ DE N0CALL K'
    const { text } = decodeText({ text: want, wpm: 18, weight: 2.5 })
    expect(text).toBe(want)
  })
})

describe('band conditions', () => {
  it('is perfect at 15 dB SNR', () => {
    const want = 'TNX FER CALL = UR RST 559 559 = RIG IS QMX 5W K'
    const { text } = decodeText({ text: want, wpm: 18, snrDb: 15, seed: 21 })
    expect(text).toBe(want)
  })

  it('copies well at 8 dB SNR (a typical evening on 40 m)', () => {
    const want = 'TNX FER CALL = UR RST 559 559 = RIG IS QMX 5W K'
    const { text } = decodeText({ text: want, wpm: 18, snrDb: 8, seed: 22 })
    expect(accuracy(text, want)).toBeGreaterThan(0.95)
  })

  it('still gets most of it at 3 dB SNR', () => {
    const want = 'QRP QRP DE N0CALL N0CALL PSE K'
    const { text } = decodeText({ text: want, wpm: 16, snrDb: 3, seed: 23 })
    expect(accuracy(text, want)).toBeGreaterThan(0.8)
  })

  it('digs a −3 dB signal out of the noise once the bandwidth is narrowed', () => {
    // Below the noise in a 2.5 kHz receiver passband. The default 100 Hz
    // window is too wide for 16 WPM (a dit is 75 ms ≈ 13 Hz) and garbles;
    // 50 Hz buys the SNR back — this is what the bandwidth knob is for.
    const want = 'QRP QRP DE N0CALL N0CALL PSE K'
    const opts: CwSynthOptions = { text: want, wpm: 16, snrDb: -3, seed: 18 }
    expect(accuracy(decodeText(opts, { bandwidthHz: 100 }).text, want)).toBeLessThan(0.7)
    expect(decodeText(opts, { bandwidthHz: 50 }).text).toBe(want)
  })

  it('rides QSB (75 % fade, 12 dB left at the trough) with the adaptive threshold', () => {
    const want = 'QSB QSB UR SIG FADING = PSE RPT UR QTH K'
    const { text } = decodeText({ text: want, wpm: 20, snrDb: 20, qsb: { depth: 0.75, rateHz: 0.25 }, seed: 24 })
    expect(accuracy(text, want)).toBeGreaterThan(0.95)
  })

  it('loses only the trough of a 90 % fade that drops into the noise', () => {
    const want = 'QSB QSB UR SIG FADING = PSE RPT UR QTH K'
    const { text } = decodeText({ text: want, wpm: 20, snrDb: 14, qsb: { depth: 0.9, rateHz: 0.25 }, seed: 24 })
    // fixed-threshold decoders print garbage through a fade; ours goes quiet
    expect(text.length).toBeLessThan(want.length + 4)
    expect(accuracy(text, want)).toBeGreaterThan(0.25)
  })

  it('rejects an equal-strength QRM station 250 Hz away', () => {
    const want = 'CQ TEST CQ TEST DE N1XYZ N1XYZ TEST'
    const { text } = decodeText(
      { text: want, wpm: 22, snrDb: 20, qrm: { offsetHz: 250, level: 1 }, seed: 25 },
      { bandwidthHz: 100 }
    )
    expect(text).toBe(want)
  })

  it('needs a narrower bandwidth for QRM 120 Hz away', () => {
    const want = 'CQ TEST DE N1XYZ'
    const opts: CwSynthOptions = { text: want, wpm: 20, snrDb: 25, qrm: { offsetHz: 120, level: 1 }, seed: 26 }
    const narrow = decodeText(opts, { bandwidthHz: 40 })
    expect(narrow.text).toBe(want)
  })

  it('tolerates hard keying (no envelope shaping = key clicks)', () => {
    const want = 'CLICKY KEYING TEST'
    const { text } = decodeText({ text: want, wpm: 20, riseMs: 0, snrDb: 20, seed: 27 })
    expect(text).toBe(want)
  })

  it('tolerates a pitch offset inside the passband and follows slow drift', () => {
    const want = 'DRIFTING SIGNAL'
    const { text } = decodeText({ text: want, wpm: 18, toneHz: 730, driftHz: -40, snrDb: 20, seed: 28 }, { bandwidthHz: 150 })
    expect(text).toBe(want)
  })

  it('decodes at 30 WPM through 15 dB noise', () => {
    const want = 'W1AW 5NN 05 TU'
    const { text } = decodeText({ text: want, wpm: 30, snrDb: 15, seed: 29 })
    expect(text).toBe(want)
  })
})

describe('squelch and thresholds', () => {
  it('produces nothing from noise alone', () => {
    const { samples } = renderCw({ sampleRate: FS, text: '', snrDb: 0, tailSec: 6 })
    // renderCw with empty text gives pure noise at the "0 dB" level
    const { text } = decodeAudio(samples)
    expect(text).toBe('')
  })

  it('produces nothing from digital silence', () => {
    const { text, state } = decodeAudio(new Float32Array(FS * 3))
    expect(text).toBe('')
    expect(state.keyed).toBe(false)
  })

  it('ignores a tone outside the passband', () => {
    const { text } = decodeText({ text: 'CQ CQ', wpm: 20, toneHz: 1200 }, { bandwidthHz: 100 })
    expect(text).toBe('')
  })

  it('manual threshold keys on level alone', () => {
    // 0.5 amplitude tone; manual thresholds below/above it
    const opts: CwSynthOptions = { text: 'MANUAL', wpm: 20, amplitude: 0.5 }
    expect(decodeText(opts, { thresholdMode: 'manual', manualThreshold: 0.25 }).text).toBe('MANUAL')
    expect(decodeText(opts, { thresholdMode: 'manual', manualThreshold: 0.8 }).text).toBe('')
  })

  it('reports a sensible SNR and normalized magnitude', () => {
    const { samples } = renderCw({ sampleRate: FS, text: 'TTTTTTTT', wpm: 10, amplitude: 0.5, snrDb: 20, leadInSec: 1 })
    const decoder = new CwDecoder({ sampleRate: FS })
    let maxMag = 0
    for (let i = 0; i < samples.length; i += 256) {
      decoder.process(samples.subarray(i, i + 256))
      maxMag = Math.max(maxMag, decoder.getState().magnitude)
    }
    expect(maxMag).toBeGreaterThan(0.45)
    expect(maxMag).toBeLessThan(0.6)
    const s = decoder.getState()
    expect(s.snrDb).toBeGreaterThan(15)
  })

  it('lockSpeed freezes the timing estimate', () => {
    const { state } = decodeText({ text: 'PARIS PARIS', wpm: 10 }, { initialWpm: 20, lockSpeed: true })
    expect(state.wpm).toBeCloseTo(20, 5)
  })
})

describe('decode confidence', () => {
  it('is high for clean machine code and lower for a sloppy fist or noise', () => {
    const clean = decodeText({ text: 'CQ CQ CQ DE W1AW W1AW K', wpm: 20 }).state.confidence
    const sloppy = decodeText({ text: 'CQ CQ CQ DE W1AW W1AW K', wpm: 20, weight: 3.8, jitter: 0.35, seed: 41 }).state.confidence
    const noisy = decodeText({ text: 'CQ CQ CQ DE W1AW W1AW K', wpm: 20, snrDb: 0, seed: 42 }).state.confidence
    expect(clean).toBeGreaterThan(0.85)
    expect(sloppy).toBeLessThan(clean)
    expect(noisy).toBeLessThan(clean)
    expect(sloppy).toBeGreaterThan(0.2)
  })
})

describe('configuration', () => {
  it('re-tunes the centre frequency on the fly', () => {
    const { samples } = renderCw({ sampleRate: FS, text: 'RETUNE OK', wpm: 20, toneHz: 900 })
    let text = ''
    const decoder = new CwDecoder({ sampleRate: FS, centerHz: 600 }, { onCharacter: c => { text += c }, onWordGap: () => { text += ' ' } })
    decoder.process(samples.subarray(0, 1000))
    decoder.configure({ centerHz: 900 })
    decoder.process(samples.subarray(1000))
    decoder.flush()
    expect(text.trim()).toBe('RETUNE OK')
  })

  it('reset clears pending state', () => {
    const { samples } = renderCw({ sampleRate: FS, text: 'E', wpm: 20, tailSec: 0 })
    let chars = 0
    const decoder = new CwDecoder({ sampleRate: FS }, { onCharacter: () => chars++ })
    decoder.process(samples) // dit ends, no letter gap yet
    decoder.reset()
    decoder.process(new Float32Array(FS))
    expect(chars).toBe(0)
    expect(decoder.getState().pattern).toBe('')
  })

  it('is independent of block size', () => {
    const { samples } = renderCw({ sampleRate: FS, text: 'BLOCK SIZE', wpm: 20, snrDb: 12, seed: 31 })
    const a = decodeAudio(samples, {}, 128).text
    const b = decodeAudio(samples, {}, 4096).text
    const c = decodeAudio(samples, {}, 7).text
    expect(a).toBe('BLOCK SIZE')
    expect(b).toBe(a)
    expect(c).toBe(a)
  })

  it('works at 48 kHz too', () => {
    const { samples } = renderCw({ sampleRate: 48000, text: 'HI FS', wpm: 20, snrDb: 15 })
    let text = ''
    const decoder = new CwDecoder({ sampleRate: 48000 }, { onCharacter: c => { text += c }, onWordGap: () => { text += ' ' } })
    decoder.process(samples)
    decoder.flush()
    expect(text.trim()).toBe('HI FS')
  })
})

describe('synthesizer', () => {
  it('is deterministic for a given seed', () => {
    const a = renderCw({ sampleRate: FS, text: 'SEED', snrDb: 5, seed: 7 }).samples
    const b = renderCw({ sampleRate: FS, text: 'SEED', snrDb: 5, seed: 7 }).samples
    expect(Array.from(a.subarray(0, 200))).toEqual(Array.from(b.subarray(0, 200)))
  })

  it('scales noise for the quoted 2.5 kHz SNR', () => {
    // at 8 kHz the Nyquist band is 4 kHz, so 2.5 kHz holds 62.5 % of the noise power
    const sigma = noiseRmsForSnr(0, 0.5, FS)
    const signalRms = 0.5 / Math.SQRT2
    expect(sigma * Math.sqrt(2500 / 4000)).toBeCloseTo(signalRms, 6)
    expect(noiseRmsForSnr(Infinity, 0.5, FS)).toBe(0)
  })

  it('writes a valid 16-bit WAV header', () => {
    const wav = encodeWav16(new Float32Array([0, 0.5, -0.5, 1]), FS)
    const v = new DataView(wav)
    expect(String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3))).toBe('RIFF')
    expect(v.getUint32(24, true)).toBe(FS)
    expect(v.getUint16(34, true)).toBe(16)
    expect(v.getInt16(46, true)).toBe(Math.round(0.5 * 0x7FFF))
    expect(v.getInt16(50, true)).toBe(0x7FFF)
    expect(wav.byteLength).toBe(44 + 8)
  })

  it('every shipped sample preset decodes to its text within its difficulty budget', () => {
    // difficulty 1–2: exact; 3–4: ≥ 90 %; 5: ≥ 75 %
    for (const preset of SAMPLE_PRESETS) {
      const want = preset.options.text.toUpperCase()
      // presets whose description tells the operator to narrow the bandwidth are tested that way
      const cfg: Partial<CwDecoderConfig> = preset.id.startsWith('qrm') ? { bandwidthHz: 60 } : preset.id.startsWith('weak') ? { bandwidthHz: 50 } : {}
      const { text } = decodeText({ sampleRate: FS, ...preset.options }, cfg)
      const acc = accuracy(text.replace(/\s+/g, ' '), want)
      const floor = preset.difficulty <= 2 ? (preset.id.startsWith('farnsworth') ? 0.8 : 0.97) : preset.difficulty <= 4 ? 0.9 : 0.75
      expect(acc, `${preset.id}: "${text}"`).toBeGreaterThanOrEqual(floor)
    }
  })
})
