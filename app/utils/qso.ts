import { generateCallsign } from './callsigns'

/**
 * Scripted first-contact QSO, following the standard structure taught for a
 * beginner's CW contact (CQ → answer with DE → RST/name/QTH exchange, each
 * sent twice → 73 and <SK> sign-off), per the FISTS "Basic CW Operating
 * Manual" and the QRP-Labs beginner QSO walkthrough.
 */

export interface QsoField {
  key: 'call' | 'rst' | 'name' | 'qth'
  label: string
  answer: string
  placeholder: string
}

export interface QsoStep {
  /** listen: copy fields from what you hear; send: key the given text */
  type: 'listen' | 'send'
  /** what the other station keys (listen) or what you must key (send) */
  text: string
  /** short stage direction shown above the step */
  intro: string
  fields?: QsoField[]
}

export interface QsoScript {
  their: string
  name: string
  qth: string
  /** the report they give you */
  rst: string
  /** the report you give them */
  rstOut: string
  steps: QsoStep[]
}

const NAMES = ['BOB', 'JIM', 'SUE', 'ANN', 'TOM', 'RAY', 'JOE', 'PAT', 'DAN', 'KEN', 'LEE', 'MAX', 'AMY', 'ED', 'AL', 'MEG', 'RON', 'EVA']
const RSTS = ['599', '589', '579', '569', '559', '449']

const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]!

export function buildQso(myCall: string, myName: string): QsoScript {
  const gen = generateCallsign()!
  const their = gen.call
  const name = pick(NAMES)
  const qth = pick(gen.entity.qths)
  const rst = pick(RSTS)
  const rstOut = pick(RSTS)
  const me = myCall.toUpperCase()
  const my = myName.toUpperCase()

  const steps: QsoStep[] = [
    {
      type: 'listen',
      intro: 'A station is calling CQ. Copy their callsign.',
      text: `CQ CQ CQ DE ${their} ${their} ${their} K`,
      fields: [
        { key: 'call', label: 'Their callsign', answer: their, placeholder: 'W1ABC' }
      ]
    },
    {
      type: 'send',
      intro: 'Answer them: their call, DE, then your call.',
      text: `${their} DE ${me} ${me} K`
    },
    {
      type: 'listen',
      intro: 'They came back! Copy your signal report, their name, and their QTH (everything important is sent twice).',
      text: `${me} DE ${their} GM ES TNX FER CALL UR RST ${rst} ${rst} NAME ${name} ${name} QTH ${qth} ${qth} HW? ${me} DE ${their} K`,
      fields: [
        { key: 'rst', label: 'Your RST report', answer: rst, placeholder: '599' },
        { key: 'name', label: 'Their name', answer: name, placeholder: 'BOB' },
        { key: 'qth', label: 'Their QTH', answer: qth, placeholder: 'OHIO' }
      ]
    },
    {
      type: 'send',
      intro: 'Your turn: roger their info and send your half of the exchange.',
      text: `R FB ${name} UR RST ${rstOut} ${rstOut} NAME ${my} ${my} BK`
    },
    {
      type: 'listen',
      intro: 'They wrap up the contact. Just enjoy the copy — 73 means best regards, <SK> ends the contact.',
      text: `R FB ${my} TNX FER QSO 73 ${me} DE ${their} <SK>`
    }
  ]

  return { their, name, qth, rst, rstOut, steps }
}
