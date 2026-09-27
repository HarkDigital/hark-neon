import { holdInert, releaseInert } from './inert'
import { BRAND, SITE } from '../content'
import { MARK_PATHS, MARK_VIEWBOX } from './mark'
import { calmUi } from './prefs'

/*
 * The boot screen — NEON: the sign WARMING UP. On black, the Hark mark is
 * bent as white tube outlines: first the unlit glass (a faint grey line),
 * then the light runs along the tube as the site loads (stroke dashes drawn
 * by progress: loop, loop, diamond). Under it the transformer hum, a faint
 * thin pink line that wavers while the load runs and steadies to a straight
 * glow as it lands. "Warming up · 045%" in Azeret Mono ("Open late" once lit).
 *
 * Exit: the sign STRIKES once (one short dip, then full brightness) and the
 * loader fades out quickly. One flicker at most, a small outline on black
 * (well under the WCAG 2.3.1 area threshold); none under reduced motion /
 * Motion off (a plain fade).
 *
 * The drawing never outruns time: it takes at least MIN_MS even on a warm
 * cache, so the sign always visibly draws itself.
 *
 * API used by main.ts: createLoader(root, { skip }) → { progress(0..1), finish() }.
 * Rules: shows at least ~1.2s, never hangs (finish() always resolves; every
 * wait is a bounded timer, never a rAF), the page behind is inert while it's
 * up, skip removes it at once (?nointro).
 */
const MIN_MS = 1200
/** the draw eases toward its target on this ticker (a timer: it runs in hidden tabs too) */
const TICK_MS = 33
/** longest we wait for the last of the tube to fill after the load lands */
const FILL_MAX_MS = 420
/** lit, a beat before the strike */
const HOLD_MS = 140
const STRIKE_MS = 170
const FADE_MS = 360
const FADE_CALM_MS = 320
/** the hum line: a sine over this width (px in its viewBox) */
const HUM_W = 240
const HUM_PERIOD = 20

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, Math.max(0, ms)))

/** a sine polyline, two widths long (so it can slide by one period seamlessly) */
function humPath(amp: number) {
  const pts: string[] = []
  for (let x = 0; x <= HUM_W + HUM_PERIOD; x += 2) {
    const y = 10 + amp * Math.sin((x / HUM_PERIOD) * Math.PI * 2)
    pts.push(`${x.toFixed(0)},${y.toFixed(2)}`)
  }
  return `M${pts.join('L')}`
}

export function createLoader(root: HTMLElement, { skip = false } = {}) {
  const start = performance.now()
  let target = 0
  let shown = 0
  let shownPct = -1
  let ticker = 0
  let lens: number[] = []
  let totalLen = 0
  let lit: SVGPathElement[] = []
  let humEl: SVGPathElement | null = null
  let lastAmp = -1
  const calm = !skip && calmUi()

  if (skip) root.remove()
  else {
    const paths = [...MARK_PATHS.loops, MARK_PATHS.diamond].filter(Boolean)
    root.innerHTML = `
      <div class="ld${calm ? ' is-calm' : ''}">
        <p class="sr-only" role="status">Loading ${BRAND.name}, ${SITE.name} concept</p>
        <div class="ld-stage" aria-hidden="true">
          <div class="ld-sign">
            <svg class="ld-svg" viewBox="${MARK_VIEWBOX}" focusable="false">
              <g class="ld-glass">${paths.map(d => `<path d="${d}"/>`).join('')}</g>
              <g class="ld-lit">${paths.map(d => `<path d="${d}"/>`).join('')}</g>
            </svg>
          </div>
          <svg class="ld-hum" viewBox="0 0 ${HUM_W} 20" preserveAspectRatio="none" focusable="false">
            <path class="ld-hum-glass" d="M0,10H${HUM_W}"/>
            <path class="ld-hum-wave" d="${humPath(4)}"/>
          </svg>
          <p class="ld-read"><span>Warming up</span><i>·</i><b><span data-pct>000</span>%</b></p>
        </div>
      </div>`
    holdInert('loader', [document.getElementById('track'), document.getElementById('stages'), document.getElementById('chrome')])

    lit = [...root.querySelectorAll<SVGPathElement>('.ld-lit path')]
    humEl = root.querySelector<SVGPathElement>('.ld-hum-wave')
    try {
      lens = lit.map(p => p.getTotalLength())
    } catch {
      lens = lit.map(() => 1)
    }
    if (!lens.every(l => Number.isFinite(l) && l > 0)) lens = lit.map(() => 1)
    totalLen = lens.reduce((a, b) => a + b, 0)
    lit.forEach((p, i) => {
      // a hair over the length, so round caps never show a dot at 0
      p.style.strokeDasharray = `${lens[i] + 2} ${lens[i] + 2}`
      p.style.strokeDashoffset = String(lens[i] + 2)
    })
    ticker = window.setInterval(tick, TICK_MS)
  }
  const pct = root.querySelector<HTMLElement>('[data-pct]')

  /** paint the tube: the light has run `v` (0..1) of the way along loop, loop, diamond */
  function paint(v: number) {
    let run = v * totalLen
    lit.forEach((p, i) => {
      const len = lens[i]
      const on = Math.max(0, Math.min(len, run))
      run -= len
      p.style.strokeDashoffset = String(len + 2 - on)
    })
    const n = Math.round(v * 100)
    if (pct && n !== shownPct) {
      shownPct = n
      pct.textContent = String(n).padStart(3, '0')
    }
    // the hum steadies as the load lands (the path only changes when it must)
    if (humEl) {
      const amp = Math.round((1 - v) * (calm ? 2 : 4) * 10) / 10
      if (amp !== lastAmp) {
        lastAmp = amp
        humEl.setAttribute('d', humPath(amp))
      }
    }
  }

  function tick() {
    // never ahead of the real load, never faster than MIN_MS end to end
    const time = Math.min(1, (performance.now() - start) / MIN_MS)
    const goal = Math.min(target, time)
    const next = shown + (goal - shown) * 0.28
    shown = goal - next < 0.002 ? goal : next
    paint(shown)
  }

  return {
    progress(p: number) {
      const v = Math.max(0, Math.min(1, Number.isFinite(p) ? p : 0))
      if (v > target) target = v
    },
    async finish(): Promise<void> {
      if (skip) return
      const signal = root.querySelector<HTMLElement>('.ld-sign')
      const ld = root.querySelector<HTMLElement>('.ld')
      try {
        await wait(MIN_MS - (performance.now() - start))
        target = 1
        // let the light finish its run along the tube (bounded)
        const t0 = performance.now()
        while (shown < 0.999 && performance.now() - t0 < FILL_MAX_MS) await wait(TICK_MS)
        clearInterval(ticker)
        shown = 1
        paint(1)
        ld?.classList.add('is-lit')
        // the sign is lit: the shop's open
        const read = root.querySelector('.ld-read')
        if (read) read.innerHTML = '<span>Open</span><i>·</i><b>late</b>'
        await wait(HOLD_MS)
        const still = calmUi()
        // the strike: one short dip, then full brightness (calm: none)
        if (!still && signal && typeof signal.animate === 'function') {
          try {
            signal.animate(
              [
                { opacity: 1, offset: 0 },
                { opacity: 0.28, offset: 0.25 },
                { opacity: 0.9, offset: 0.55 },
                { opacity: 1, offset: 1 },
              ],
              { duration: STRIKE_MS, easing: 'linear' },
            )
          } catch {
            /* no WAAPI: skip the strike */
          }
          ld?.classList.add('is-struck')
          await wait(STRIKE_MS)
        }
        // the page wakes as the loader fades, so the first Tab lands in it
        releaseInert('loader')
        const ms = still ? FADE_CALM_MS : FADE_MS
        // WAAPI, not a CSS transition: reduced-motion CSS zeroes transitions,
        // and a fade is not motion
        try {
          root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: 'ease-in', fill: 'forwards' })
        } catch {
          root.style.opacity = '0'
        }
        await wait(ms)
      } catch {
        /* never hold the page hostage */
      } finally {
        clearInterval(ticker)
        releaseInert('loader')
        root.remove()
      }
    },
  }
}
