<script setup lang="ts">
/**
 * About & FAQ. Plain, crawlable prose on how the trainer works plus honest
 * answers to the questions people actually ask — also emitted as FAQPage
 * structured data. Keep claims modest (no inflated learning-time promises).
 */
useSeoMeta({
  title: 'About Morsey — How the Free Morse Code Trainer Works, and FAQ',
  description: 'How Morsey teaches Morse code: the Koch method at full character speed, Farnsworth timing, sending practice with a real key or paddle over USB, a QSO simulator and a live CW decoder. Plus answers to common questions: cost, learning time, licenses, phones, hardware.',
  ogTitle: 'About Morsey & FAQ',
  ogDescription: 'Koch method, Farnsworth timing, real-key sending, QSO simulator, live decoder. Free, open source, no account.'
})

const BRIDGE_GUIDE = 'https://github.com/reaves-tyler/morsey/blob/main/hardware/pico-bridge/README.md'

type Faq = { q: string; a: string; link?: { href: string; label: string } }

const faq: Faq[] = [
  {
    q: 'Is Morsey really free?',
    a: 'Yes. Morsey is free and open source, with no account, no ads and no tracking. Your progress is stored in your own browser, and you can export it as a file. Once installed as a web app it works offline.'
  },
  {
    q: 'What is the Koch method, and why are the characters so fast?',
    a: 'The Koch method teaches Morse code as sounds rather than dots and dashes to count. You start with two characters sent at full speed (20 WPM by default) and add one more each time you copy at 90% accuracy. Slowing the characters down would teach you a different rhythm you would later have to unlearn, so Morsey only stretches the spacing between them (Farnsworth timing) and never the characters themselves.'
  },
  {
    q: 'How long does it take to learn Morse code?',
    a: 'It varies a lot, but with 10 to 15 minutes of Koch practice a day most people have all 41 characters within one to three months. Copying real on-air conversations comfortably at 15 to 20 WPM usually takes several more months of regular listening. Short daily sessions beat long weekly ones, which is why Morsey tracks a daily streak.'
  },
  {
    q: 'Do I need an amateur radio license to learn Morse code?',
    a: 'No. Anyone can learn and practice. You only need a license to transmit on the amateur bands, and most countries, including the United States since 2007, no longer require a Morse test for that license. Many hams learn CW after they are licensed simply because it is fun and reaches far on little power.'
  },
  {
    q: 'How do I send Morse code without any hardware?',
    a: 'On a phone or tablet, tap the on-screen key with your fingers: it acts as a straight key, or as two paddles (left dit, right dah) when a paddle key type is selected. On a computer, click the same on-screen key with the mouse, or use the keyboard: the space bar is a straight key, and the [ and ] keys (or left and right Ctrl) are the two paddle contacts. Everything you send is decoded live, and the fist report works the same way regardless of what you keyed with.'
  },
  {
    q: 'Can I use my own straight key or paddle?',
    a: 'Yes. Any key with a 3.5 mm plug connects through a small USB bridge built from a Raspberry Pi Pico: plug the Pico into your computer, copy the provided main.py onto it, wire a 3.5 mm jack to two GPIO pins and ground, plug in your key, and press CONNECT in the keyer bar at the bottom of the screen. Straight key, bug, sideswiper, and iambic A or B paddles are all supported, with adjustable weight and debounce like a transceiver keyer menu. The step-by-step guide covers the wiring, flashing the Pico, connecting the key, and Linux serial-port setup.',
    link: { href: BRIDGE_GUIDE, label: 'Pico key bridge setup guide' }
  },
  {
    q: 'Does it work on a phone or tablet?',
    a: 'Yes. Morsey runs in any modern browser on iOS and Android and can be installed to the home screen as an app. The receive trainer, phrases, QSO simulator and the on-screen key all work with a finger. Connecting a physical key over USB uses the Web Serial API, which browsers currently offer only on desktop Chrome and Edge.'
  },
  {
    q: 'Can Morsey decode Morse code from my radio?',
    a: 'Yes. The Decode page takes audio from your transceiver through line-in or a USB sound card, shows a spectrum so you can tune to the signal, and prints the decoded text live with automatic speed tracking. It is meant as a training aid for checking your copy, not a replacement for your ears.'
  },
  {
    q: 'Where is my progress stored, and can I move it to another device?',
    a: 'Everything lives in your browser\'s local storage on the device you are using; nothing is sent anywhere. The Settings page exports your progress and settings as a JSON file you can import on another device or keep as a backup.'
  }
]

useHead({
  script: [
    {
      type: 'application/ld+json',
      innerHTML: JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: faq.map(f => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.link ? `${f.a} ${f.link.label}: ${f.link.href}` : f.a }
        }))
      })
    }
  ]
})
</script>

<template>
  <div class="space-y-8">
    <header>
      <h1 class="text-2xl font-semibold tracking-tight">About Morsey</h1>
      <p class="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-400">
        Morsey is a free, open-source Morse code trainer built by a ham, for hams. It exists because learning CW
        should not require an account, an app store, or a Windows machine — just a browser, ten minutes a day,
        and eventually a key. The source is on
        <a href="https://github.com/reaves-tyler/morsey" target="_blank" rel="noopener noreferrer" class="text-emerald-400 hover:underline">GitHub</a>.
      </p>
    </header>

    <section class="space-y-4">
      <h2 class="text-lg font-semibold tracking-tight">How Morsey teaches Morse code</h2>
      <div class="grid gap-4 text-sm leading-relaxed text-zinc-400 md:grid-cols-2">
        <div>
          <h3 class="font-medium text-zinc-200">Koch method, full-speed characters</h3>
          <p class="mt-1">
            You learn Morse code as <em>sounds</em>, not as dots and dashes to count. Training starts with two
            characters sent at a realistic 20 words per minute and adds one more each time you copy at 90%
            accuracy. Forty-one characters cover the full alphabet, digits and the punctuation used on the air.
          </p>
        </div>
        <div>
          <h3 class="font-medium text-zinc-200">Farnsworth timing</h3>
          <p class="mt-1">
            Characters stay fast; only the gaps between them stretch, using the ARRL Farnsworth formula. As you
            improve, the spacing closes toward standard timing. You never have to relearn the rhythm of a
            character because you first heard it slowed down.
          </p>
        </div>
        <div>
          <h3 class="font-medium text-zinc-200">Sending with a real key</h3>
          <p class="mt-1">
            Plug a straight key, bug or iambic paddle into a small USB bridge and Morsey decodes your fist live,
            with iambic A and B, paddle reverse and keyer-feel settings just like a transceiver menu. A fist report
            shows your dah-to-dit ratio and how consistent your timing is. No hardware yet? Use the keyboard or
            the on-screen key.
          </p>
        </div>
        <div>
          <h3 class="font-medium text-zinc-200">Ready for the air</h3>
          <p class="mt-1">
            Learn the Q-signals, prosigns and abbreviations real QSOs are built from, rehearse a complete first
            contact from CQ to 73 in the QSO simulator, train through simulated noise, fading and interference,
            and use the live decoder to check your copy against your own radio's audio.
          </p>
        </div>
      </div>
    </section>

    <section class="space-y-3 border-t border-zinc-800/80 pt-8">
      <h2 class="text-lg font-semibold tracking-tight">Frequently asked questions</h2>
      <dl class="divide-y divide-zinc-800/80">
        <div v-for="f in faq" :key="f.q" class="py-3">
          <dt class="text-sm font-medium text-zinc-200">{{ f.q }}</dt>
          <dd class="mt-1 text-sm leading-relaxed text-zinc-400">
            {{ f.a }}
            <a
              v-if="f.link"
              :href="f.link.href"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-1 text-emerald-400 hover:underline"
            >
              {{ f.link.label }}
              <UIcon name="i-lucide-external-link" class="size-3.5" />
            </a>
          </dd>
        </div>
      </dl>
    </section>
  </div>
</template>
