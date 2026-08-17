<script setup lang="ts">
import { KEY_TYPE_LABELS, type KeyType } from '~/composables/useProgress'

/**
 * Floating rig-control bar, styled after an HF transceiver's front panel:
 * a slim status strip of lit "pills" that pulls up into a soft-key config
 * panel (key type, paddle reverse, keyer speed, sidetone, USB bridge).
 */

const { progress } = useProgress()
const keyer = useKeyer()

const open = ref(false)
const serialError = ref('')

const s = computed(() => progress.value.settings)

const KEY_TYPES: KeyType[] = ['straight', 'bug', 'iambic-a', 'iambic-b']

const usesPaddles = computed(() => s.value.keyType !== 'straight')

const typeHint = computed(() => {
  const threshold = ` Release under ${keyer.dahThresholdMs.value} ms = dit, longer = dah${s.value.adaptiveDit ? ' (adapts to your fist)' : ''}.`
  return {
    'straight': `Tone follows the contact — you time everything. Keyboard: hold Space.${threshold}`,
    'bug': `Dit lever streams automatic dits at keyer speed; dah lever is manual.${threshold} Keyboard: [ = dits, ] = dahs.`,
    'iambic-a': 'Electronic keyer, squeeze alternates. Release stops after the element in progress. Keyboard: [ and ] (or Left/Right Ctrl).',
    'iambic-b': 'As A, plus Curtis-B memory: releasing a squeeze mid-element sends one extra opposite element. Keyboard: [ and ] (or Left/Right Ctrl).'
  }[s.value.keyType] + ' Fine-tune weight, thresholds, debounce, and decoder gaps under Settings → Keyer feel.'
})

async function connect() {
  serialError.value = ''
  const err = await keyer.connectSerial()
  if (err) serialError.value = err
}
</script>

<template>
  <div class="fixed inset-x-0 bottom-0 z-40">
    <div class="mx-auto max-w-5xl px-4">
      <!-- Expanded config panel -->
      <Transition
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="translate-y-4 opacity-0"
        enter-to-class="translate-y-0 opacity-100"
        leave-active-class="transition duration-150 ease-in"
        leave-from-class="translate-y-0 opacity-100"
        leave-to-class="translate-y-4 opacity-0"
      >
        <div
          v-if="open"
          class="rounded-t-xl border border-b-0 border-zinc-700/80 bg-zinc-900/95 p-4 shadow-2xl shadow-black/60 backdrop-blur"
        >
          <div class="grid gap-5 md:grid-cols-[auto_1fr_auto]">
            <!-- KEY TYPE soft keys -->
            <div>
              <div class="mb-2 font-mono text-[10px] uppercase tracking-widest text-zinc-500">Key type</div>
              <div class="grid grid-cols-2 gap-1.5">
                <button
                  v-for="t in KEY_TYPES"
                  :key="t"
                  class="rounded border px-3 py-2 font-mono text-xs uppercase tracking-wider transition"
                  :class="s.keyType === t
                    ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300 shadow-[0_0_10px_-2px_theme(colors.emerald.500/60%)]'
                    : 'border-zinc-700 bg-zinc-800/60 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'"
                  @click="s.keyType = t"
                >
                  {{ KEY_TYPE_LABELS[t] }}
                </button>
              </div>
              <button
                class="mt-1.5 w-full rounded border px-3 py-2 font-mono text-xs uppercase tracking-wider transition"
                :class="[
                  usesPaddles ? '' : 'cursor-not-allowed opacity-40',
                  s.paddleReverse && usesPaddles
                    ? 'border-amber-500 bg-amber-500/15 text-amber-300 shadow-[0_0_10px_-2px_theme(colors.amber.500/60%)]'
                    : 'border-zinc-700 bg-zinc-800/60 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'
                ]"
                :disabled="!usesPaddles"
                title="Swap tip/ring roles (standard is tip = dit)"
                @click="s.paddleReverse = !s.paddleReverse"
              >
                Reverse {{ s.paddleReverse && usesPaddles ? 'ON' : 'OFF' }}
              </button>
            </div>

            <!-- Sliders -->
            <div class="space-y-3">
              <div class="flex items-center gap-3">
                <span class="w-14 shrink-0 font-mono text-[10px] uppercase tracking-widest text-zinc-500">Speed</span>
                <USlider v-model="s.sendWpm" :min="8" :max="30" :step="1" size="sm" class="flex-1" />
                <span class="w-16 shrink-0 text-right font-mono text-xs text-emerald-400">{{ s.sendWpm }} WPM</span>
              </div>
              <div class="flex items-center gap-3">
                <span class="w-14 shrink-0 font-mono text-[10px] uppercase tracking-widest text-zinc-500">Tone</span>
                <USlider v-model="s.freq" :min="400" :max="1000" :step="10" size="sm" class="flex-1" />
                <span class="w-16 shrink-0 text-right font-mono text-xs text-emerald-400">{{ s.freq }} Hz</span>
              </div>
              <div class="flex items-center gap-3">
                <span class="w-14 shrink-0 font-mono text-[10px] uppercase tracking-widest text-zinc-500">Vol</span>
                <USlider v-model="s.volume" :min="0.05" :max="1" :step="0.05" size="sm" class="flex-1" />
                <span class="w-16 shrink-0 text-right font-mono text-xs text-emerald-400">{{ Math.round(s.volume * 100) }}%</span>
              </div>

              <!-- Simulated band conditions (receive playback only) -->
              <div class="border-t border-zinc-800 pt-3">
                <div class="mb-2 font-mono text-[10px] uppercase tracking-widest text-zinc-500">
                  Band conditions — train through the noise
                </div>
                <div class="space-y-3">
                  <div class="flex items-center gap-3">
                    <span class="w-14 shrink-0 font-mono text-[10px] uppercase tracking-widest text-zinc-500" title="Atmospheric static">QRN</span>
                    <USlider v-model="s.qrnLevel" :min="0" :max="1" :step="0.05" size="sm" class="flex-1" />
                    <span class="w-16 shrink-0 text-right font-mono text-xs" :class="s.qrnLevel > 0 ? 'text-amber-400' : 'text-zinc-600'">
                      {{ s.qrnLevel > 0 ? Math.round(s.qrnLevel * 100) + '%' : 'OFF' }}
                    </span>
                  </div>
                  <div class="flex items-center gap-3">
                    <span class="w-14 shrink-0 font-mono text-[10px] uppercase tracking-widest text-zinc-500" title="Signal fading">QSB</span>
                    <USlider v-model="s.qsbDepth" :min="0" :max="0.9" :step="0.05" size="sm" class="flex-1" />
                    <span class="w-16 shrink-0 text-right font-mono text-xs" :class="s.qsbDepth > 0 ? 'text-amber-400' : 'text-zinc-600'">
                      {{ s.qsbDepth > 0 ? Math.round(s.qsbDepth * 100) + '%' : 'OFF' }}
                    </span>
                  </div>
                  <div class="flex items-center gap-3">
                    <span class="w-14 shrink-0 font-mono text-[10px] uppercase tracking-widest text-zinc-500" title="Interfering station">QRM</span>
                    <button
                      class="rounded border px-3 py-1 font-mono text-[11px] uppercase tracking-wider transition"
                      :class="s.qrm
                        ? 'border-amber-500 bg-amber-500/15 text-amber-300 shadow-[0_0_10px_-2px_theme(colors.amber.500/60%)]'
                        : 'border-zinc-700 bg-zinc-800/60 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'"
                      @click="s.qrm = !s.qrm"
                    >
                      {{ s.qrm ? 'ON — off-freq station' : 'OFF' }}
                    </button>
                  </div>
                </div>
              </div>

              <p class="text-xs leading-snug text-zinc-500">{{ typeHint }}</p>
            </div>

            <!-- USB bridge -->
            <div class="flex flex-col">
              <div class="mb-2 font-mono text-[10px] uppercase tracking-widest text-zinc-500">USB bridge</div>
              <button
                class="rounded border px-4 py-2 font-mono text-xs uppercase tracking-wider transition"
                :class="keyer.serialConnected.value
                  ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300 shadow-[0_0_10px_-2px_theme(colors.emerald.500/60%)]'
                  : 'border-zinc-700 bg-zinc-800/60 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'"
                @click="keyer.serialConnected.value ? keyer.disconnectSerial() : connect()"
              >
                {{ keyer.serialConnected.value ? 'Connected ●' : 'Connect' }}
              </button>
              <p v-if="serialError" class="mt-2 max-w-44 text-xs leading-snug text-rose-400">{{ serialError }}</p>
              <p v-else class="mt-2 max-w-44 text-xs leading-snug text-zinc-600">
                Any key plugs into the Pico bridge — the bridge passes raw contacts through; this panel decides what they mean.
              </p>

              <!-- Contact test: raw LEDs, no keyer logic — reacts to every
                   input source, so it doubles as a wiring-day sanity check -->
              <div class="mt-3 border-t border-zinc-800 pt-3">
                <div class="mb-2 font-mono text-[10px] uppercase tracking-widest text-zinc-500">Contact test</div>
                <div class="flex items-center gap-4">
                  <span class="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider" :class="keyer.tipActive.value ? 'text-emerald-300' : 'text-zinc-600'">
                    <span class="size-2.5 rounded-full transition" :class="keyer.tipActive.value ? 'bg-emerald-400 shadow-[0_0_8px_theme(colors.emerald.400)]' : 'bg-zinc-700'" />
                    Tip
                  </span>
                  <span class="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider" :class="keyer.ringActive.value ? 'text-emerald-300' : 'text-zinc-600'">
                    <span class="size-2.5 rounded-full transition" :class="keyer.ringActive.value ? 'bg-emerald-400 shadow-[0_0_8px_theme(colors.emerald.400)]' : 'bg-zinc-700'" />
                    Ring
                  </span>
                </div>
                <p v-if="keyer.serialConnected.value" class="mt-2 font-mono text-[11px] text-zinc-600">
                  <span :class="keyer.bridgeReady.value ? 'text-emerald-400' : 'text-zinc-600'">
                    {{ keyer.bridgeReady.value ? 'BRIDGE READY' : 'awaiting bridge…' }}
                  </span>
                  · {{ keyer.bridgeEvents.value }} events
                </p>
              </div>
            </div>
          </div>
        </div>
      </Transition>

      <!-- Status strip -->
      <button
        class="flex w-full items-center gap-2 border border-zinc-700/80 bg-zinc-900/95 px-3 py-2 shadow-2xl shadow-black/60 backdrop-blur transition hover:bg-zinc-900"
        :class="open ? 'border-t-0 rounded-b-none' : 'rounded-t-xl'"
        :aria-expanded="open"
        title="Keyer configuration"
        @click="open = !open"
      >
        <UIcon
          :name="open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-up'"
          class="size-4 shrink-0 text-zinc-500"
        />
        <span class="mr-1 hidden font-mono text-[10px] uppercase tracking-widest text-zinc-500 sm:inline">Keyer</span>

        <span class="rounded-sm border border-emerald-500/50 bg-emerald-500/10 px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider text-emerald-300">
          {{ KEY_TYPE_LABELS[s.keyType] }}
        </span>
        <span
          v-if="s.paddleReverse && usesPaddles"
          class="rounded-sm border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider text-amber-300"
        >
          Rev
        </span>
        <span class="rounded-sm border border-zinc-700 bg-zinc-800/80 px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider text-zinc-300">
          {{ s.sendWpm }} wpm
        </span>
        <span class="hidden rounded-sm border border-zinc-700 bg-zinc-800/80 px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider text-zinc-300 sm:inline">
          {{ s.freq }} Hz
        </span>
        <span
          v-for="cond in ([['QRN', s.qrnLevel > 0], ['QSB', s.qsbDepth > 0], ['QRM', s.qrm]] as const).filter(c => c[1])"
          :key="cond[0]"
          class="rounded-sm border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider text-amber-300"
        >
          {{ cond[0] }}
        </span>
        <span
          class="rounded-sm border px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider"
          :class="keyer.serialConnected.value
            ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300'
            : 'border-zinc-800 bg-zinc-900 text-zinc-600'"
        >
          USB {{ keyer.serialConnected.value ? '●' : '○' }}
        </span>

        <span
          v-if="keyer.keyed.value"
          class="ml-auto rounded-sm border border-rose-500/60 bg-rose-500/15 px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider text-rose-300"
        >
          TX
        </span>
      </button>
    </div>
  </div>
</template>
