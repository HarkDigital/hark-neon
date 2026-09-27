import type { Frame } from '../core/types'
import type { EngineState } from '../core/Engine'
import { storeKey } from './prefs'

/*
 * NEON sound: the HUM of a sign shop after hours (WebAudio only, no files).
 *
 *   hum      the transformers: 60 Hz mains with its gentle harmonics (120,
 *            180, 240, 300), low-passed, breathing very slowly — very quiet;
 *            the harmonics are what a laptop speaker actually plays
 *   buzz     the tubes themselves: a soft 120 Hz ballast buzz, band-passed
 *            high and thin, wavering; now and then a faint electrode crackle
 *            (Short Circuit crackles most)
 *   pad      a slow warm night pad: four extended chords (Dbmaj9 → Bbm9 →
 *            Gbmaj7 → Ab add9), detuned saw + triangle voices under a dark
 *            low-pass that opens and closes, long swells, a generated room
 *   per chapter (update): the mix shifts slowly (Short Circuit: the buzz
 *            rises and crackles, the pad thins; The Front Door: the pad warms);
 *            a fast scroll makes the tubes buzz a little harder
 *   cut()    a ballast "tink" (an inharmonic metal ping + a relay tick) while
 *            the hum dips for the lights-out and comes back
 *   blip()   a soft switch click (nav, toggles); `pitch` shifts it a little
 *   tone()   a pure sine a chapter may ask for (also via 'hark:tone' events)
 *
 * CPU: chords and crackles are scheduled ~0.4 s ahead by a 100 ms lookahead
 * timer (never per frame); the beds are a handful of always-running nodes;
 * update() only touches gains when the chapter changes or ~8×/s for the
 * scroll buzz. Off by default. Sound only ever starts from a real gesture:
 * the toggle's own click / tap / Enter / Space. A remembered "on"
 * (localStorage, per concept) waits for the first real activation (a click
 * or tap, or Enter / Space on a control; never Tab, arrows or scrolling).
 * Faded out and suspended while the tab is hidden. On iOS the audio session
 * is set to "playback" so the silent switch doesn't swallow it. Levels stay
 * low, behind a gentle compressor.
 *
 * Keep the API: enabled, onChange, toggle(), update(), cut(), blip(), tone().
 */

const STORE_KEY = storeKey('sound')

function stored(): boolean | null {
  try {
    const v = localStorage.getItem(STORE_KEY)
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

interface Mix {
  /** transformer hum 0..~1.3 */
  hum: number
  /** tube buzz 0..~1.6 */
  buzz: number
  /** night pad 0..~1.3 */
  pad: number
  /** electrode crackles per second */
  crackle: number
  /** pad low-pass centre (Hz) */
  warmth: number
}

const MIXES: Record<string, Mix> = {
  hero: { hum: 1, buzz: 1, pad: 0.9, crackle: 0.12, warmth: 820 },
  work: { hum: 0.8, buzz: 0.85, pad: 1, crackle: 0.06, warmth: 900 },
  services: { hum: 0.9, buzz: 1.1, pad: 1, crackle: 0.1, warmth: 980 },
  voices: { hum: 0.65, buzz: 0.6, pad: 1.1, crackle: 0.04, warmth: 860 },
  shield: { hum: 1.25, buzz: 1.6, pad: 0.45, crackle: 0.9, warmth: 620 },
  process: { hum: 1, buzz: 1.2, pad: 0.9, crackle: 0.2, warmth: 900 },
  contact: { hum: 0.8, buzz: 0.7, pad: 1.25, crackle: 0.04, warmth: 1080 },
}

const ACTIVATE_KEYS = new Set(['Enter', ' ', 'Spacebar'])
const CONTROL = 'a[href], button, [role="button"], [role="switch"], summary, input, select, textarea'

/* levels (linear gain, before the master) */
const MASTER_LEVEL = 0.7
const HUM_LEVEL = 0.012
const BUZZ_LEVEL = 0.034
const PAD_LEVEL = 0.16
const CRACKLE_LEVEL = 0.018
const TINK_LEVEL = 0.03
const CLICK_LEVEL = 0.05
const TONE_MAX = 0.03

/* the pad */
const CHORD_S = 9
const ATTACK_S = 3.2
const RELEASE_S = 4
const LOOKAHEAD = 0.4
const TICK_MS = 100
/** Dbmaj9, Bbm9, Gbmaj7(9), Ab add9 — close, warm voicings around middle C */
const CHORDS: number[][] = [
  [49, 56, 60, 63, 65],
  [46, 53, 56, 60, 61],
  [42, 53, 58, 61, 65],
  [44, 51, 56, 58, 60],
]

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12)
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const rand = (a: number, b: number) => a + Math.random() * (b - a)

function setAudioSession(type: string) {
  try {
    const nav = navigator as Navigator & { audioSession?: { type: string } }
    if (nav.audioSession) nav.audioSession.type = type
  } catch {
    /* not supported */
  }
}

export class Sound {
  enabled = false
  onChange: ((enabled: boolean) => void)[] = []

  private ctx: AudioContext | null = null
  private master!: GainNode
  private room!: GainNode
  private hum!: GainNode
  private buzz!: GainNode
  private pad!: GainNode
  private padLp!: BiquadFilterNode
  private fx!: GainNode
  private white: AudioBuffer | null = null
  private toneOsc: OscillatorNode | null = null
  private toneGain: GainNode | null = null

  private chapter = 'hero'
  private slotIds: string[] = []
  private mixKey = ''
  private mix: Mix = MIXES.hero
  private timer = 0
  private nextChordAt = 0
  private chordIndex = 0
  private nextCrackle = 0
  private lastCut = -10
  private lastBlip = -10
  private lastSpeedAt = -10
  private speed = 0
  private suspendTimer = 0
  private hidden = typeof document !== 'undefined' && document.hidden
  /** a remembered "on" waiting for the first real gesture */
  private armed = false
  private gestureBound = false
  private toneHz = 440
  private toneLevel = 0

  constructor() {
    this.armed = stored() === true
    if (this.armed) this.waitForGesture()
    document.addEventListener('visibilitychange', () => {
      this.hidden = document.hidden
      this.applyRunning()
    })
    window.addEventListener('hark:tone', e => {
      const d = (e as CustomEvent<{ hz?: number; level?: number }>).detail
      if (d && typeof d.hz === 'number') this.tone(d.hz, d.level ?? 0)
    })
    // the static page took over (no GPU): silence, without touching the stored choice
    window.addEventListener('hark:fallback', () => this.setEnabled(false))
  }

  /** was sound on last visit? (it still needs a gesture to start) */
  get remembered() {
    return stored() === true
  }

  /** Flip the hum on/off. Call from a user gesture (click / key). */
  toggle() {
    this.armed = false
    this.setEnabled(!this.enabled)
    try {
      localStorage.setItem(STORE_KEY, this.enabled ? '1' : '0')
    } catch {
      /* storage blocked: the choice lasts for this visit */
    }
  }

  /** Follow the story: each chapter shifts the mix (slowly); scroll speed stirs the buzz. */
  update(frame: Frame, state: EngineState) {
    const slot = state.slots[state.index]
    if (slot) this.chapter = slot.def.id
    if (this.slotIds.length !== state.slots.length) this.slotIds = state.slots.map(s => s.def.id)
    const ctx = this.live()
    if (!ctx) return
    if (this.chapter !== this.mixKey) this.setMix(this.chapter, ctx, 1.5)
    // the tubes buzz a little harder while the shop swings past (≈ 8×/s)
    const now = ctx.currentTime
    if (now - this.lastSpeedAt > 0.12) {
      this.lastSpeedAt = now
      const s = clamp01(Math.abs(frame.velocity || 0) / 3)
      if (Math.abs(s - this.speed) > 0.04) {
        this.speed = s
        this.buzz.gain.setTargetAtTime(this.buzzTarget(), now, s > 0.1 ? 0.08 : 0.5)
      }
    }
  }

  /** A chapter cut: lights out (the hum dips), a ballast tinks, the next room strikes. */
  cut(_from: number, to: number) {
    const ctx = this.live()
    if (!ctx) return
    const now = ctx.currentTime
    const toId = this.slotIds[to]
    if (now - this.lastCut < 0.4) {
      // a fast run of cuts: no more tinks, just follow the mix
      if (toId && toId !== this.mixKey) this.setMix(toId, ctx, 0.3)
      return
    }
    this.lastCut = now
    // the hum and buzz dip with the lights, then the next room's mix strikes up
    for (const g of [this.hum, this.buzz]) {
      g.gain.cancelScheduledValues(now)
      g.gain.setValueAtTime(g.gain.value, now)
      g.gain.setTargetAtTime(g.gain.value * 0.25, now, 0.03)
    }
    this.setMix(toId ?? this.mixKey, ctx, 0.22, now + 0.16)
    // the ballast: a relay tick, then a small inharmonic metal ping
    this.tick(ctx, now + 0.01, 1900, 3, CLICK_LEVEL * 0.5, 0.012)
    const base = rand(2950, 3250)
    for (const [ratio, amp, len] of [
      [1, 1, 0.42],
      [1.51, 0.55, 0.3],
      [2.33, 0.3, 0.2],
    ] as const) {
      const o = ctx.createOscillator()
      o.type = 'sine'
      o.frequency.value = base * ratio
      const g = ctx.createGain()
      const t = now + 0.03
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(TINK_LEVEL * amp, t + 0.003)
      g.gain.exponentialRampToValueAtTime(0.0001, t + len)
      o.connect(g).connect(this.fx)
      o.start(t)
      o.stop(t + len + 0.02)
    }
  }

  /** A soft switch click (nav, buttons). `pitch` shifts it a little. No-op while off. */
  blip(pitch = 0) {
    const ctx = this.live()
    if (!ctx) return
    const now = ctx.currentTime
    if (now - this.lastBlip < 0.04) return
    this.lastBlip = now
    const p = Math.pow(2, Math.max(-6, Math.min(12, pitch)) / 24)
    this.tick(ctx, now + 0.005, 2600 * p, 2.2, CLICK_LEVEL, 0.014)
    // the rocker's body: a short low thock
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(210 * p, now + 0.005)
    o.frequency.exponentialRampToValueAtTime(120 * p, now + 0.05)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, now + 0.005)
    g.gain.exponentialRampToValueAtTime(CLICK_LEVEL * 0.6, now + 0.009)
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.07)
    o.connect(g).connect(this.fx)
    o.start(now + 0.005)
    o.stop(now + 0.08)
  }

  /** A pure sine a chapter may ask for: level 0..1 (0 releases it). */
  tone(hz: number, level: number) {
    if (Number.isFinite(hz) && hz > 20 && hz < 12000) this.toneHz = hz
    this.toneLevel = clamp01(Number.isFinite(level) ? level : 0)
    this.applyTone()
  }

  /* ------------------------------------------------------------ internals */

  private live() {
    const ctx = this.ctx
    if (!ctx || !this.enabled || this.hidden || ctx.state !== 'running') return null
    return ctx
  }

  private buzzTarget() {
    return this.mix.buzz * BUZZ_LEVEL * (1 + 0.9 * this.speed)
  }

  private setEnabled(on: boolean) {
    if (on === this.enabled) return
    this.enabled = on
    setAudioSession(on ? 'playback' : 'auto')
    if (on) {
      try {
        this.ensureGraph()
      } catch (err) {
        console.warn('[hark] audio unavailable', err)
      }
    }
    this.applyRunning(true)
    for (const fn of this.onChange) fn(on)
  }

  /** Resume + fade in, or fade out + suspend, from enabled / hidden. */
  private applyRunning(greet = false) {
    const ctx = this.ctx
    if (!ctx) return
    clearTimeout(this.suspendTimer)
    const now = ctx.currentTime
    if (this.enabled && !this.hidden) {
      ctx
        .resume()
        .then(() => {
          if (!this.enabled || this.hidden) return
          if (ctx.state !== 'running') return this.waitForGesture()
          const t = ctx.currentTime
          this.master.gain.cancelScheduledValues(t)
          this.master.gain.setValueAtTime(this.master.gain.value, t)
          this.master.gain.setTargetAtTime(MASTER_LEVEL, t, 0.5)
          this.mixKey = ''
          this.setMix(this.chapter, ctx, 0.35)
          this.applyTone()
          // never catch up on chords missed while hidden: pick the pad up from here
          if (this.nextChordAt < t) this.nextChordAt = t + 0.05
          this.nextCrackle = t + rand(0.5, 2)
          this.startClock()
          if (greet) this.blip(3)
        })
        .catch(() => this.waitForGesture())
    } else {
      this.stopClock()
      this.master.gain.cancelScheduledValues(now)
      this.master.gain.setValueAtTime(this.master.gain.value, now)
      this.master.gain.setTargetAtTime(0, now, this.hidden ? 0.05 : 0.25)
      this.suspendTimer = window.setTimeout(
        () => {
          if (!this.enabled || this.hidden) ctx.suspend().catch(() => {})
        },
        this.hidden ? 300 : 1300,
      )
    }
  }

  /** Start audio on the first real gesture (a remembered "on", or a blocked resume). */
  private waitForGesture() {
    if (this.gestureBound) return
    this.gestureBound = true
    let sx = 0
    let sy = 0
    const events = ['click', 'keydown', 'touchstart', 'touchend'] as const
    const handler = (e: Event) => {
      if (e.type === 'touchstart') {
        const t = (e as TouchEvent).touches[0]
        if (t) {
          sx = t.clientX
          sy = t.clientY
        }
        return
      }
      if (e.type === 'touchend') {
        // a tap, not a scroll or a swipe
        const t = (e as TouchEvent).changedTouches[0]
        if (!t || Math.hypot(t.clientX - sx, t.clientY - sy) > 12) return
      }
      // keyboard: only Enter / Space on a control is "play"; Tab and friends are just moving around
      if (e instanceof KeyboardEvent) {
        if (!ACTIVATE_KEYS.has(e.key) || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
        if (!(e.target as Element | null)?.closest?.(CONTROL)) return
      }
      for (const ev of events) window.removeEventListener(ev, handler, true)
      this.gestureBound = false
      const onToggle = (e.target as Element | null)?.closest?.('[data-sound-toggle]')
      if (this.armed) {
        this.armed = false
        // the toggle's own click decides for itself
        if (!onToggle) this.setEnabled(true)
      } else if (this.enabled) this.applyRunning()
    }
    for (const ev of events) window.addEventListener(ev, handler, { capture: true, passive: true })
  }

  /* ------------------------------------------------------------ the graph */

  private ensureGraph() {
    if (this.ctx) return
    const AC =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    const ctx = new AC({ latencyHint: 'playback' })
    this.ctx = ctx
    const sr = ctx.sampleRate

    // master → rumble guard → gentle compression → out
    this.master = ctx.createGain()
    this.master.gain.value = 0
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 40
    hp.Q.value = 0.5
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -24
    comp.knee.value = 18
    comp.ratio.value = 3
    comp.attack.value = 0.02
    comp.release.value = 0.5
    this.master.connect(hp).connect(comp).connect(ctx.destination)

    // the shop: a dark generated stereo room (~2.8 s), mostly for the pad
    const irLen = Math.floor(sr * 2.8)
    const ir = ctx.createBuffer(2, irLen, sr)
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c)
      let lp = 0
      for (let i = 0; i < irLen; i++) {
        const t = i / irLen
        const k = 0.5 + 0.42 * t // darker as it decays
        lp = lp * k + (Math.random() * 2 - 1) * (1 - k)
        const env = (1 - t) * (1 - t) * (1 - t)
        d[i] = lp * env * (i < sr * 0.02 ? i / (sr * 0.02) : 1) * 1.5
      }
    }
    const verb = ctx.createConvolver()
    verb.buffer = ir
    this.room = ctx.createGain()
    const wet = ctx.createGain()
    wet.gain.value = 0.8
    this.room.connect(verb).connect(wet).connect(this.master)

    const bus = (level: number, send: number) => {
      const g = ctx.createGain()
      g.gain.value = level
      g.connect(this.master)
      if (send > 0) {
        const s = ctx.createGain()
        s.gain.value = send
        g.connect(s).connect(this.room)
      }
      return g
    }

    // white noise (clicks, crackles, the relay)
    const nLen = Math.floor(sr * 2)
    this.white = ctx.createBuffer(1, nLen, sr)
    const wd = this.white.getChannelData(0)
    for (let i = 0; i < nLen; i++) wd[i] = Math.random() * 2 - 1

    // HUM: 60 Hz and its harmonics, low-passed, breathing on a slow LFO
    this.hum = bus(0, 0.05)
    const humLp = ctx.createBiquadFilter()
    humLp.type = 'lowpass'
    humLp.frequency.value = 420
    humLp.Q.value = 0.4
    const humAmp = ctx.createGain()
    humAmp.gain.value = 1
    humLp.connect(humAmp).connect(this.hum)
    for (const [h, a] of [
      [1, 1],
      [2, 0.75],
      [3, 0.45],
      [4, 0.3],
      [5, 0.15],
    ] as const) {
      const o = ctx.createOscillator()
      o.type = 'sine'
      o.frequency.value = 60 * h
      // a hair of drift so it beats, like a real core
      o.detune.value = rand(-3, 3)
      const g = ctx.createGain()
      g.gain.value = a
      o.connect(g).connect(humLp)
      o.start()
    }
    const breathe = ctx.createOscillator()
    breathe.frequency.value = 0.11
    const breatheAmt = ctx.createGain()
    breatheAmt.gain.value = 0.18
    breathe.connect(breatheAmt).connect(humAmp.gain)
    breathe.start()

    // BUZZ: the ballast's 120 Hz sawtooth, heard only high and thin, wavering
    this.buzz = bus(0, 0.08)
    const saw = ctx.createOscillator()
    saw.type = 'sawtooth'
    saw.frequency.value = 120
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 2600
    bp.Q.value = 1.1
    const bp2 = ctx.createBiquadFilter()
    bp2.type = 'lowpass'
    bp2.frequency.value = 5200
    const waver = ctx.createGain()
    waver.gain.value = 1
    saw.connect(bp).connect(bp2).connect(waver).connect(this.buzz)
    saw.start()
    for (const [hz, amt] of [
      [0.23, 0.25],
      [1.7, 0.12],
    ] as const) {
      const l = ctx.createOscillator()
      l.frequency.value = hz
      const a = ctx.createGain()
      a.gain.value = amt
      l.connect(a).connect(waver.gain)
      l.start()
    }

    // PAD: one bus, one slow-breathing low-pass (the chords feed it)
    this.padLp = ctx.createBiquadFilter()
    this.padLp.type = 'lowpass'
    this.padLp.frequency.value = this.mix.warmth
    this.padLp.Q.value = 0.6
    const sweep = ctx.createOscillator()
    sweep.frequency.value = 0.045
    const sweepAmt = ctx.createGain()
    sweepAmt.gain.value = 260
    sweep.connect(sweepAmt).connect(this.padLp.frequency)
    sweep.start()
    this.pad = bus(0, 0.55)
    this.padLp.connect(this.pad)

    // clicks, crackles and the tink go straight out (a little room)
    this.fx = bus(1, 0.12)

    // a pure tone a chapter may ask for
    this.toneOsc = ctx.createOscillator()
    this.toneOsc.type = 'sine'
    this.toneOsc.frequency.value = this.toneHz
    this.toneGain = ctx.createGain()
    this.toneGain.gain.value = 0
    this.toneOsc.connect(this.toneGain).connect(this.master)
    this.toneOsc.start()
  }

  private setMix(id: string, ctx: AudioContext, tc: number, at = ctx.currentTime) {
    const m = MIXES[id] ?? MIXES.hero
    this.mixKey = id
    this.mix = m
    const now = at
    this.hum.gain.setTargetAtTime(m.hum * HUM_LEVEL, now, tc)
    this.buzz.gain.setTargetAtTime(this.buzzTarget(), now, tc)
    this.pad.gain.setTargetAtTime(m.pad * PAD_LEVEL, now, tc * 1.4)
    this.padLp.frequency.setTargetAtTime(m.warmth, now, tc * 1.6)
  }

  /* ------------------------------------------------------------ the clock */

  private startClock() {
    if (this.timer) return
    this.timer = window.setInterval(() => this.schedule(), TICK_MS)
    this.schedule()
  }

  private stopClock() {
    clearInterval(this.timer)
    this.timer = 0
  }

  /** everything due in the next LOOKAHEAD seconds, scheduled on the audio clock */
  private schedule() {
    const ctx = this.live()
    if (!ctx) return
    const now = ctx.currentTime
    const horizon = now + LOOKAHEAD
    // a stalled timer (a long task) must not dump a backlog at once
    if (this.nextChordAt < now - 0.5) this.nextChordAt = now + 0.05
    while (this.nextChordAt < horizon) {
      this.chord(ctx, this.nextChordAt, CHORDS[this.chordIndex])
      this.chordIndex = (this.chordIndex + 1) % CHORDS.length
      this.nextChordAt += CHORD_S
    }
    // electrode crackles: a sparse random patter
    const rate = this.mix.crackle
    if (rate > 0.01) {
      if (this.nextCrackle < now - 0.3) this.nextCrackle = now + 0.05
      while (this.nextCrackle < horizon) {
        this.crackle(ctx, this.nextCrackle)
        this.nextCrackle += -Math.log(1 - Math.random() * 0.98) / rate
      }
    }
  }

  /* ------------------------------------------------------------ voices */

  /** one chord: a long swell and release, two detuned voices per note */
  private chord(ctx: AudioContext, t: number, notes: number[]) {
    const len = CHORD_S + RELEASE_S
    const env = ctx.createGain()
    env.gain.setValueAtTime(0, t)
    env.gain.linearRampToValueAtTime(1, t + ATTACK_S)
    env.gain.setValueAtTime(1, t + CHORD_S - 0.4)
    env.gain.linearRampToValueAtTime(0, t + len)
    env.connect(this.padLp)
    const oscs: OscillatorNode[] = []
    notes.forEach((m, i) => {
      const f = mtof(m)
      // the bass note a little louder, the top a little softer
      const lvl = (i === 0 ? 0.26 : 0.18) * (i === notes.length - 1 ? 0.8 : 1)
      for (const [type, det, a] of [
        ['sawtooth', -7, 0.5],
        ['triangle', 6, 1],
      ] as const) {
        const o = ctx.createOscillator()
        o.type = type
        o.frequency.value = f
        o.detune.value = det + rand(-2, 2)
        const g = ctx.createGain()
        g.gain.value = lvl * a
        o.connect(g).connect(env)
        oscs.push(o)
      }
    })
    for (const o of oscs) {
      o.start(t)
      o.stop(t + len + 0.05)
    }
  }

  /** a faint electrode crackle: two or three tiny ticks close together */
  private crackle(ctx: AudioContext, t: number) {
    const n = 1 + Math.floor(Math.random() * 3)
    let at = t
    for (let i = 0; i < n; i++) {
      this.tick(ctx, at, rand(3000, 6500), 4, CRACKLE_LEVEL * rand(0.4, 1), rand(0.004, 0.012), rand(-0.6, 0.6))
      at += rand(0.012, 0.05)
    }
  }

  /** a short band-passed noise tick */
  private tick(ctx: AudioContext, t: number, f: number, q: number, level: number, len: number, pan = 0) {
    if (!this.white) return
    const src = ctx.createBufferSource()
    src.buffer = this.white
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = f
    bp.Q.value = q
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), t + 0.0015)
    g.gain.exponentialRampToValueAtTime(0.0001, t + len)
    src.connect(bp).connect(g)
    let tail: AudioNode = g
    if (pan && typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner()
      p.pan.value = pan
      tail = g.connect(p)
    }
    tail.connect(this.fx)
    src.start(t, Math.random() * (this.white.duration - 0.2))
    src.stop(t + len + 0.02)
  }

  private applyTone() {
    const ctx = this.ctx
    if (!ctx || !this.toneOsc || !this.toneGain) return
    const now = ctx.currentTime
    this.toneOsc.frequency.setTargetAtTime(this.toneHz, now, 0.08)
    this.toneGain.gain.setTargetAtTime(this.toneLevel * TONE_MAX, now, 0.12)
  }
}
