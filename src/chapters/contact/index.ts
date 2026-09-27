import * as THREE from 'three'
import type { CameraPose, Chapter } from '../../core/types'
import { el, rise, setRise, reveal } from '../../core/dom'
import { BRAND, CONTACT, OTHER_CONCEPTS } from '../../content'
import { clamp, ease, lerp, segment, smoothstep } from '../../core/math'
import { Striker, type NeonPart } from '../../kit/neon'
import { buildShop, DOOR } from './door'
import '../chapter.css'
import './contact.css'

/*
 * CONTACT · "Open Late" — the shop's front door at closing time, from inside.
 *
 *   0.00–0.28  walking up to the door: the room is lit; the OPEN sign strikes
 *              on (blue border, then the red letters); "Say hello." writes
 *              itself along its tube on the brick beside the door
 *   0.30–0.85  settled (landing 0.3): the copy panel — eyebrow, "Say hello.",
 *              body, the email as a lit tube, Copy email, the other concepts,
 *              Back to top, footer. Phones: panel in the bottom band, the OPEN
 *              sign above it (narrow phones step the panel in two beats)
 *   0.85–1.00  closing time: the fixtures, the wall signs and "Say hello." cut
 *              out one by one; the camera settles square on the door, where
 *              OPEN is still glowing; the sign-off (Back to top + footer)
 *
 * Everything derives from `local`; Strikers are the only time-based state.
 */
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    ta.remove()
    return ok
  }
}

// ------------------------------------------------------------------ camera framing

interface Shot {
  pos: THREE.Vector3
  tgt: THREE.Vector3
  fov: number
}
const shot = (): Shot => ({ pos: new THREE.Vector3(), tgt: new THREE.Vector3(), fov: 40 })

/**
 * Frame a world box (centre cx,cy on the wall plane z = 0, half extents hw,hh)
 * inside a screen rect (u0..u1 across, v0..v1 down, 0..1), looking square at
 * the wall. lift raises the camera (looking slightly down), side moves it
 * sideways (looking slightly across) — both small, so the fit holds.
 */
function fit(out: Shot, aspect: number, fov: number, cx: number, cy: number, hw: number, hh: number, u0: number, u1: number, v0: number, v1: number, lift = 0, side = 0) {
  const tan = Math.tan(THREE.MathUtils.degToRad(fov / 2))
  const halfH = Math.max(hh / Math.max(0.05, v1 - v0), hw / Math.max(0.05, (u1 - u0) * aspect))
  const halfW = halfH * aspect
  const d = halfH / tan
  const x0 = cx - ((u0 + u1) / 2 - 0.5) * 2 * halfW
  const y0 = cy + ((v0 + v1) / 2 - 0.5) * 2 * halfH
  out.tgt.set(x0, y0, 0)
  out.pos.set(x0 + side, y0 + lift, d)
  out.fov = fov
  return out
}

function mix(out: Shot, a: Shot, b: Shot, t: number) {
  out.pos.lerpVectors(a.pos, b.pos, t)
  out.tgt.lerpVectors(a.tgt, b.tgt, t)
  out.fov = lerp(a.fov, b.fov, t)
  return out
}

export default function create(): Chapter {
  const group = new THREE.Group()
  let shop: ReturnType<typeof buildShop>
  let root: HTMLElement
  let dock: HTMLElement
  let panel: HTMLElement
  let partA: HTMLElement
  let partB: HTMLElement
  let title: HTMLElement
  let end: HTMLElement
  let panelH = 420
  // split mode shows one part at a time: frame the sign above the taller one
  const partH = [0, 0]
  let showB = false
  let portrait = false
  let split = false
  let fresh = true

  type Lamp = { s: Striker; set: (v: number) => void; on: (local: number) => boolean; last: number; tgt: number }
  const lamps: Lamp[] = []
  const lamp = (s: Striker, set: (v: number) => void, on: (local: number) => boolean) => {
    const l = { s, set, on, last: 0, tgt: 0 }
    lamps.push(l)
    return l
  }
  const part = (p: NeonPart) => (v: number) => p.setLevel(v)

  // camera scratch
  const A = shot()
  const W = shot()
  const L = shot()
  const L2 = shot()
  const F = shot()
  const S1 = shot()
  const OUT = shot()

  return {
    id: 'contact',
    group,
    anchors: [],
    init(ctx) {
      shop = buildShop(group, ctx.mobile)

      // the shop's lights, in closing order (fixtures first, OPEN never)
      lamp(new Striker({ stutters: 1, depth: 0.45 }), v => shop.flB.setLevel(v), l => l < 0.862)
      lamp(new Striker({ stutters: 1, depth: 0.45 }), v => shop.flA.setLevel(v), l => l < 0.882)
      lamp(new Striker({ stutters: 1 }), part(shop.starPart), l => l < 0.902)
      lamp(new Striker({ stutters: 1 }), part(shop.arrowPart), l => l < 0.92)
      lamp(new Striker({ stutters: 0, ramp: 0.14 }), part(shop.helloPart), l => l >= 0.075 && l < 0.94)
      lamp(new Striker({ stutters: 1 }), part(shop.borderPart), l => l >= 0.1)
      lamp(new Striker({ stutters: 2 }), part(shop.openPart), l => l >= 0.13)

      // ---------------------------------------------------------------- DOM
      root = el('div', 'ct', undefined, ctx.stage)
      dock = el('div', 'ct-dock', undefined, root)
      panel = el('div', 'ct-panel hud-panel', undefined, dock)
      partA = el('div', 'ct-part ct-a', undefined, panel)
      el('p', 'hud-eyebrow', CONTACT.eyebrow, partA)
      title = rise(el('h2', 'hud-h2 ct-title', undefined, partA), 'Say <em>hello.</em>')
      el('p', 'hud-body ct-body', CONTACT.body, partA)
      const mail = el('a', 'ct-email', BRAND.email, partA)
      mail.href = CONTACT.href
      const acts = el('div', 'ct-actions', undefined, partA)
      const cp = el('button', 'hud-btn ct-copy', 'Copy email', acts)
      cp.type = 'button'
      let resetT = 0
      cp.addEventListener('click', async () => {
        const ok = await copyText(BRAND.email)
        cp.textContent = ok ? 'Copied' : 'Copy failed'
        window.clearTimeout(resetT)
        resetT = window.setTimeout(() => (cp.textContent = 'Copy email'), 1800)
      })

      partB = el('div', 'ct-part ct-b', undefined, panel)
      const others = el('div', 'ct-others', undefined, partB)
      el('p', 'hud-label ct-others-label', 'Other concepts', others)
      const list = el('ul', 'ct-list', undefined, others)
      for (const c of OTHER_CONCEPTS) {
        const li = el('li', '', undefined, list)
        const a = el('a', 'ct-chip', undefined, li)
        a.href = c.url
        a.target = '_blank'
        a.rel = 'noopener'
        a.textContent = c.name
        el('span', 'ct-chip-arrow', '↗', a).setAttribute('aria-hidden', 'true')
      }
      const foot = el('div', 'ct-foot', undefined, partB)
      const top = el('button', 'hud-btn hud-btn--ghost ct-top', 'Back to top ↑', foot)
      top.type = 'button'
      top.addEventListener('click', () => window.__hark?.land('hero'))
      el('p', 'hud-label ct-legal', `© ${new Date().getFullYear()} ${BRAND.name} · ${BRAND.locale}`, foot)

      // closing time: the sign-off under the lit door
      end = el('div', 'ct-end', undefined, root)
      const top2 = el('button', 'hud-btn hud-btn--ghost ct-top', 'Back to top ↑', end)
      top2.type = 'button'
      top2.addEventListener('click', () => window.__hark?.land('hero'))
      el('p', 'hud-label ct-legal ct-legal--end', `© ${new Date().getFullYear()} ${BRAND.name} · ${BRAND.locale}`, end)

      // measure the panel only when it changes size (no per-frame layout reads)
      if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(() => {
          panelH = panel.offsetHeight || panelH
        }).observe(panel)
        // a hidden part reports 0: keep its last real height
        ;[partA, partB].forEach((node, i) =>
          new ResizeObserver(() => {
            if (node.offsetHeight) partH[i] = node.offsetHeight
          }).observe(node),
        )
      }
    },

    onEnter() {
      fresh = true
    },

    busy() {
      return lamps.some(l => Math.abs(l.last - l.tgt) > 0.002)
    },

    update(local, frame, ctx) {
      // layout mode from the viewport (cheap; classes only change on a flip)
      const p = frame.height > frame.width
      const sp = p && frame.width < 600
      if (p !== portrait) root.classList.toggle('is-portrait', (portrait = p))
      if (sp !== split) root.classList.toggle('is-split', (split = sp))

      // ------------------------------------------------ the lights
      const calm = ctx.reducedMotion || !!frame.still || Math.abs(frame.velocity) > 2.5
      for (const l of lamps) {
        const on = l.on(local)
        l.tgt = on ? 1 : 0
        if (fresh) l.s.set(l.tgt)
        l.last = l.s.update(on, frame.dt, calm)
        l.set(l.last)
      }
      fresh = false
      // "Say hello." writes itself along its tube (scroll-driven); calm modes
      // show the whole word (it ramps on instead)
      const drawEnd = portrait ? 0.24 : 0.3
      const draw = ctx.reducedMotion || frame.still ? 1 : ease.inOutQuad(segment(local, 0.08, drawEnd))
      shop.helloPart.setDraw(draw)
      shop.setHelloGlow(shop.helloPart.level * (0.12 + 0.88 * draw))
      shop.sync()

      // ------------------------------------------------ the room
      const k = smoothstep(0.85, 0.96, local)
      const w = ctx.world.params
      w.top = '#040307'
      w.bottom = '#0a0710'
      w.glow = lerp(0.2, 0.08, k)
      w.glowColor = k > 0.5 ? '#ff4220' : '#ff2e97'
      w.fog = 0.03
      w.fogColor = '#07050b'
      w.motes = lerp(0.42, 0.14, k)
      w.moteColor = '#ffc9df'
      w.env = lerp(0.5, 0.1, k)
      w.fill = lerp(0.14, 0.03, k)
      ctx.post.params.vignette = lerp(0.42, 0.6, k)

      // ------------------------------------------------ copy
      let pv = smoothstep(0.2, 0.265, local) * (1 - smoothstep(0.84, 0.885, local))
      // narrow phones: the panel steps from the email to the other concepts,
      // dipping out for a moment while it changes size
      const b = split && local >= 0.56
      if (b !== showB) panel.classList.toggle('show-b', (showB = b))
      if (split) pv *= 1 - smoothstep(0.535, 0.552, local) * (1 - smoothstep(0.568, 0.585, local))
      reveal(panel, pv)
      setRise(title, local > 0.21 && local < (split ? 0.56 : 0.88))
      reveal(end, smoothstep(0.905, 0.95, local))
    },

    camera(local, frame, out: CameraPose) {
      const w = Math.max(1, frame.width)
      const h = Math.max(1, frame.height)
      const aspect = w / h
      const doorL = -DOOR.halfW
      const helloR = shop ? shop.helloX + shop.helloWidth / 2 : 3
      const subCx = (doorL + helloR) / 2
      const subHw = (helloR - doorL) / 2 + 0.12
      if (h > w) {
        // portrait: establishing → the wall while "Say hello." writes → the sign in the top band
        const fov = 50
        const safeTop = Math.min(112, Math.max(80, 0.105 * h)) / h
        const safeBot = Math.min(110, Math.max(82, 0.105 * h)) / h
        const ph = split ? Math.max(partH[0], partH[1]) + 36 || panelH : panelH
        const bandBottom = clamp(1 - safeBot - (ph + 18) / h, safeTop + 0.16, 0.7)
        fit(A, aspect, fov, subCx, 1.7, subHw + 0.5, 1.6, 0.04, 0.96, 0.12, 0.9, 0.35)
        fit(W, aspect, fov, subCx, 1.62, subHw, 0.9, 0.04, 0.96, 0.2, 0.75, 0.1)
        fit(L, aspect, fov, 0, 1.64, 0.62, 0.44, 0.06, 0.94, safeTop + 0.01, bandBottom, -0.1)
        fit(L2, aspect, fov, 0, 1.64, 0.6, 0.42, 0.06, 0.94, safeTop + 0.01, bandBottom, -0.12)
        fit(F, aspect, fov, 0, 1.5, 0.85, 0.7, 0.06, 0.94, 0.14, 0.7, -0.05)
        if (local < 0.2) mix(OUT, A, W, ease.inOutCubic(segment(local, 0.02, 0.12)))
        else if (local < 0.85) {
          mix(S1, L, L2, segment(local, 0.3, 0.85))
          mix(OUT, W, S1, ease.inOutCubic(segment(local, 0.2, 0.29)))
        } else mix(OUT, L2, F, ease.inOutCubic(segment(local, 0.85, 0.985)))
      } else {
        // landscape: establishing → door + "Say hello." right of the panel → square on the door
        const fov = 38
        const gutter = Math.min(48, Math.max(16, 0.034 * w))
        const panelR = (gutter + Math.min(520, 0.42 * w) + 20) / w
        fit(A, aspect, fov, subCx - 0.4, 1.65, subHw + 1.5, 1.45, 0.06, 0.94, 0.12, 0.88, 0.3, -0.3)
        fit(L, aspect, fov, subCx, 1.62, subHw, 0.95, panelR, 0.975, 0.16, 0.84, 0.05, -0.2)
        fit(L2, aspect, fov, subCx, 1.62, subHw * 0.97, 0.92, panelR, 0.975, 0.16, 0.84, 0.03, -0.15)
        fit(F, aspect, fov, 0, 1.45, 1.0, 0.95, 0.15, 0.85, 0.08, 0.74, 0.1)
        if (local < 0.28) mix(OUT, A, L, ease.inOutCubic(segment(local, 0.02, 0.28)))
        else if (local < 0.85) mix(OUT, L, L2, segment(local, 0.28, 0.85))
        else mix(OUT, L2, F, ease.inOutCubic(segment(local, 0.85, 0.985)))
      }
      out.position.copy(OUT.pos)
      out.target.copy(OUT.tgt)
      out.fov = OUT.fov
      out.parallax = 0.12
    },
  }
}
