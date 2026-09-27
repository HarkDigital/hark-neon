import { holdInert, releaseInert } from './inert'
import { MICROCOPY } from '../content'
import { storeKey } from './prefs'

/*
 * Phone-landscape suggestion, as a small NEON SIGN CARD: a black acrylic
 * panel framed by a lit pink tube, a phone bent in white tube (an argon
 * glow) that turns upright ONCE (never a loop; still under reduced motion /
 * Motion off), "Turn your phone upright" in Tilt Neon ("upright" is the pink
 * tube word), "This shop is laid out for portrait." and "Continue anyway".
 * The scene is paused underneath (createChrome wires onChange to the scene
 * hold). Tablets and laptops in landscape are taller than 500px and never
 * see it.
 *
 * It is a suggestion, never a lock (WCAG 1.3.4): "Continue anyway" releases
 * it for the rest of the session. While it shows, the skip link and the
 * linear copy layer in #track stay reachable, and their focus pills paint
 * above the card (it sits at z 25: over the chrome (10) and the stages (5),
 * under #track:focus-within (30) and the skip link (120)); only the chrome
 * and the stages behind it are inert.
 *
 * API: mountRotateGate(onChange?) / unmountRotateGate(). Safe to call more
 * than once: later calls just add their onChange listener.
 */

export const ROTATE_QUERY = '(orientation: landscape) and (max-height: 500px) and (pointer: coarse)'

const DISMISS_KEY = storeKey('rotate-ok')
const wasDismissed = () => {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}
const rememberDismissed = () => {
  try {
    sessionStorage.setItem(DISMISS_KEY, '1')
  } catch {
    /* blocked storage: the choice lasts until reload */
  }
}

// a phone bent in tube (lying on its side, it turns upright once) and a quarter-turn arrow
const PHONE = `<svg class="rot-phone" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
  <g class="rot-phone-g">
    <rect class="rot-body" x="21" y="8" width="22" height="48" rx="4.5"/>
    <path class="rot-speaker" d="M29.5 13.5h5"/>
  </g>
  <path class="rot-arc" d="M9 45a25 25 0 0 1 2.6-26.5"/>
  <path class="rot-arc-h" d="M7.6 21.4l4-3.2 2.8 4.1"/>
</svg>`

let gate: {
  el: HTMLElement
  mq: MediaQueryList
  sync: () => void
  listeners: ((shown: boolean) => void)[]
  on: () => boolean
} | null = null

export function mountRotateGate(onChange?: (shown: boolean) => void) {
  if (gate) {
    if (onChange) {
      gate.listeners.push(onChange)
      onChange(gate.on())
    }
    return
  }
  if (typeof matchMedia === 'undefined') return
  let dismissed = wasDismissed()
  const el = document.createElement('div')
  el.className = 'rot'
  // non-modal: the copy layer behind it stays in reach
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-labelledby', 'rot-title')
  el.setAttribute('aria-describedby', 'rot-sub')
  el.tabIndex = -1
  el.innerHTML = `
    <div class="rot-card">
      <div class="rot-art" aria-hidden="true">${PHONE}</div>
      <div class="rot-text">
        <p class="rot-k" aria-hidden="true"><i class="ch-tube" aria-hidden="true"></i>${MICROCOPY.signalEyebrow}</p>
        <h2 class="rot-title" id="rot-title">Turn your phone <em>upright</em></h2>
        <p class="rot-sub" id="rot-sub">This shop is laid out for portrait.</p>
        <p class="rot-actions"><button class="hud-btn hud-btn--ghost rot-go" type="button">Continue anyway</button></p>
      </div>
    </div>
    <p class="sr-only" aria-live="assertive" data-rot-live></p>`
  // right after the skip link: Tab goes skip link → this card → the page
  const skip = document.querySelector('.skip-link')
  if (skip && skip.parentNode === document.body) skip.after(el)
  else document.body.prepend(el)

  const live = el.querySelector<HTMLElement>('[data-rot-live]')!
  const go = el.querySelector<HTMLButtonElement>('.rot-go')!
  const mq = matchMedia(ROTATE_QUERY)
  const listeners: ((shown: boolean) => void)[] = onChange ? [onChange] : []
  let on = false
  let turnTimer = 0
  const sync = () => {
    const want = mq.matches && !dismissed
    if (want === on) return
    on = want
    el.classList.toggle('is-on', on)
    document.documentElement.classList.toggle('is-rotate', on)
    clearTimeout(turnTimer)
    if (on) {
      // only the layers the card hides; the skip link and #track stay reachable
      holdInert('rotate', ['chrome', 'stages'].map(id => document.getElementById(id)))
      // focus stranded in a now-inert layer (or on <body>) comes to the card;
      // a reader already in the copy layer or on the skip link stays put
      const a = document.activeElement
      const keep = a instanceof HTMLElement && a !== document.body && (a.closest('#track') || a.matches('.skip-link'))
      if (!keep) el.focus({ preventScroll: true })
      // the phone turns upright once, after the card is on screen
      el.classList.remove('is-turned')
      void el.offsetWidth
      turnTimer = window.setTimeout(() => on && el.classList.add('is-turned'), 420)
      // a live region only speaks when its text changes after it is shown
      window.setTimeout(() => {
        if (on) live.textContent = 'Turn your phone upright. This shop is laid out for portrait.'
      }, 60)
    } else {
      releaseInert('rotate')
      live.textContent = ''
    }
    for (const fn of listeners) fn(on)
  }

  go.addEventListener('click', () => {
    const hadFocus = el.contains(document.activeElement)
    dismissed = true
    rememberDismissed()
    sync()
    if (!hadFocus) return
    // the card is gone: hand focus to the story, like the skip link does
    const main = document.getElementById('track')
    if (main && !main.closest('[inert], [aria-hidden="true"]')) main.focus({ preventScroll: true })
    else (document.activeElement as HTMLElement | null)?.blur?.()
  })

  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', sync)
  else mq.addListener?.(sync)
  gate = { el, mq, sync, listeners, on: () => on }
  sync()
}

/** The plain HTML page reads fine in any orientation. */
export function unmountRotateGate() {
  if (!gate) return
  const was = gate.on()
  if (typeof gate.mq.removeEventListener === 'function') gate.mq.removeEventListener('change', gate.sync)
  else gate.mq.removeListener?.(gate.sync)
  gate.el.remove()
  document.documentElement.classList.remove('is-rotate')
  releaseInert('rotate')
  if (was) for (const fn of gate.listeners) fn(false)
  gate = null
}
