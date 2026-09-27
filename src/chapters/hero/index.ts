import * as THREE from 'three'
import type { Chapter } from '../../core/types'
import { el, rise, setRise, reveal } from '../../core/dom'
import { BRAND, MICROCOPY } from '../../content'
import { ease, segment, smoothstep } from '../../core/math'
import { framedCamera } from '../common'
import { markStrokes, neonFromStrokes, neonSpill, neonText, Striker, type NeonPart } from '../../kit/neon'
import { backerPanel, brickMaterial, concreteMaterial, fluorescentFixture, tubeLight } from '../../kit/shop'
import '../chapter.css'

/*
 * HERO (look lab). The foundation's smoke test: brick wall, a black acrylic
 * backer with the Hark mark bent in white neon, a pink script tube, two
 * fluorescent fixtures and a sealed concrete floor. The hero agent replaces
 * the scene; keep the copy pattern (intro → payoff with CTAs).
 */
export default function create(): Chapter {
  const group = new THREE.Group()
  let intro: HTMLElement
  let payoff: HTMLElement
  let title: HTMLElement
  const parts: { part: NeonPart; s: Striker; at: number }[] = []
  let lights: ReturnType<typeof fluorescentFixture>[] = []
  const syncs: { sync(): void }[] = []
  return {
    id: 'hero',
    group,
    anchors: [0.8],
    init(ctx) {
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(16, 9), brickMaterial({ width: 16, height: 9, tint: '#3a2b33' }))
      wall.position.set(0, 1.5, -0.6)
      group.add(wall)
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(24, 16), concreteMaterial({ width: 24, depth: 16 }))
      floor.rotation.x = -Math.PI / 2
      floor.position.y = -2.2
      group.add(floor)

      const sign = new THREE.Group()
      sign.position.set(0, 0.35, 0)
      group.add(sign)
      sign.add(backerPanel(3.4, 2.9))
      const m = markStrokes(1.5, 0.07)
      for (const [i, key] of (['loopA', 'loopB', 'diamond'] as const).entries()) {
        const p = neonFromStrokes(m[key], { color: 'white', radius: 0.017, hdr: 4.2 })
        p.group.position.y = 0.42
        sign.add(p.group)
        const sp = neonSpill(m[key], { color: '#ffd6ec', width: 3.2, height: 2.6, blur: 0.07, strength: 0.28 })
        sp.position.set(0, 0.42, 0.002)
        sign.add(sp)
        p.follow(sp)
        parts.push({ part: p, s: new Striker({ stutters: i === 2 ? 2 : 1 }), at: 0.02 + i * 0.03 })
      }
      const { part: word, text } = neonText('listen', { font: 'script', size: 0.42 }, { color: 'pink', hdr: 4.4 })
      word.group.position.set(0, -0.82, 0.07)
      sign.add(word.group)
      const wsp = neonSpill(text.strokes, { color: 'pink', width: text.width + 1, height: 1.3, blur: 0.08, strength: 0.45 })
      wsp.position.set(0, -0.82, 0.002)
      sign.add(wsp)
      word.follow(wsp)
      parts.push({ part: word, s: new Striker({ stutters: 2 }), at: 0.12 })

      const side = neonText('OPEN', { font: 'sans', size: 0.5, tracking: 0.12 }, { color: 'red', hdr: 4 })
      side.part.group.position.set(-4.3, 1.4, -0.45)
      group.add(side.part.group)
      parts.push({ part: side.part, s: new Striker({ stutters: 1 }), at: 0.0 })
      const late = neonText('late', { font: 'script', size: 0.5 }, { color: 'blue', hdr: 4 })
      late.part.group.position.set(4.2, 1.8, -0.45)
      group.add(late.part.group)
      parts.push({ part: late.part, s: new Striker({ stutters: 1 }), at: 0.0 })

      // the signs' light on the wall and floor (RectAreaLights; count fixed)
      const wl = (part: NeonPart, x: number, y: number, w: number, h: number, i: number, face: 'wall' | 'floor') => {
        const l = tubeLight(part, { width: w, height: h, intensity: i })
        // wall lights sit BEHIND the glossy backer (a halo round its edge); in
        // front of it they turn the acrylic into a white lightbox
        l.position.set(x, y, face === 'wall' ? -0.2 : 0.6)
        if (face === 'wall') l.lookAt(x, y, -2)
        else l.lookAt(x, -3, 1.5)
        group.add(l)
        syncs.push(l)
      }
      wl(parts[0].part, 0, 0.8, 3, 2.4, 10, 'wall')
      wl(word, 0, -0.5, 2.2, 0.8, 14, 'floor')
      wl(side.part, -4.3, 1.4, 2, 0.8, 12, 'wall')
      wl(late.part, 4.2, 1.8, 2, 0.8, 12, 'wall')
      lights = [-2.2, 2.2].map(x => {
        const f = fluorescentFixture(1.5, { intensity: 5 })
        f.group.position.set(x, 3.4, 1.4)
        group.add(f.group)
        return f
      })

      intro = el('div', 'ph-copy', undefined, ctx.stage)
      el('p', 'hud-eyebrow', MICROCOPY.signalEyebrow, intro)
      el('p', 'hud-body', BRAND.manifesto, intro)
      el('p', 'hud-label', MICROCOPY.scrollHint + ' ↓', intro)
      payoff = el('div', 'ph-copy', undefined, ctx.stage)
      title = rise(el('h1', 'hud-title', undefined, payoff), 'Make the internet <em>listen.</em>')
      const ctas = el('div', 'ph-ctas', undefined, payoff)
      const see = el('button', 'hud-btn', 'See the work', ctas)
      see.type = 'button'
      see.addEventListener('click', () => window.__hark?.land('work'))
      const start = el('a', 'hud-btn hud-btn--ghost', 'Start a project', ctas)
      start.href = '#contact'
      start.addEventListener('click', e => {
        if (!window.__hark) return
        e.preventDefault()
        window.__hark.land('contact')
      })
    },
    update(local, frame, ctx) {
      const calm = ctx.reducedMotion || !!frame.still
      for (const p of parts) p.part.setLevel(p.s.update(local >= p.at, frame.dt, calm))
      for (const f of lights) f.setLevel(1)
      for (const l of syncs) l.sync()
      reveal(intro, 1 - smoothstep(0.08, 0.14, local))
      reveal(payoff, smoothstep(0.62, 0.7, local) * (1 - smoothstep(0.93, 0.97, local)))
      setRise(title, local > 0.64 && local < 0.95)
    },
    camera(local, frame, out) {
      framedCamera(out, frame, ease.inOutCubic(segment(local, 0.55, 0.7)), 7.2)
    },
  }
}
