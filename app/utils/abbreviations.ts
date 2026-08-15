/**
 * Ham radio CW abbreviations, Q-signals, prosigns, and RST reports,
 * grouped into progressive tiers. `send` is what gets keyed (prosigns are
 * wrapped in <> so they are sent merged, with no inter-letter gap).
 */

export interface Phrase {
  /** what is displayed / typed as the answer */
  abbr: string
  /** what actually gets keyed */
  send: string
  meaning: string
}

export interface PhraseTier {
  name: string
  description: string
  items: Phrase[]
}

export const PHRASE_TIERS: PhraseTier[] = [
  {
    name: 'First Contact',
    description: 'The bare minimum to survive your first QSO.',
    items: [
      { abbr: 'CQ', send: 'CQ', meaning: 'Calling any station' },
      { abbr: 'DE', send: 'DE', meaning: 'From (this is)' },
      { abbr: 'K', send: 'K', meaning: 'Over — any station go ahead' },
      { abbr: 'R', send: 'R', meaning: 'Received / roger' },
      { abbr: 'UR', send: 'UR', meaning: 'Your / you are' },
      { abbr: '73', send: '73', meaning: 'Best regards' },
      { abbr: 'TU', send: 'TU', meaning: 'Thank you' },
      { abbr: 'ES', send: 'ES', meaning: 'And' }
    ]
  },
  {
    name: 'Signal Reports',
    description: 'RST reports and how they are sent on the air.',
    items: [
      { abbr: 'RST', send: 'RST', meaning: 'Readability, Strength, Tone report' },
      { abbr: '599', send: '599', meaning: 'Perfect readability, very strong, pure tone' },
      { abbr: '5NN', send: '5NN', meaning: '599 sent with cut numbers (N = 9)' },
      { abbr: '559', send: '559', meaning: 'Perfectly readable, fairly good signal' },
      { abbr: '449', send: '449', meaning: 'Readable with little difficulty, fair signal' },
      { abbr: 'SIG', send: 'SIG', meaning: 'Signal' },
      { abbr: 'PWR', send: 'PWR', meaning: 'Power' },
      { abbr: 'WPM', send: 'WPM', meaning: 'Words per minute' }
    ]
  },
  {
    name: 'Prosigns',
    description: 'Procedural signals sent as one merged character.',
    items: [
      { abbr: 'AR', send: '<AR>', meaning: 'End of message' },
      { abbr: 'SK', send: '<SK>', meaning: 'End of contact (silent key)' },
      { abbr: 'BT', send: '<BT>', meaning: 'Pause / new paragraph (=)' },
      { abbr: 'KN', send: '<KN>', meaning: 'Go ahead — named station only' },
      { abbr: 'AS', send: '<AS>', meaning: 'Wait / stand by' },
      { abbr: 'BK', send: '<BK>', meaning: 'Break — back to you' },
      { abbr: 'SOS', send: '<SOS>', meaning: 'International distress signal' }
    ]
  },
  {
    name: 'Rag Chewing',
    description: 'Everyday conversational shorthand.',
    items: [
      { abbr: 'FB', send: 'FB', meaning: 'Fine business (excellent)' },
      { abbr: 'HI', send: 'HI', meaning: 'Laughter' },
      { abbr: 'HR', send: 'HR', meaning: 'Here' },
      { abbr: 'HW', send: 'HW', meaning: 'How copy?' },
      { abbr: 'PSE', send: 'PSE', meaning: 'Please' },
      { abbr: 'TNX', send: 'TNX', meaning: 'Thanks' },
      { abbr: 'AGN', send: 'AGN', meaning: 'Again' },
      { abbr: 'RIG', send: 'RIG', meaning: 'Radio equipment' },
      { abbr: 'ANT', send: 'ANT', meaning: 'Antenna' },
      { abbr: 'WX', send: 'WX', meaning: 'Weather' },
      { abbr: 'NR', send: 'NR', meaning: 'Number / near' },
      { abbr: 'ABT', send: 'ABT', meaning: 'About' },
      { abbr: 'NW', send: 'NW', meaning: 'Now' }
    ]
  },
  {
    name: 'Q-Signals',
    description: 'The three-letter Q codes every CW op must know.',
    items: [
      { abbr: 'QTH', send: 'QTH', meaning: 'My location is…' },
      { abbr: 'QSL', send: 'QSL', meaning: 'I confirm receipt' },
      { abbr: 'QRZ', send: 'QRZ', meaning: 'Who is calling me?' },
      { abbr: 'QRM', send: 'QRM', meaning: 'Man-made interference' },
      { abbr: 'QRN', send: 'QRN', meaning: 'Atmospheric static' },
      { abbr: 'QSB', send: 'QSB', meaning: 'Signal fading' },
      { abbr: 'QSY', send: 'QSY', meaning: 'Change frequency' },
      { abbr: 'QRP', send: 'QRP', meaning: 'Low power operation' },
      { abbr: 'QRO', send: 'QRO', meaning: 'High power operation' },
      { abbr: 'QRS', send: 'QRS', meaning: 'Send more slowly' },
      { abbr: 'QRQ', send: 'QRQ', meaning: 'Send faster' },
      { abbr: 'QRT', send: 'QRT', meaning: 'Stop sending / shutting down' },
      { abbr: 'QRX', send: 'QRX', meaning: 'Stand by, I will call you' },
      { abbr: 'QRV', send: 'QRV', meaning: 'I am ready' },
      { abbr: 'QSO', send: 'QSO', meaning: 'A contact / conversation' }
    ]
  },
  {
    name: 'DX & Contesting',
    description: 'Chasing rare stations and working pileups.',
    items: [
      { abbr: 'DX', send: 'DX', meaning: 'Distant / rare station' },
      { abbr: 'CQ DX', send: 'CQ DX', meaning: 'Calling distant stations only' },
      { abbr: 'UP', send: 'UP', meaning: 'Listening up (split operation)' },
      { abbr: 'B4', send: 'B4', meaning: 'Before (worked you before)' },
      { abbr: 'BCNU', send: 'BCNU', meaning: 'Be seeing you' },
      { abbr: 'CUL', send: 'CUL', meaning: 'See you later' },
      { abbr: 'CFM', send: 'CFM', meaning: 'Confirm' },
      { abbr: 'CONDX', send: 'CONDX', meaning: 'Band conditions' },
      { abbr: 'GA', send: 'GA', meaning: 'Good afternoon / go ahead' },
      { abbr: 'GM', send: 'GM', meaning: 'Good morning' },
      { abbr: 'GE', send: 'GE', meaning: 'Good evening' },
      { abbr: 'GN', send: 'GN', meaning: 'Good night' },
      { abbr: 'GL', send: 'GL', meaning: 'Good luck' },
      { abbr: 'HPE', send: 'HPE', meaning: 'Hope' },
      { abbr: 'MNI', send: 'MNI', meaning: 'Many' },
      { abbr: 'VY', send: 'VY', meaning: 'Very' },
      { abbr: 'OP', send: 'OP', meaning: 'Operator name' },
      { abbr: '88', send: '88', meaning: 'Love and kisses' }
    ]
  }
]
