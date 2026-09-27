import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { Chapter, Frame } from '../../core/types'
import { el, rise, setRise, reveal } from '../../core/dom'
import { SECTIONS, TESTIMONIALS } from '../../content'
import { clamp, ease, segment, smoothstep } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { beat } from '../common'
import { neonFromStrokes, neonSpill, textStrokes, Striker, TUBE, type NeonPart, type TubeColor } from '../../kit/neon'
import type { Stroke } from '../../kit/type'
import { acrylicMaterial, brickMaterial, concreteMaterial, initAreaLights, steelMaterial } from '../../kit/shop'
import { bubbleStrokes, commaStrokes, TEXT_H, TEXT_W, type BubbleShape } from './bubbles'
import { bokeh, streetPlate } from './street'
import '../chapter.css'
import './voices.css'

/*
 * VOICES · "Word of Mouth" — the shop's front window at night, from inside.
 *
 * A long plate-glass storefront (black steel mullions, a concrete sill, the
 * brick knee wall under it), the street beyond it out of focus. Hanging in
 * the window, one per bay: eight neon SPEECH BUBBLES, each a single bent
 * tube (ellipse, rounded box, cloud, squircle) with a pair of hand-bent
 * quotation marks and the client's first name in script on a little black
 * name plate the tail points at.
 *
 *   0.00–0.06   intro: a wide, raking shot down the window, the whole chorus
 *               lit; eyebrow + "We listen. They talk."
 *   0.06–0.11   the camera swings square onto bubble 1; the others cut out
 *   0.07–0.95   eight beats (beat(); anchors = centres). Per quote: the
 *               bubble strikes on in its colour, a slow push-in with a
 *               lateral drift holds while the quote reads INSIDE it
 *               (desktop) or in a panel under it (portrait/phones); between
 *               quotes the camera trucks one bay along, the old bubble cuts
 *               out and the next strikes (one off/on pair, time-limited)
 *   0.95–1.00   out: the last bubble bright for the cut
 *
 * The glass: a faint dark pane with env sheen, each bubble's glow spilt on
 * it (neonSpill) and its reflection as a dim mirrored duplicate beyond it.
 * Lights (fixed, 4 RectAreaLights): two that follow the lit bubbles
 * (even/odd), one wide strip for the intro chorus, the street's sodium glow.
 */

type Spec = { shape: BubbleShape; a: number; b: number; side: -1 | 1; color: TubeColor; name: string; nameColor: TubeColor }
const SPECS: Spec[] = [
  { shape: 'ellipse', a: 2.2, b: 1.05, side: -1, color: 'pink', name: 'And|rew', nameColor: 'blue' },
  { shape: 'rounded', a: 2.12, b: 1.02, side: 1, color: 'blue', name: 'Holly', nameColor: 'pink' },
  { shape: 'cloud', a: 2.1, b: 0.98, side: -1, color: 'amber', name: 'Barbara', nameColor: 'blue' },
  { shape: 'squircle', a: 2.12, b: 1.02, side: 1, color: 'violet', name: 'Scott', nameColor: 'amber' },
  { shape: 'rounded', a: 2.12, b: 1.02, side: -1, color: 'red', name: 'Christina', nameColor: 'turquoise' },
  { shape: 'cloud', a: 2.1, b: 0.98, side: 1, color: 'white', name: 'MaryJane', nameColor: 'pink' },
  { shape: 'ellipse', a: 2.2, b: 1.05, side: -1, color: 'blue', name: 'Pete', nameColor: 'amber' },
  { shape: 'squircle', a: 2.12, b: 1.02, side: 1, color: 'pink', name: 'Alicyn', nameColor: 'blue' },
]

// the storefront (world units; glass in the z = 0 plane, the room is +z)
const S = 5.2 // bay width: one bubble per bay
const N = SPECS.length
const Y_B = 2.45 // bubble body centre
const Z_B = 0.46 // bubbles hang this far inside the glass
const HEAD = 4.7 // underside of the header
const WX0 = -S / 2
const WX1 = (N - 0.5) * S
const PLATE_TOP = -1.42 // name plates hang with their top edge here (below the body centre)
const WALL_Z = 0.52 // the brick face; the glass is set back in the reveal
const FLOOR = -1.5

const FOV = 36
const TAN = Math.tan(((FOV / 2) * Math.PI) / 180)

// story
const A0 = 0.07
const A1 = 0.95
const SPAN = (A1 - A0) / N
const CHORUS_END = 0.088
const SWING = [0.062, 0.106]
/** the lit bubble changes at most this often (s): ≤ 2 changes a second, whatever the scroll speed */
const SWITCH_GAP = 0.5

const hex = (c: TubeColor) => TUBE[c]

/**
 * A first name in script. '|' marks a manual kern: EMS Allure's d curls its
 * ascender over a following r ("Andrew" read "Andkew"), so those pairs are
 * set as separate runs, kerned so the r tucks under the curl (proofed).
 */
function scriptName(name: string, size: number) {
  const runs = name.split('|').map(r => textStrokes(r, { font: 'script', size, align: 'left' }))
  const strokes: Stroke[] = []
  let x = 0
  for (const r of runs) {
    let minX = Infinity
    let maxX = -Infinity
    for (const s of r.strokes) for (const p of s.pts) (minX = Math.min(minX, p.x)), (maxX = Math.max(maxX, p.x))
    for (const s of r.strokes) strokes.push({ pts: s.pts.map(p => new THREE.Vector3(p.x - minX + x, p.y, 0)) })
    x += maxX - minX - size * 0.08
  }
  return { strokes }
}

interface Bubble {
  group: THREE.Group
  outline: NeonPart
  open: NeonPart
  close: NeonPart
  name: NeonPart
  openG: THREE.Group
  closeG: THREE.Group
  ghosts: THREE.Mesh[]
  ghostMat: THREE.MeshBasicMaterial
  pool: THREE.Mesh
  striker: Striker
  level: number
  draw: number
  markX: number
}

export default function create(): Chapter {
  const group = new THREE.Group()
  const bubbles: Bubble[] = []
  const B = beat(0, N, A0, A1)
  let lightA: THREE.RectAreaLight, lightB: THREE.RectAreaLight, chorusLight: THREE.RectAreaLight, streetLight: THREE.RectAreaLight
  let street: ReturnType<typeof bokeh>
  let stage: HTMLElement, root: HTMLElement, probe: HTMLElement
  let intro: HTMLElement, introTitle: HTMLElement
  const figs: HTMLElement[] = []
  // composition extents round each bubble body centre (bubble top, plate bottom)
  let compTop = 1.2
  let compBot = 2
  // layout (per viewport): screen scale and where the body centre sits
  const L = { W: 0, H: 0, inside: true, ppu: new Array<number>(N).fill(200), bodyY: new Array<number>(N).fill(400), dirty: true }
  // the lit bubble (-1 = the whole chorus), switched at most every 0.3 s
  let shown = -1
  let clock = 0
  let lastSwitch = -1e9

  function layout(fw: number, fh: number) {
    L.W = fw
    L.H = fh
    L.dirty = false
    const inside = fw >= 900 && fw / fh >= 1.15
    L.inside = inside
    root.classList.toggle('vc-inside', inside)
    root.classList.toggle('vc-panel', !inside)
    for (const f of figs) f.classList.toggle('hud-panel', !inside)
    const sr = stage.getBoundingClientRect()
    const pr = probe.getBoundingClientRect()
    const sh = sr.height || fh
    const scale = sh > 0 ? fh / sh : 1
    const bandTop = (pr.top - sr.top) * scale + 6
    const bandBot = (pr.bottom - sr.top) * scale - 6
    const comp = (compTop + compBot) * 1.07
    if (inside) {
      const ppu = Math.max(80, Math.min((bandBot - bandTop) / comp, (fw * 0.92) / 4.9, 300))
      let fs = clamp(ppu * 0.118, 15, 27)
      const apply = () => {
        root.style.setProperty('--vc-w', `${(TEXT_W * ppu).toFixed(1)}px`)
        root.style.setProperty('--vc-fs', `${fs.toFixed(2)}px`)
      }
      apply()
      const maxH = Math.max(...figs.map(f => f.offsetHeight))
      if (maxH > TEXT_H * ppu) {
        fs = Math.max(13, (fs * TEXT_H * ppu) / maxH)
        apply()
      }
      const bodyY = (bandTop + bandBot) / 2 - ((compBot - compTop) / 2) * ppu
      root.style.setProperty('--vc-y', `${bodyY.toFixed(1)}px`)
      L.ppu.fill(ppu)
      L.bodyY.fill(bodyY)
    } else {
      figs.forEach((f, i) => {
        const h = f.offsetHeight * scale
        const panelTop = bandBot + 6 - h
        const bb = panelTop - 14
        const ppu = Math.max(40, Math.min((fw * 0.9) / 4.9, (bb - bandTop) / comp))
        L.ppu[i] = ppu
        L.bodyY[i] = (bandTop + bb) / 2 - ((compBot - compTop) / 2) * ppu
      })
    }
    // quotation marks: flanking the text inside the bubble (desktop), or a
    // centred pair in the empty bubble when the words live in the panel
    for (const b of bubbles) {
      if (inside) {
        b.openG.position.set(-b.markX, 0.16, 0)
        b.closeG.position.set(b.markX, -0.16, 0)
        b.openG.scale.setScalar(1)
        b.closeG.scale.setScalar(1)
        b.ghosts[1].position.z = b.ghosts[2].position.z = -2 * Z_B
      } else {
        b.openG.position.set(-0.62, 0.12, 0)
        b.closeG.position.set(0.62, -0.12, 0)
        b.openG.scale.setScalar(1.7)
        b.closeG.scale.setScalar(1.7)
        b.ghosts[1].position.z = b.ghosts[2].position.z = (-2 * Z_B) / 1.7
      }
    }
  }

  /** camera on bubble k at push-in s (0..1+) */
  function bubblePose(k: number, s: number, pos: THREE.Vector3, tgt: THREE.Vector3, drift = 1) {
    const ppu = L.ppu[k] * (1 + 0.065 * s)
    const d = L.H / (2 * TAN * ppu)
    const up = (L.H / 2 - L.bodyY[k]) / ppu
    const dir = k % 2 ? 1 : -1
    const x = k * S
    tgt.set(x, Y_B - up, Z_B)
    pos.set(x + dir * (s - 0.5) * drift, Y_B - up + 0.32, Z_B + d)
  }

  /** the wide raking shot down the window; returns its fov */
  function introPose(pos: THREE.Vector3, tgt: THREE.Vector3) {
    if (L.inside) {
      pos.set(-10.5, 3.9, 12.5)
      tgt.set(6.5, 1.9, 0)
      return FOV
    }
    // portrait is narrow: rake hard along the glass so the whole row fits
    pos.set(-10, 2.9, 5.4)
    tgt.set(4.4, 1.95, 2.1)
    return 52
  }

  const q = (local: number) => (local - A0) / SPAN
  const push = (k: number, qq: number) => {
    const s = (qq - k + 0.15) / 1.3
    return k === N - 1 ? clamp(s, 0, 1.3) : clamp(s)
  }

  return {
    id: 'voices',
    group,
    anchors: B.centers,
    async init(ctx) {
      initAreaLights()
      const radial = ctx.mobile ? 6 : 8
      stage = ctx.stage

      // ---------------------------------------------------------------- the room
      const brick = (w: number, h: number) => brickMaterial({ tint: '#2c2029', width: w, height: h, tile: 1.7 })
      const wall = (x0: number, x1: number, y0: number, y1: number) => {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, y1 - y0), brick(x1 - x0, y1 - y0))
        m.position.set((x0 + x1) / 2, (y0 + y1) / 2, WALL_Z)
        group.add(m)
      }
      wall(-16, WX0 - 0.3, FLOOR, 9) // left pier
      wall(WX1 + 0.3, WX1 + 14, FLOOR, 9) // right pier
      wall(WX0 - 0.3, WX1 + 0.3, HEAD + 0.1, 9) // above the header
      wall(WX0 - 0.3, WX1 + 0.3, FLOOR, -0.08) // knee wall under the sill
      const steelDark = new THREE.MeshStandardMaterial({ color: 0x131116, roughness: 0.4, metalness: 0.6, envMapIntensity: 0.9 })
      // the reveal: jambs and a steel header soffit
      const steelParts: THREE.BufferGeometry[] = []
      const pushBox = (w: number, h: number, d: number, x: number, y: number, z: number) => {
        const g = new THREE.BoxGeometry(w, h, d)
        g.translate(x, y, z)
        steelParts.push(g)
      }
      pushBox(WX1 - WX0 + 0.6, 0.2, WALL_Z + 0.06, (WX0 + WX1) / 2, HEAD + 0.1, WALL_Z / 2 - 0.03) // header
      pushBox(0.3, HEAD + 0.2, WALL_Z, WX0 - 0.15, HEAD / 2, WALL_Z / 2) // jambs
      pushBox(0.3, HEAD + 0.2, WALL_Z, WX1 + 0.15, HEAD / 2, WALL_Z / 2)
      for (let k = 0; k < N - 1; k++) pushBox(0.1, HEAD, 0.16, (k + 0.5) * S, HEAD / 2, 0) // mullions
      pushBox(WX1 - WX0, 0.07, 0.12, (WX0 + WX1) / 2, HEAD - 0.95, 0) // transom bar
      pushBox(WX1 - WX0, 0.06, 0.1, (WX0 + WX1) / 2, 0.03, 0) // bottom rail
      const steelMesh = new THREE.Mesh(mergeGeometries(steelParts)!, steelDark)
      group.add(steelMesh)
      // the sill: sealed concrete, glossy enough to streak with the bubbles' light
      const sill = new THREE.Mesh(new THREE.BoxGeometry(WX1 - WX0 + 0.6, 0.1, WALL_Z + 0.2), concreteMaterial({ color: '#16121a', roughness: 0.2, width: WX1 - WX0, depth: 1 }))
      sill.position.set((WX0 + WX1) / 2, -0.05, (WALL_Z + 0.2) / 2 - 0.1)
      group.add(sill)
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(WX1 - WX0 + 40, 24), concreteMaterial({ width: WX1 - WX0 + 40, depth: 24 }))
      floor.rotation.x = -Math.PI / 2
      floor.position.set((WX0 + WX1) / 2, FLOOR, WALL_Z + 12)
      group.add(floor)

      // the glass: a faint dark pane with env sheen
      const glass = new THREE.Mesh(
        new THREE.PlaneGeometry(WX1 - WX0, HEAD),
        new THREE.MeshStandardMaterial({ color: 0x04050a, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.2, envMapIntensity: 1.6, depthWrite: false }),
      )
      glass.position.set((WX0 + WX1) / 2, HEAD / 2, 0)
      glass.renderOrder = 0
      group.add(glass)

      // the street beyond
      group.add(streetPlate())
      street = bokeh(ctx.mobile)
      group.add(street)
      await nextFrame()

      // ---------------------------------------------------------------- bubbles
      const poolTex = (() => {
        const c = document.createElement('canvas')
        c.width = 128
        c.height = 32
        const g = c.getContext('2d')!
        // an elliptical pool: bright under the bubble, gone at the edges
        g.setTransform(1, 0, 0, 0.25, 0, 0)
        const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64)
        grd.addColorStop(0, 'rgba(255,255,255,1)')
        grd.addColorStop(0.45, 'rgba(255,255,255,0.4)')
        grd.addColorStop(1, 'rgba(255,255,255,0)')
        g.fillStyle = grd
        g.fillRect(0, 0, 128, 128)
        const t = new THREE.CanvasTexture(c)
        t.colorSpace = THREE.NoColorSpace
        return t
      })()
      const chains: THREE.BufferGeometry[] = []
      let top = 0
      let bot = 0
      for (let i = 0; i < N; i++) {
        const sp = SPECS[i]
        const g = new THREE.Group()
        g.position.set(i * S, Y_B, Z_B)
        group.add(g)
        const geo = bubbleStrokes({ shape: sp.shape, a: sp.a, b: sp.b, side: sp.side })
        const white = sp.color === 'white'
        const hdr = white ? 2.6 : 4.3
        const outline = neonFromStrokes(geo.strokes, { color: sp.color, radius: 0.021, hdr, radial })
        g.add(outline.group)
        const mkQuote = (open: boolean) => {
          const qg = new THREE.Group()
          const part = neonFromStrokes(commaStrokes(open), { color: sp.color, radius: 0.019, hdr, radial, depth: 0.1 })
          qg.add(part.group)
          g.add(qg)
          return { qg, part }
        }
        const o = mkQuote(true)
        const c = mkQuote(false)
        // name plate: first name in script on a small black acrylic plate
        const nameT = scriptName(sp.name, 0.2)
        let minX = Infinity
        let maxX = -Infinity
        let minY = Infinity
        let maxY = -Infinity
        for (const s of nameT.strokes)
          for (const p of s.pts) {
            minX = Math.min(minX, p.x)
            maxX = Math.max(maxX, p.x)
            minY = Math.min(minY, p.y)
            maxY = Math.max(maxY, p.y)
          }
        const pw = maxX - minX + 0.36
        const ph = maxY - minY + 0.22
        const cx = (minX + maxX) / 2
        const cy = (minY + maxY) / 2
        const nameStrokes: Stroke[] = nameT.strokes.map(s => ({ pts: s.pts.map(p => new THREE.Vector3(p.x - cx, p.y - cy, 0)) }))
        const name = neonFromStrokes(nameStrokes, { color: sp.nameColor, radius: 0.0082, hdr: 3.8, radial, depth: 0.05 })
        const plate = new THREE.Group()
        plate.position.set(geo.tip.x + sp.side * 0.08, Math.min(PLATE_TOP, geo.tip.y - 0.1) - ph / 2, -0.02)
        // black acrylic face (1.2 cm) on a brushed steel sheet whose edge
        // shows round it, so the plate reads on the dark glass
        const face = new THREE.Mesh(new THREE.BoxGeometry(pw, ph, 0.012), acrylicMaterial())
        face.position.z = -0.006
        plate.add(face)
        const rim = new THREE.Mesh(new THREE.BoxGeometry(pw + 0.035, ph + 0.035, 0.008), steelMaterial())
        rim.position.z = -0.017
        plate.add(rim)
        name.group.position.z = 0.035
        plate.add(name.group)
        const nsp = neonSpill(nameStrokes, { color: sp.nameColor, width: pw, height: ph, blur: 0.045, strength: 0.3, res: 128 })
        nsp.position.z = 0.002
        plate.add(nsp)
        name.follow(nsp)
        g.add(plate)
        top = Math.max(top, geo.top)
        bot = Math.max(bot, -(plate.position.y - ph / 2))
        // chains up to the header
        for (const h of geo.hang) {
          const len = HEAD - (Y_B + h.y)
          const cg = new THREE.CylinderGeometry(0.007, 0.007, len, 5, 1)
          cg.translate(i * S + h.x, Y_B + h.y + len / 2, Z_B - 0.01)
          chains.push(cg)
        }
        // its glow on the glass, and its reflection beyond it
        const markX = geo.markX
        const spillStrokes: Stroke[] = [
          ...geo.strokes,
          ...commaStrokes(true).map(s => ({ pts: s.pts.map(p => p.clone().add(new THREE.Vector3(-markX, 0.16, 0))) })),
          ...commaStrokes(false).map(s => ({ pts: s.pts.map(p => p.clone().add(new THREE.Vector3(markX, -0.16, 0))) })),
        ]
        const gsp = neonSpill(spillStrokes, { color: sp.color, width: 6.2, height: 3.6, cy: -0.25, blur: 0.2, strength: white ? 0.14 : 0.22, res: 256 })
        gsp.position.set(0, -0.25, -Z_B + 0.004)
        g.add(gsp)
        outline.follow(gsp)
        const ghostMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(hex(sp.color)).multiplyScalar(white ? 0.28 : 0.5),
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
          fog: false,
        })
        const ghosts: THREE.Mesh[] = []
        const ghost = (part: NeonPart, parent: THREE.Object3D) => {
          const m = new THREE.Mesh(part.tube.geometry, ghostMat)
          m.position.z = -2 * Z_B
          m.scale.z = -1
          m.visible = false
          parent.add(m)
          ghosts.push(m)
        }
        ghost(outline, g)
        // (the marks' ghosts ride in their groups so they follow the layout)
        ghost(o.part, o.qg)
        ghost(c.part, c.qg)
        // the mark groups sit at z = 0 in the bubble, so their ghost offset is the same
        // light pooled on the sill under it
        const pool = new THREE.Mesh(
          new THREE.PlaneGeometry(3.2, WALL_Z + 0.1),
          new THREE.MeshBasicMaterial({
            map: poolTex,
            color: new THREE.Color(hex(sp.color)).multiplyScalar(white ? 0.25 : 0.42),
            transparent: true,
            opacity: 0,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            toneMapped: false,
          }),
        )
        pool.rotation.x = -Math.PI / 2
        pool.position.set(i * S, 0.003, (WALL_Z + 0.1) / 2 - 0.05)
        group.add(pool)
        bubbles.push({
          group: g,
          outline,
          open: o.part,
          close: c.part,
          name,
          openG: o.qg,
          closeG: c.qg,
          ghosts,
          ghostMat,
          pool,
          striker: new Striker({ stutters: 1 }),
          level: 0,
          draw: 0,
          markX,
        })
        if (i % 2) await nextFrame()
      }
      compTop = top + 0.04
      compBot = bot + 0.04
      group.add(new THREE.Mesh(mergeGeometries(chains)!, steelMaterial()))

      // ---------------------------------------------------------------- lights (4, fixed)
      lightA = new THREE.RectAreaLight(0xffffff, 0, 4.2, 1.2)
      lightB = new THREE.RectAreaLight(0xffffff, 0, 4.2, 1.2)
      chorusLight = new THREE.RectAreaLight(new THREE.Color('#ff8fc6'), 0, 5 * S, 1.2)
      chorusLight.position.set(2 * S, Y_B - 0.6, Z_B + 0.3)
      chorusLight.lookAt(2 * S, FLOOR, Z_B + 3)
      streetLight = new THREE.RectAreaLight(new THREE.Color('#ffa126'), 0, 26, 3)
      group.add(lightA, lightB, chorusLight, streetLight)

      // ---------------------------------------------------------------- DOM
      root = el('div', 'vc-root vc-inside', undefined, ctx.stage)
      probe = el('div', 'vc-probe', undefined, root)
      intro = el('div', 'vc-intro', undefined, root)
      el('p', 'hud-eyebrow', SECTIONS.voices.eyebrow, intro)
      introTitle = rise(el('h2', 'hud-h2', undefined, intro), 'We listen. They <em>talk.</em>')
      TESTIMONIALS.forEach((t, i) => {
        const f = el('figure', 'vc-fig', undefined, root)
        f.style.setProperty('--vc-c', hex(SPECS[i].color))
        el('div', 'vc-scrim', undefined, f)
        const idx = el('p', 'hud-label vc-idx', undefined, f)
        el('span', 'vc-n', String(i + 1).padStart(2, '0'), idx)
        idx.append(` / ${String(N).padStart(2, '0')}`)
        el('blockquote', 'hud-quote vc-q', t.quote, f)
        el('figcaption', 'hud-label vc-who', `— ${t.name}, ${t.company}`, f)
        reveal(f, 0, 0)
        figs.push(f)
      })
      document.fonts?.ready.then(() => (L.dirty = true))
      window.addEventListener('resize', () => (L.dirty = true))
    },

    onEnter() {
      lastSwitch = -1e9
    },

    busy() {
      return bubbles.some(b => (b.level > 0.001 && b.level < 0.999) || (b.draw > 0 && b.draw < 1)) || clock - lastSwitch < SWITCH_GAP + 0.05
    },

    update(local, frame, ctx) {
      if (L.dirty || frame.width !== L.W || frame.height !== L.H) layout(frame.width, frame.height)
      const dt = frame.dt
      clock += dt
      // calm: no stutters. While the page is moving at all, quotes change by a
      // cross-fade with no dark gap between them (a scroll through eight
      // bubbles must not read as eight flashes); a bubble only STRIKES when
      // the reader has come (nearly) to rest on it
      const calm = ctx.reducedMotion || !!frame.still || Math.abs(frame.velocity) > 0.35
      const instant = ctx.reducedMotion || !!frame.still
      const qq = q(local)

      // which bubble is lit: the chorus for the intro, then one at a time
      const want = local < CHORUS_END ? -1 : clamp(Math.floor(qq), 0, N - 1)
      if (want !== shown && clock - lastSwitch >= SWITCH_GAP) {
        shown = want
        lastSwitch = clock
      }
      let maxL = 0
      let sumL = 0
      for (let i = 0; i < N; i++) {
        const b = bubbles[i]
        const on = shown === -1 || shown === i
        if (calm) {
          const tgt = on ? 1 : 0
          const rate = dt / (on ? 0.22 : 0.32)
          b.level = tgt > b.level ? Math.min(tgt, b.level + rate) : Math.max(tgt, b.level - rate)
          b.striker.set(b.level)
        } else b.level = b.striker.update(on, dt, false)
        b.outline.setLevel(b.level)
        b.open.setLevel(b.level)
        b.close.setLevel(b.level)
        // the name writes itself along its tube once the bubble has struck
        if (b.level < 0.05) b.draw = 0
        else if (b.level > 0.6) b.draw = instant ? 1 : Math.min(1, b.draw + dt / 0.55)
        b.name.setLevel(b.level)
        b.name.setDraw(ease.outQuad(b.draw))
        const gl = b.level * 0.32
        b.ghostMat.opacity = gl
        // (no reflections for the chorus: a window of doubled tubes reads as noise)
        for (const g of b.ghosts) g.visible = gl > 0.004 && shown >= 0
        ;(b.pool.material as THREE.MeshBasicMaterial).opacity = b.level * 0.45
        b.pool.visible = b.level > 0.004
        maxL = Math.max(maxL, b.level)
        sumL += b.level
      }
      // lights: A follows the brightest even bubble, B the brightest odd one
      const chorusAmt = clamp((sumL - maxL) / (N - 1))
      const place = (light: THREE.RectAreaLight, parity: number) => {
        let best = -1
        let bl = 0
        for (let i = parity; i < N; i += 2)
          if (bubbles[i].level > bl) {
            bl = bubbles[i].level
            best = i
          }
        if (best < 0) {
          light.intensity = 0
          return
        }
        const sp = SPECS[best]
        light.color.set(hex(sp.color))
        light.position.set(best * S, Y_B - 0.55, Z_B + 0.2)
        light.lookAt(best * S, FLOOR, Z_B + 2.6)
        light.intensity = bl * (sp.color === 'white' ? 5 : 9) * (1 - chorusAmt * 0.85)
      }
      place(lightA, 0)
      place(lightB, 1)
      chorusLight.intensity = chorusAmt * 7

      // the camera's bay (also steers the street light and the haze colour)
      const focusX = clamp(Math.round(qq - 0.5), 0, N - 1) * S
      streetLight.position.set(focusX + 2, 6.5, -5)
      streetLight.lookAt(focusX + 2, -0.5, 2.5)
      streetLight.intensity = 1.6

      const active = shown < 0 ? 0 : shown
      const w = ctx.world.params
      w.top = '#07060e'
      w.bottom = '#0b0812'
      w.glow = 0.22
      w.glowColor = hex(SPECS[active].color)
      w.fog = 0.016
      w.fogColor = '#0a0812'
      w.motes = 0.3
      w.moteColor = hex(SPECS[active].color)
      w.env = 0.6
      w.fill = 0.14

      // ---------------------------------------------------------------- copy
      let textVis = 0
      reveal(intro, 1 - smoothstep(0.074, 0.088, local))
      setRise(introTitle, local > 0.012 && local < 0.09)
      for (let i = 0; i < N; i++) {
        const vin = i === 0 ? smoothstep(0.098, 0.108, local) : smoothstep(i + 0.07, i + 0.13, qq)
        const vout = 1 - smoothstep(i + 0.86, i + 0.92, qq)
        const v = vin * vout
        reveal(figs[i], v, 0)
        textVis = Math.max(textVis, v)
      }
      // stop down the street lights behind the words (desktop: inside the bubble)
      const k = clamp(Math.round(qq - 0.5), 0, N - 1)
      const ppu = L.ppu[k]
      street.update(
        ctx.reducedMotion ? 0 : frame.time,
        1,
        0,
        1 - (2 * L.bodyY[k]) / L.H,
        ((TEXT_W * 0.5 + 0.35) * ppu) / (L.W / 2),
        ((TEXT_H * 0.5 + 0.25) * ppu) / (L.H / 2),
        L.inside ? textVis * 0.8 : 0,
      )
    },

    camera(local, frame: Frame, out) {
      if (!L.W) {
        L.W = frame.width
        L.H = frame.height
      }
      const qq = q(local)
      const p0 = out.position
      const t0 = out.target
      const p1 = _p1
      const t1 = _t1
      let fov = FOV
      // reduced motion: the moves between bays stay (they're the story), the drift and arcs go
      const drift = frame.reducedMotion ? 0 : 1
      if (local < SWING[1]) {
        const f0 = introPose(p0, t0)
        bubblePose(0, push(0, qq), p1, t1, drift)
        const w = ease.inOutCubic(segment(local, SWING[0], SWING[1]))
        fov = f0 + (FOV - f0) * w
        // a slow creep in the wide shot before the swing
        p0.x += segment(local, 0, SWING[0]) * 0.8 * drift
        p0.lerp(p1, w)
        t0.lerp(t1, w)
        p0.y += Math.sin(Math.PI * w) * 0.4 * drift
      } else {
        // bay to bay over q ∈ [i + 0.86, i + 1.12]
        const t = qq - 0.86
        const n = Math.floor(t)
        const w = ease.inOutCubic(clamp((t - n) / 0.26))
        const k0 = clamp(n, 0, N - 1)
        const k1 = clamp(n + 1, 0, N - 1)
        bubblePose(k0, push(k0, qq), p0, t0, drift)
        if (k1 !== k0 && w > 0) {
          bubblePose(k1, push(k1, qq), p1, t1, drift)
          p0.lerp(p1, w)
          t0.lerp(t1, w)
          // a small dolly back mid-move: the next bay swings into view
          p0.z += Math.sin(Math.PI * w) * 1.4 * drift
          p0.y += Math.sin(Math.PI * w) * 0.2 * drift
        }
      }
      out.fov = fov
      out.parallax = 0.14
    },
  }
}

const _p1 = new THREE.Vector3()
const _t1 = new THREE.Vector3()
