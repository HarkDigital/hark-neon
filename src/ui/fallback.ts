import { BRAND, CONTACT, MICROCOPY, STATS } from '../content'
import { CHAPTER_COPY_IDS, buildChapterCopy } from '../core/srContent'
import { CHAPTERS } from '../chapters/index'
import { CONCEPT_TAG, WORDMARK, markSvg } from './mark'
import { unmountRotateGate } from './rotate'
import { releaseInert } from './inert'
import { releaseScene } from './prefs'

/*
 * The plain HTML version, for browsers without WebGL2 (and the last resort
 * if boot fails or the GPU context is gone for good): every chapter's copy,
 * in story order, visible — set as the sign shop's MENU BOARD. A black
 * page, headings bent in Tilt Neon (white-hot letters, a pink or argon glow),
 * Outfit for the words, Azeret Mono for the small print; each chapter is one
 * board, numbered like a shop ticket ("No. 03 · Tube Chart"), the services
 * read like a menu (a dotted leader to a lit tube end), the quotes hang in
 * the window, the figures are lit numbers. The board numbers, leaders and
 * tubes are decorative (aria-hidden spans / CSS); the copy is the live
 * site's, verbatim, from srContent (buildChapterCopy). Links stay underlined.
 * No animation, no flicker: nothing here moves. Landmarks: the header
 * (banner, with the Primary nav) and the footer (contentinfo) sit beside
 * <main> (#track), which holds only the boards.
 */
export function renderFallback(root: HTMLElement) {
  document.documentElement.classList.add('no-webgl')
  document.documentElement.classList.remove('is-rotate', 'motion-off')
  unmountRotateGate()
  // boot can fail while the loader or the menu still holds the page inert: let go
  releaseInert('loader')
  releaseInert('menu')
  releaseScene('menu')
  document.getElementById('loader')?.remove()
  document.getElementById('gl')?.remove()
  // the live chrome drives a story that is no longer there
  document.getElementById('chrome')?.replaceChildren()
  window.dispatchEvent(new Event('hark:fallback'))
  root.style.pointerEvents = 'auto'
  root.inert = false
  root.removeAttribute('aria-hidden')

  // landmarks: the header (banner) and footer (contentinfo) are <body>'s own
  // children, around <main> (#track), which holds only the boards
  document.querySelectorAll('body > .fb-top, body > .fb-foot').forEach(n => n.remove())
  const header = document.createElement('header')
  header.className = 'fb-top fb-band'
  header.innerHTML = `
    <a class="fb-brand" href="#hero" aria-label="${BRAND.name}, top of the page">
      <span class="fb-mark" aria-hidden="true">${markSvg('fb-mark-svg')}</span>
      <span class="fb-brand-text" aria-hidden="true">${WORDMARK}${CONCEPT_TAG}</span>
    </a>
    <nav class="fb-nav" aria-label="Primary">
      <a href="#work">Work</a>
      <a href="#services">Services</a>
      <a href="#contact">Contact</a>
      <a class="fb-cta" href="${CONTACT.href}">Start a project</a>
    </nav>`
  const footer = document.createElement('footer')
  footer.className = 'fb-foot fb-band'
  // the sign over the door is decoration (lights on in the shop), never a claim about hours
  footer.innerHTML = `
    <p class="fb-open" aria-hidden="true"><span>Lights</span> <em>on</em></p>
    <p class="fb-credit">${MICROCOPY.signalEyebrow}</p>`
  root.before(header)
  root.after(footer)
  root.innerHTML = `<div class="fb fb-band"><div class="fb-main" id="fb-main" tabindex="-1"></div></div>`

  // a fresh skip link: the live one's handler focuses a chapter heading that is gone
  const skip = document.querySelector<HTMLAnchorElement>('.skip-link')
  if (skip) {
    const fresh = skip.cloneNode(true) as HTMLAnchorElement
    fresh.href = '#fb-main'
    skip.replaceWith(fresh)
  }

  const main = root.querySelector<HTMLElement>('#fb-main')!
  // story order (the chapters' order), then any copy the story doesn't use
  const order = CHAPTERS.map(c => c.id).filter(id => CHAPTER_COPY_IDS.includes(id))
  for (const id of CHAPTER_COPY_IDS) if (!order.includes(id)) order.push(id)
  order.forEach((id, i) => {
    const copy = buildChapterCopy(id, true)
    if (!copy) return
    // heading Tab stops only drive the live story
    copy.querySelectorAll('h1[tabindex], h2[tabindex]').forEach(h => h.removeAttribute('tabindex'))
    // item "stops" only steer the live story; here they're just text
    copy.querySelectorAll<HTMLAnchorElement>('a[data-anchor][href^="#"]:not([data-land])').forEach(a => {
      const span = document.createElement('span')
      span.textContent = a.textContent
      a.replaceWith(span)
    })
    markStats(copy)
    // the menu board's leaders: a dotted run to a lit tube end after each item
    // name; numbered lists get their board number (the <ol> already says it)
    copy.querySelectorAll('li > h3').forEach(h => {
      const li = h.parentElement!
      if (li.parentElement?.tagName === 'OL') {
        const n = document.createElement('span')
        n.className = 'fb-n'
        n.setAttribute('aria-hidden', 'true')
        n.textContent = String([...li.parentElement.children].indexOf(li) + 1).padStart(2, '0')
        h.prepend(n)
      }
      const lead = document.createElement('span')
      lead.className = 'fb-lead'
      lead.setAttribute('aria-hidden', 'true')
      h.appendChild(lead)
    })
    const sec = document.createElement('section')
    sec.className = `fb-section fb-section--${id}`
    sec.id = id
    const heading = copy.querySelector<HTMLElement>('h1, h2')
    if (heading) {
      heading.id = `fb-${id}-title`
      sec.setAttribute('aria-labelledby', heading.id)
    }
    // the board's ticket number (decorative): "No. 03 · Tube Chart"
    const label = CHAPTERS.find(c => c.id === id)?.label
    const no = document.createElement('p')
    no.className = 'fb-no'
    no.setAttribute('aria-hidden', 'true')
    no.innerHTML = `<i></i>No. ${String(i + 1).padStart(2, '0')}${label ? ` · ${label}` : ''}`
    sec.appendChild(no)
    sec.appendChild(copy)
    main.appendChild(sec)
  })
  window.scrollTo(0, 0)
}

/**
 * The figures (10 years, $1M+, 15, 24/7) are lit numbers on the board: each
 * one set in a <strong> the CSS lights. Only the markup changes; the words
 * stay the live copy's.
 */
function markStats(copy: HTMLElement) {
  for (const n of copy.querySelectorAll<HTMLElement>('p, li')) {
    const text = n.textContent ?? ''
    const stat = STATS.find(s => text.startsWith(`${s.value}:`))
    if (!stat) continue
    n.classList.add('fb-stat')
    const head = n.firstChild
    const fig = document.createElement('strong')
    fig.textContent = stat.value
    if (head instanceof HTMLElement && head.textContent === stat.value) head.replaceWith(fig)
    else if (head?.nodeType === Node.TEXT_NODE) {
      head.textContent = (head.textContent ?? '').slice(stat.value.length)
      n.insertBefore(fig, head)
    } else continue
    // the figure sits on its own line: drop the ": " that joined it to its label
    const rest = fig.nextSibling
    if (rest?.nodeType === Node.TEXT_NODE) rest.textContent = (rest.textContent ?? '').replace(/^\s*:\s*/, '')
  }
}
