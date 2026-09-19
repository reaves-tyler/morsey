import { describe, expect, it } from 'vitest'
import { CwDecoder, MAX_WPM, MIN_WPM, charForPattern, PATTERN_TO_CHAR, type CwDecoderConfig } from '../app/utils/cwDecoder'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { renderCw, noiseRmsForSnr, encodeWav16, decodeWav16, SAMPLE_PRESETS, type CwSynthOptions } from '../app/utils/cwSynth'
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
    const { samples } = renderCw({ sampleRate: FS, text: 'H H', wpm: 20, tailSec: 1 })
    let seenAtMs = -1
    const decoder = new CwDecoder({ sampleRate: FS }, { onCharacter: () => { if (seenAtMs < 0) seenAtMs = decoder.timeMs } })
    decoder.process(samples)
    // lead-in 300 ms + H (four 60 ms dits, three 60 ms gaps) ends at 720 ms; a
    // letter boundary of ~2 dits prints it around 820 ms, while the second H
    // does not start until 1140 ms
    expect(seenAtMs).toBeGreaterThan(700)
    expect(seenAtMs).toBeLessThan(1000)
  })

  it('drops a squelched burst on reset instead of printing it into the next session', () => {
    // Start on the decode page calls reset(). A burst that never qualified
    // belongs to the session that ended, not the one beginning.
    const lone = renderCw({ sampleRate: FS, text: 'K', wpm: 20, tailSec: 1 }).samples
    const next = renderCw({ sampleRate: FS, text: 'CQ DE W1AW', wpm: 20 }).samples
    let text = ''
    const decoder = new CwDecoder({ sampleRate: FS }, { onCharacter: ch => { text += ch }, onWordGap: () => { text += ' ' } })
    decoder.process(lone)
    decoder.flush()
    expect(text).toBe('')
    decoder.reset()
    decoder.process(next)
    decoder.flush()
    expect(text.trim()).toBe('CQ DE W1AW')
  })

  it('does not print a lone blip as a letter', () => {
    // One mark with silence on both sides is a static crash, not an E. Real
    // code arrives in runs — even a bare "K" is three elements at the end of
    // an over — so a burst has to reach four elements before it is printed.
    expect(decodeText({ text: 'E', wpm: 20, tailSec: 1 }).text).toBe('')
    expect(decodeText({ text: 'K', wpm: 20, tailSec: 1 }).text).toBe('')
    expect(decodeText({ text: 'OK', wpm: 20, tailSec: 1 }).text).toBe('OK')
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

  it.each([12, 10, 7, 5])('decodes ARRL Farnsworth 20/%i once the first word gap reveals the spacing', (effectiveWpm) => {
    // 20/5 leaves ~62 dits between words and ~27 between letters. Any rule that
    // writes off long silences has to clear that, or every stretched letter gap
    // prints as a word space and the whole over comes out letter by letter.
    const want = 'HELLO WORLD THIS IS FARNSWORTH'
    const { text } = decodeText({ text: want, wpm: 20, effectiveWpm, snrDb: 30, seed: 3 })
    expect(text.endsWith('WORLD THIS IS FARNSWORTH'), `20/${effectiveWpm}: "${text}"`).toBe(true)
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
    // Not exact: at 14 dB in a 50 Hz window the signal is only ~5 σ over the
    // noise, so it sits right on the CFAR gate and the opening characters are
    // copied while the level histogram is still filling. The tail, once the
    // levels have settled, is exact. Buying those first characters back means
    // biasing the noise estimate low, which is what used to let the gate slide
    // into the band hash between transmissions.
    const { text } = decodeText(opts, { bandwidthHz: 50 })
    expect(accuracy(text, want), text).toBeGreaterThanOrEqual(0.7)
    expect(text.endsWith('N0CALL PSE K'), text).toBe(true)
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

  it('resetLevels re-learns the floor and peak after a gain change without touching timing', () => {
    // a strong signal, then the same sender 26 dB quieter (the operator turned the interface down)
    const loud = renderCw({ sampleRate: FS, text: 'PARIS PARIS', wpm: 20 }).samples
    const quiet = renderCw({ sampleRate: FS, text: 'CODEX CODEX', wpm: 20, seed: 7 }).samples.map(v => v * 0.05)
    let text = ''
    const decoder = new CwDecoder({ sampleRate: FS }, { onCharacter: ch => { text += ch }, onWordGap: () => { text += ' ' } })
    for (let i = 0; i < loud.length; i += 512) decoder.process(loud.subarray(i, i + 512))
    const before = decoder.getState()
    decoder.resetLevels()
    const reset = decoder.getState()
    expect(reset.peak).toBe(0)
    expect(reset.ditMs).toBeCloseTo(before.ditMs, 5) // timing survives
    for (let i = 0; i < quiet.length; i += 512) decoder.process(quiet.subarray(i, i + 512))
    decoder.flush()
    const after = decoder.getState()
    expect(text.trim()).toBe('PARIS PARIS CODEX CODEX')
    expect(after.peak).toBeLessThan(before.peak * 0.1) // the peak tracker now describes the quiet signal
    expect(after.peak).toBeGreaterThan(0.01)
  })

  it('recovers when the levels are learned on a tone (listening started mid-mark)', () => {
    // a second of steady carrier first, so the warm-up takes the tone for the noise floor
    const carrier = new Float32Array(FS)
    for (let i = 0; i < carrier.length; i++) carrier[i] = 0.5 * Math.sin((2 * Math.PI * 700 * i) / FS)
    const rest = renderCw({ sampleRate: FS, text: 'PARIS PARIS', wpm: 20 }).samples
    const all = new Float32Array(carrier.length + rest.length)
    all.set(carrier)
    all.set(rest, carrier.length)
    const { text } = decodeAudio(all)
    expect(text.endsWith('PARIS PARIS'), `"${text}"`).toBe(true)
  })

  it('recovers when listening starts in the middle of a transmission', () => {
    // skip the leading silence and half of the first character: the warm-up learns a toggling signal
    const { samples } = renderCw({ sampleRate: FS, text: 'PARIS PARIS CODEX CODEX', wpm: 20 })
    let first = samples.findIndex(v => Math.abs(v) > 0.1)
    first += Math.round(0.04 * FS) // 40 ms into the first dit
    const { text } = decodeAudio(samples.subarray(first))
    expect(text.endsWith('CODEX CODEX'), `"${text}"`).toBe(true)
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

/**
 * Real radio audio: takes recorded on the decode page from a Quansheng UV-K5
 * (NR7Y firmware, CW mode, straight-keyed on the PTT by a novice) into a
 * Focusrite Scarlett Solo, downsampled to 8 kHz. 700 Hz tone about 30 dB over
 * the noise with a strong third harmonic at 2100 Hz 12 dB down. Takes 1–4
 * were recorded hot (peaks within 1.5 dB of full scale); take 5 at a sane
 * level (peak −13 dBFS) and it is the reference: every keyed letter exact.
 * The fist is the limiting factor, not the signal: letter gaps run 4–7 dits
 * and overlap the word gaps, so spacing is not asserted — only that the
 * signal path is right (pitch, level, speed) and the letters come through.
 * `letters` is what was actually keyed (the DE was skipped), spaces removed.
 */
describe('real K5 recordings', () => {
  const dir = join(__dirname, 'fixtures', 'k5')
  const TAKES: { file: string; letters: string; minAccuracy: number }[] = [
    // first session: text not agreed in advance, so a letter-count floor only
    { file: 'k5-cq-1.wav', letters: 'CQCQKR4NZNKR4NZNK', minAccuracy: 0.8 },
    { file: 'k5-cq-2.wav', letters: 'CQCQKR4NZNKR4NZN', minAccuracy: 0.8 },
    { file: 'k5-cq-3.wav', letters: 'CQCQKR4NZNKR4NZNK', minAccuracy: 0.8 },
    // agreed text, every keyed letter copied
    { file: 'k5-cq-4.wav', letters: 'CQCQCQKR4NZNKR4NZNKR4NZNK', minAccuracy: 1 },
    // agreed text at a proper input level: the reference take. The third element of
    // the second call's Z is 146 ms — between the sender's dits (~90) and dahs (~220) —
    // and flips with the resampler, so one miss is allowed (exact at the native 48 kHz)
    { file: 'k5-cq-5.wav', letters: 'CQCQCQKR4NZNKR4NZNKR4NZNK', minAccuracy: 0.96 }
  ]

  it('has a fixture entry for every WAV in the folder', () => {
    expect(readdirSync(dir).filter(f => f.endsWith('.wav')).sort()).toEqual(TAKES.map(t => t.file).sort())
  })

  it.each(TAKES)('$file: copies the call through the harmonics and static', ({ file, letters, minAccuracy }) => {
    const { samples, sampleRate } = decodeWav16(readFileSync(join(dir, file)).buffer as ArrayBuffer)
    expect(sampleRate).toBe(8000)
    let text = ''
    const decoder = new CwDecoder({ sampleRate }, { onCharacter: ch => { text += ch }, onWordGap: () => { text += ' ' } })
    for (let i = 0; i < samples.length; i += 1024) decoder.process(samples.subarray(i, Math.min(samples.length, i + 1024)))
    decoder.flush()
    const state = decoder.getState()
    // signal path: the 700 Hz default sits on the K5's tone, strong and clean
    expect(state.snrDb, `${file} SNR`).toBeGreaterThan(15)
    expect(state.calibrated).toBe(true)
    expect(state.wpm, `${file} speed`).toBeGreaterThan(8)
    expect(state.wpm, `${file} speed`).toBeLessThan(16)
    // copy: spacing aside, the letters are there
    const got = text.replace(/\s+/g, '')
    expect(got, `${file}: "${text}"`).toContain('KR4NZN')
    expect(accuracy(got, letters), `${file}: "${text}"`).toBeGreaterThanOrEqual(minAccuracy)
  })
})

/**
 * Real band audio: takes recorded off a Yaesu FT-991A on 40 m with the decode
 * page's Rec button, cut to the interesting minute and downsampled to 8 kHz.
 * Unlike the K5 fixtures — a loopback of one known sender — these are the band
 * as it actually is: DX and POTA/SOTA stations from 11 to 29 WPM, QSB, QRM,
 * static crashes, stretches of nothing but noise between overs, and the
 * operator's own transmissions muting the receiver.
 *
 * They exist because of what the decoder used to do with them. A dit estimate
 * with no lower bound walked down onto the band hash until it read 600 WPM,
 * and from there every noise blip was an element: one 8-minute take printed
 * 1066 characters of which 88 % were E and T, with four of the ten phrases
 * that were really sent nowhere in it. The assertions below are the two halves
 * of that: the copy has to be there, and the junk around it has to not be.
 *
 * `phrases` are matched with spacing removed. The spacing in these takes is
 * the senders' own — several of them leave 5–7 dits between letters, which no
 * timing rule can tell from a word gap — so word breaks are not asserted.
 */
describe('real Yaesu FT-991A band recordings', () => {
  const dir = join(__dirname, 'fixtures', 'ft991a')
  /** band noise with no signal in it — a stress source, not a take (see the suite below) */
  const NOISE_FILE = '991a-band-noise.wav'
  const TAKES: { file: string; phrases: string[]; maxEtShare: number; maxChars: number }[] = [
    // a strong European IOTA station calling CQ over and over at 25 WPM
    { file: '991a-iota-cq.wav', phrases: ['CQ VE2/LX1NO/P IOTA NA128'], maxEtShare: 0.15, maxChars: 90 },
    // 12 WPM ragchew, wide letter spacing, deep fades
    { file: '991a-dennis-rig.wav', phrases: ['FB DENNIS', 'RIG HR IS'], maxEtShare: 0.3, maxChars: 55 },
    { file: '991a-wb3bvz-qth.wav', phrases: ['QTHISCAR', 'RST5'], maxEtShare: 0.3, maxChars: 55 },
    // nothing on frequency but band noise until a "CQ TEST" at the very end:
    // the old decoder printed 396 characters here, 97 % of them E and T
    { file: '991a-dead-band.wav', phrases: ['QTEST'], maxEtShare: 0.7, maxChars: 14 },
    { file: '991a-k5wva-579.wav', phrases: ['KR4NZNK5WVATU579WV', 'CQCQTEST'], maxEtShare: 0.25, maxChars: 55 },
    { file: '991a-pota-ke2mtk.wav', phrases: ['POTADEKE2MT', 'KR4NZN'], maxEtShare: 0.35, maxChars: 60 },
    { file: '991a-pota-kg4exy.wav', phrases: ['57N57NBK', 'CQPOTAKG4EXY'], maxEtShare: 0.2, maxChars: 60 },
    { file: '991a-sota-w3pd029.wav', phrases: ['SOTAREFW3/PD029W3/PD029', 'TNX', 'NOPOTANOPOTA'], maxEtShare: 0.3, maxChars: 85 },
    // starts inside the operator's own transmission, where the receiver is
    // muted and its residue is 30 dB over a floor that has collapsed with it
    { file: '991a-w2lcq-rst.wav', phrases: ['NZNDEW2LCQOKUR', '569569OK'], maxEtShare: 0.45, maxChars: 65 },
    { file: '991a-w2lcq-de.wav', phrases: ['DEW2LCQ'], maxEtShare: 0.5, maxChars: 20 }
  ]

  it('has a fixture entry for every WAV in the folder', () => {
    const wavs = readdirSync(dir).filter(f => f.endsWith('.wav') && f !== NOISE_FILE).sort()
    expect(wavs).toEqual(TAKES.map(t => t.file).sort())
  })

  it.each(TAKES)('$file: copies what was sent', ({ file, phrases }) => {
    const { text } = decodeTake(file)
    const flat = text.replace(/\s+/g, '')
    for (const p of phrases) expect(flat, `${file}: "${text}"`).toContain(p.replace(/ /g, ''))
  })

  it.each(TAKES)('$file: prints nothing much else', ({ file, maxEtShare, maxChars }) => {
    const { chars, text, maxWpm } = decodeTake(file)
    // E and T are one element each: they are what a decoder keying on noise
    // produces, and their share is the cleanest measure of how much of the
    // page is junk. Real English CW runs about 20 %.
    const et = chars.filter(c => c === 'E' || c === 'T').length / Math.max(1, chars.length)
    expect(et, `${file}: "${text}"`).toBeLessThanOrEqual(maxEtShare)
    expect(chars.length, `${file}: "${text}"`).toBeLessThanOrEqual(maxChars)
    // the speed estimate never leaves the range CW is sent at
    expect(maxWpm, file).toBeLessThanOrEqual(MAX_WPM)
  })

  function decodeTake(file: string) {
    const { samples, sampleRate } = decodeWav16(readFileSync(join(dir, file)).buffer as ArrayBuffer)
    expect(sampleRate).toBe(8000)
    let text = ''
    const chars: string[] = []
    let maxWpm = 0
    const decoder = new CwDecoder({ sampleRate }, {
      onCharacter: ch => { text += ch; chars.push(ch) },
      onWordGap: () => { text += ' ' }
    })
    for (let i = 0; i < samples.length; i += 1024) {
      decoder.process(samples.subarray(i, Math.min(samples.length, i + 1024)))
      maxWpm = Math.max(maxWpm, decoder.getState().wpm)
    }
    decoder.flush()
    return { text: text.trim(), chars, maxWpm }
  }
})

/**
 * Real signal, real static, and a number on the ratio between them.
 *
 * The takes above are all comfortable signals — 14 to 37 dB over the noise in
 * a 2.5 kHz bandwidth — because that is what was on the band those afternoons.
 * Tuning a decoder only on those would be tuning it on armchair copy, so this
 * mixes `991a-band-noise.wav` (forty seconds of the same rig on a dead 40 m,
 * measured stationary and Rayleigh to within 0.5 dB at every quantile, static
 * crashes included) into the machine-keyed IOTA CQ at a stated SNR.
 *
 * Only the ratio is synthetic. The noise is the real band through the real
 * receiver, which matters: it is shaped — the FT-991A's CW filter peaks it
 * around 500–600 Hz, right where the detector sits — so it costs more than
 * white noise at the same quoted SNR, and the numbers here are correspondingly
 * harsher than the synthesized cases above.
 */
describe('real band noise over a real signal', () => {
  const dir = join(__dirname, 'fixtures', 'ft991a')
  const WANT = 'CQ VE2/LX1NO/P IOTA NA128'

  function mixed(snrDb: number) {
    const sig = decodeWav16(readFileSync(join(dir, '991a-iota-cq.wav')).buffer as ArrayBuffer)
    const noise = decodeWav16(readFileSync(join(dir, '991a-band-noise.wav')).buffer as ArrayBuffer)
    expect(sig.sampleRate).toBe(noise.sampleRate)
    // the clip's tone amplitude, as `noiseRmsForSnr` means it
    const peaks = Float32Array.from(sig.samples, Math.abs).sort()
    const amplitude = peaks[Math.floor(0.999 * peaks.length)]!
    let sum = 0
    for (const v of noise.samples) sum += v * v
    const scale = noiseRmsForSnr(snrDb, amplitude, sig.sampleRate) / Math.sqrt(sum / noise.samples.length)
    const out = new Float32Array(sig.samples.length)
    let peak = 0
    for (let i = 0; i < out.length; i++) {
      out[i] = sig.samples[i]! + scale * noise.samples[i % noise.samples.length]!
      peak = Math.max(peak, Math.abs(out[i]!))
    }
    if (peak > 0.99) for (let i = 0; i < out.length; i++) out[i]! *= 0.99 / peak
    return out
  }

  function copies(text: string) {
    return (text.replace(/\s+/g, '').match(/CQVE2\/LX1NO\/PIOTANA128/g) || []).length
  }

  it.each([15, 12, 9])('copies the call under real static at %i dB', (snrDb) => {
    const { text, state } = decodeAudio(mixed(snrDb))
    expect(copies(text), `${snrDb} dB: "${text}"`).toBeGreaterThanOrEqual(2)
    expect(state.wpm).toBeGreaterThan(20)
    expect(state.wpm).toBeLessThan(32)
  })

  it('needs the filter narrowed at 6 dB, which is what the bandwidth control is for', () => {
    // the default 100 Hz window lets too much of a shaped noise floor through
    const wide = decodeAudio(mixed(6))
    const narrow = decodeAudio(mixed(6), { bandwidthHz: 40 })
    expect(copies(narrow.text), narrow.text).toBeGreaterThanOrEqual(1)
    expect(copies(narrow.text)).toBeGreaterThan(copies(wide.text))
  })

  it('degrades instead of running away once the signal is unreadable', () => {
    // 0 dB in 2.5 kHz of shaped band noise is not copyable at 25 WPM by
    // anything, and the decoder is not expected to read it. What it must not
    // do is what it used to: latch the dit estimate onto the noise and print
    // hundreds of characters of E and T.
    for (const snrDb of [3, 0]) {
      const { text, state } = decodeAudio(mixed(snrDb))
      expect(state.wpm, `${snrDb} dB`).toBeGreaterThanOrEqual(MIN_WPM)
      expect(state.wpm, `${snrDb} dB`).toBeLessThanOrEqual(MAX_WPM)
      // the clip holds 62 real characters; junk must stay the same order
      expect(text.replace(/\s+/g, '').length, `${snrDb} dB: "${text}"`).toBeLessThan(200)
    }
  })
})
