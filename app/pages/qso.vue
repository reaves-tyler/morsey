<script setup lang="ts">
import { buildQso, type QsoScript } from '~/utils/qso'
import { wordPattern } from '~/utils/morse'

/**
 * Guided first-contact simulator. Follows the standard beginner QSO
 * structure: copy a CQ call, answer it, copy the RST/name/QTH exchange,
 * send your half, and copy the 73 sign-off.
 */

const { progress, addXp } = useProgress()
const audio = useMorseAudio()
const keyer = useKeyer()

type Phase = 'setup' | 'active' | 'done'
const phase = ref<Phase>('setup')
const receiveOnly = ref(false)

const qso = ref<QsoScript | null>(null)
const stepIdx = ref(0)
const step = computed(() => qso.value?.steps[stepIdx.value] ?? null)
const totalSteps = computed(() => qso.value?.steps.length ?? 0)

type ListenState = 'playing' | 'answer' | 'checked'
const listenState = ref<ListenState>('playing')
const inputs = ref<Record<string, string>>({})
const fieldOk = ref<Record<string, boolean>>({})
const sendDone = ref(false)

const fieldsCorrect = ref(0)
const fieldsTotal = ref(0)
const sendsDone = ref(0)
const sendsTotal = ref(0)
const xpEarned = ref(0)

let advanceTimer: ReturnType<typeof setTimeout> | null = null

const norm = (s: string) => s.trim().toUpperCase().replace(/\s+/g, ' ')

function award(amount: number) {
  addXp(amount)
  xpEarned.value += amount
}

function startQso() {
  qso.value = buildQso(progress.value.settings.myCall, progress.value.settings.myName)
  stepIdx.value = 0
  fieldsCorrect.value = 0
  fieldsTotal.value = 0
  sendsDone.value = 0
  sendsTotal.value = qso.value.steps.filter(s => s.type === 'send').length
  xpEarned.value = 0
  phase.value = 'active'
  enterStep()
}

async function enterStep() {
  if (advanceTimer) clearTimeout(advanceTimer)
  const s = step.value
  if (!s) return
  sendDone.value = false
  inputs.value = {}
  fieldOk.value = {}
  keyer.clear()
  if (s.type === 'listen') {
    listenState.value = 'playing'
    await audio.playText(s.text)
    if (listenState.value === 'playing') {
      listenState.value = s.fields ? 'answer' : 'checked'
    }
  }
}

async function replay() {
  const s = step.value
  if (!s || s.type !== 'listen') return
  const back = listenState.value
  listenState.value = 'playing'
  await audio.playText(s.text)
  if (listenState.value === 'playing') listenState.value = back === 'playing' ? 'answer' : back
}

function checkFields() {
  const s = step.value
  if (!s?.fields) return
  for (const f of s.fields) {
    const ok = norm(inputs.value[f.key] ?? '') === f.answer
    fieldOk.value[f.key] = ok
    fieldsTotal.value++
    if (ok) {
      fieldsCorrect.value++
      award(20)
    }
  }
  listenState.value = 'checked'
}

function nextStep() {
  audio.stop()
  if (stepIdx.value + 1 >= totalSteps.value) {
    award(100) // QSO complete
    phase.value = 'done'
    return
  }
  stepIdx.value++
  enterStep()
}

function completeSend() {
  if (sendDone.value) return
  sendDone.value = true
  sendsDone.value++
  if (!receiveOnly.value) award(15)
  advanceTimer = setTimeout(nextStep, 900)
}

// Live validation of sent text against the target
watch(keyer.decoded, (val) => {
  const s = step.value
  if (phase.value !== 'active' || !s || s.type !== 'send' || sendDone.value || receiveOnly.value) return
  if (norm(val) === norm(s.text)) completeSend()
})

const scorePct = computed(() =>
  fieldsTotal.value === 0 ? 0 : Math.round((fieldsCorrect.value / fieldsTotal.value) * 100)
)

onMounted(() => keyer.attach())
onBeforeUnmount(() => {
  keyer.detach()
  audio.stop()
  if (advanceTimer) clearTimeout(advanceTimer)
})
</script>

<template>
  <div class="mx-auto max-w-2xl space-y-6">
    <header>
      <h1 class="text-2xl font-semibold tracking-tight">QSO Simulator</h1>
      <p class="mt-1 text-sm text-zinc-400">
        A complete first contact, start to finish: copy the CQ, answer it, exchange RST, name, and QTH, sign off with 73.
      </p>
    </header>

    <!-- SETUP -->
    <UCard v-if="phase === 'setup'">
      <div class="space-y-5">
        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label class="mb-1.5 block text-sm font-medium">Your callsign</label>
            <input
              v-model="progress.settings.myCall"
              type="text" autocomplete="off" spellcheck="false"
              class="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono uppercase tracking-widest text-zinc-100 outline-none focus:border-emerald-500"
              placeholder="N0CALL"
            >
          </div>
          <div>
            <label class="mb-1.5 block text-sm font-medium">Your name</label>
            <input
              v-model="progress.settings.myName"
              type="text" autocomplete="off" spellcheck="false"
              class="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono uppercase tracking-widest text-zinc-100 outline-none focus:border-emerald-500"
              placeholder="TYLER"
            >
          </div>
        </div>

        <label class="flex cursor-pointer items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900 p-3">
          <USwitch v-model="receiveOnly" />
          <span class="text-sm">
            <span class="font-medium">Receive-only mode</span>
            <span class="block text-zinc-500">Skip the keying — your transmissions are shown instead of sent. Good before your key arrives.</span>
          </span>
        </label>

        <div class="flex justify-end">
          <UButton color="primary" size="lg" icon="i-lucide-play" @click="startQso">
            Call CQ? No — answer one
          </UButton>
        </div>
      </div>
    </UCard>

    <!-- ACTIVE -->
    <template v-else-if="phase === 'active' && step">
      <div class="flex items-center gap-2">
        <div
          v-for="(s, i) in qso!.steps"
          :key="i"
          class="h-1.5 flex-1 rounded-full transition"
          :class="i < stepIdx ? 'bg-emerald-500' : i === stepIdx ? 'bg-emerald-500/50' : 'bg-zinc-800'"
        />
      </div>

      <UCard>
        <div class="space-y-5">
          <div class="flex items-start gap-3">
            <UIcon
              :name="step.type === 'listen' ? 'i-lucide-ear' : 'i-lucide-radio-tower'"
              class="mt-0.5 size-5 shrink-0"
              :class="step.type === 'listen' ? 'text-emerald-400' : 'text-amber-400'"
            />
            <p class="text-sm text-zinc-300">{{ step.intro }}</p>
          </div>

          <!-- LISTEN -->
          <template v-if="step.type === 'listen'">
            <div class="flex items-center justify-center gap-3 py-2">
              <UIcon
                v-if="listenState === 'playing'"
                name="i-lucide-audio-lines" class="morsey-pulse size-8 text-emerald-400"
              />
              <UButton
                variant="soft" color="neutral" size="sm" icon="i-lucide-rotate-ccw"
                :disabled="listenState === 'playing'" @click="replay"
              >
                Replay
              </UButton>
            </div>

            <div v-if="step.fields" class="grid gap-3 sm:grid-cols-3">
              <div v-for="f in step.fields" :key="f.key" :class="step.fields.length === 1 ? 'sm:col-start-2' : ''">
                <label class="mb-1 block text-xs uppercase tracking-wide text-zinc-500">{{ f.label }}</label>
                <input
                  v-model="inputs[f.key]"
                  type="text" autocomplete="off" spellcheck="false"
                  :disabled="listenState === 'checked'"
                  class="w-full rounded-lg border bg-zinc-900 px-3 py-2 text-center font-mono uppercase tracking-widest outline-none focus:border-emerald-500"
                  :class="listenState === 'checked'
                    ? (fieldOk[f.key] ? 'border-emerald-500 text-emerald-300' : 'border-rose-500 text-rose-300')
                    : 'border-zinc-700 text-zinc-100'"
                  :placeholder="f.placeholder"
                  @keydown.enter="listenState === 'answer' && checkFields()"
                >
                <p v-if="listenState === 'checked' && !fieldOk[f.key]" class="mt-1 text-center font-mono text-xs text-emerald-400">
                  {{ f.answer }}
                </p>
              </div>
            </div>

            <!-- transcript reveal -->
            <div v-if="listenState === 'checked'" class="rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-center font-mono text-sm tracking-wider text-zinc-400">
              {{ step.text }}
            </div>

            <div class="flex justify-center gap-2">
              <UButton
                v-if="step.fields && listenState === 'answer'"
                color="primary" icon="i-lucide-check" @click="checkFields"
              >
                Check copy
              </UButton>
              <UButton
                v-if="listenState === 'checked'"
                color="primary" trailing-icon="i-lucide-arrow-right" @click="nextStep"
              >
                Continue
              </UButton>
            </div>
          </template>

          <!-- SEND -->
          <template v-else>
            <div class="rounded-lg border-2 px-5 py-4 text-center font-mono text-lg tracking-wider transition"
                 :class="sendDone ? 'border-emerald-500 bg-emerald-500/10 text-emerald-300 morsey-good' : 'border-zinc-600 text-zinc-100'">
              {{ step.text }}
            </div>
            <div class="text-center font-mono text-[11px] leading-relaxed tracking-widest text-zinc-600">
              {{ wordPattern(step.text) }}
            </div>

            <template v-if="!receiveOnly">
              <div class="min-h-14 rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono tracking-wider">
                <span class="text-zinc-100">{{ keyer.decoded.value || ' ' }}</span>
                <span class="text-emerald-400">{{ keyer.currentSymbols.value }}</span>
                <span v-if="keyer.holdPreview.value" class="morsey-pulse text-amber-400">{{ keyer.holdPreview.value }}</span>
                <span v-else-if="keyer.keyed.value" class="morsey-pulse text-emerald-400">▊</span>
              </div>
              <p class="text-center text-xs text-zinc-600">
                Key it with your {{ keyer.keyType.value }} key — Backspace restarts. It completes automatically when your copy matches.
              </p>
            </template>

            <div class="flex justify-center gap-2">
              <UButton
                v-if="!receiveOnly && !sendDone"
                variant="soft" color="neutral" size="sm" icon="i-lucide-eraser"
                @click="keyer.clear()"
              >
                Clear
              </UButton>
              <UButton
                v-if="!sendDone"
                :color="receiveOnly ? 'primary' : 'neutral'"
                :variant="receiveOnly ? 'solid' : 'soft'"
                size="sm"
                :icon="receiveOnly ? 'i-lucide-arrow-right' : 'i-lucide-skip-forward'"
                @click="completeSend"
              >
                {{ receiveOnly ? 'Sent — continue' : 'Skip sending' }}
              </UButton>
              <span v-else class="text-sm text-emerald-400">Clean copy — they heard you!</span>
            </div>
          </template>
        </div>
      </UCard>
    </template>

    <!-- DONE -->
    <UCard v-else-if="phase === 'done'">
      <div class="flex flex-col items-center gap-4 py-6 text-center">
        <UIcon name="i-lucide-party-popper" class="size-10 text-emerald-400" />
        <h2 class="text-xl font-semibold">QSO complete — {{ qso!.their }} in the log!</h2>
        <p class="text-sm text-zinc-400">
          You worked <span class="font-mono text-zinc-200">{{ qso!.name }}</span> in
          <span class="font-mono text-zinc-200">{{ qso!.qth }}</span> and copied
          {{ fieldsCorrect }}/{{ fieldsTotal }} exchange fields ({{ scorePct }}%).
          <template v-if="sendsTotal > 0"> Sent {{ sendsDone }}/{{ sendsTotal }} transmissions.</template>
        </p>
        <div class="font-mono text-2xl text-emerald-400">+{{ xpEarned }} XP</div>
        <UButton color="primary" size="lg" icon="i-lucide-radio" @click="startQso">
          Work another station
        </UButton>
      </div>
    </UCard>
  </div>
</template>
