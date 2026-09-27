import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { Chapter, Frame } from '../../core/types'
import { el, rise, setRise, reveal } from '../../core/dom'
import { SECTIONS, TESTIMONIALS } from '../../content'
import { clamp, ease } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { StoryClock } from '../../kit/pace'
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
 *   0.00–0.16   intro: a wide, raking shot down the window, the whole chorus
 *               lit; eyebrow + "We listen. They talk." held ~0.4 vh clear
 *               of the cut (landing / intro 0.1)
 *   0.16–0.95   eight slots (beat(); anchors = centres), one quote each:
 *               the bubble strikes on in its colour, a slow push-in with a
 *               lateral drift holds while the quote reads INSIDE it
 *               (desktop), in a panel under it (portrait) or beside it
 *               (short landscape)
 *   0.95–1.00   out: the last bubble bright for the cut
 *
 * PACING (WCAG 2.3.1). A lit bubble nearly fills the frame, so it must never
 * travel across it: the scroll only says which bay it wants, and a small
 * time-based director does the rest — the lit bubble holds (≥ MIN_LIT), cuts
 * out, the camera WALKS the dark window to the wanted bay (an accelerating,
 * decelerating follower: ~0.6 s a bay, one longer walk after a fling, never a
 * stop at bays it passes), and the bubble there strikes as the camera
 * settles. One off/on pair per change, ≤ ~0.8 changes a second at any scroll
 * speed; reduced motion cuts in the dark instead of walking. The push-in and
 * the intro creep follow a StoryClock (kit/pace.ts).
 *
 * The glass: a faint dark pane with env sheen, each bubble's glow spilt on
 * it (neonSpill) and its reflection as a dim mirrored duplicate beyond it.
 * Lights (fixed, 2 RectAreaLights): one on the lit sign (a single bubble, or
 * a wide strip over the chorus — it only moves while everything is dark) and
 * the street's sodium glow.
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

// story (local): before A0 the chorus + headline, then one slot per quote
const A0 = 0.16
const A1 = 0.95
const SPAN = (A1 - A0) / N
/** a slot boundary must be crossed by this much (slot units) before the ask changes */
const HYST = 0.08

// pacing (seconds; see the header)
/** a bubble that has struck stays lit at least this long */
const MIN_LIT = 0.6
/** the chorus, and the headline over it, hold at least this long */
const MIN_LIT_CHORUS = 1.1
/** once the lights go out, nothing strikes for this long */
const MIN_OFF = 0.3
/** the camera may leave a bay once every tube is below this level */
const DARK = 0.05
/** the walk: acceleration (bays/s²) and top speed (bays/s); the swing off the wide shot runs at SWING_K of both */
const ACC = 12
const VMAX = 5
const SWING_K = 0.6
/** the bubble being walked to warms to this (below the bloom threshold: a ring this dim can cross the frame safely) */
const PILOT = 0.14
const NONE = -2

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
  let signLight: THREE.RectAreaLight, streetLight: THREE.RectAreaLight
  let street: ReturnType<typeof bokeh>
  let stage: HTMLElement, root: HTMLElement, probe: HTMLElement
  let intro: HTMLElement, introTitle: HTMLElement
  const figs: HTMLElement[] = []
  // composition extents round each bubble body centre (bubble top, plate bottom)
  let compTop = 1.2
  let compBot = 2
  // layout (per viewport): screen scale and where the body centre sits
  const L = {
    W: 0,
    H: 0,
    inside: true,
    side: false,
    ppu: new Array<number>(N).fill(200),
    bodyX: new Array<number>(N).fill(720),
    bodyY: new Array<number>(N).fill(400),
    dirty: true,
  }

  // ---- the director (time-based; snaps on teleports and on entering)
  // want: the bay the scroll asks for (-1 = the chorus); pos/vel: the camera's
  // bay coordinate (-1 = the wide shot) and speed; lit: the lit bay (NONE, -1
  // = the whole chorus) with the times it struck / went out
  const D = { init: false, last: 0, now: 0, want: -1, goal: -1, from: -1, pos: -1, vel: 0, lit: -1, litAt: -1e9, offAt: -1e9, landed: true, walkAt: -1e9 }
  // the push-ins and the intro creep follow a time-paced view of local
  const pace = new StoryClock({ rate: SPAN * 1.2 })
  let cl = 0
  let qc = -1
  const figV = new Array<number>(N).fill(0)
  let introV = 0
  let entering = true
  let settled = false

  /** the bay the scroll asks for, with hysteresis round the previous ask */
  function askFor(local: number, prev: number) {
    const x = (local - A0) / SPAN
    const raw = x < 0 ? -1 : Math.min(N - 1, Math.floor(x))
    if (prev < -1 || raw === prev) return raw
    const lo = prev < 0 ? -Infinity : prev
    const hi = prev < 0 ? 0 : prev >= N - 1 ? Infinity : prev + 1
    return x > lo - HYST && x < hi + HYST ? prev : raw
  }

  /** walk the camera toward a bay: accelerate, cruise, brake to land on it */
  function walk(target: number, dt: number) {
    const k = D.pos < 0 || target < 0 ? SWING_K : 1
    const acc = ACC * k
    const d = target - D.pos
    const vWant = clamp(Math.sign(d) * Math.sqrt(2 * acc * Math.abs(d)), -VMAX * k, VMAX * k)
    D.vel += clamp(vWant - D.vel, -acc * dt, acc * dt)
    const next = D.pos + D.vel * dt
    if ((target - next) * d <= 0 || Math.abs(target - next) < 1e-4) {
      D.pos = target
      D.vel = 0
    } else D.pos = next
  }

  /** the bubble the camera is walking to (or has landed on, waiting to strike): it warms to PILOT */
  function piloting() {
    return D.lit === NONE && D.goal >= 0 && (D.pos !== D.goal || D.landed) ? D.goal : NONE
  }

  function direct(local: number, dt: number, rm: boolean, moving: boolean) {
    D.now += dt
    const tele = !D.init || Math.abs(local - D.last) > 0.05
    D.last = local
    D.want = askFor(local, tele ? -3 : D.want)
    if (tele) {
      D.init = true
      D.pos = D.goal = D.from = D.want
      D.vel = 0
      D.litAt = D.offAt = -1e9
      D.landed = true
    }
    // (the pilot glow on the bubble being walked to doesn't count as lit)
    let maxL = 0
    const pilot = piloting()
    for (let i = 0; i < N; i++) if (i !== pilot) maxL = Math.max(maxL, bubbles[i].level)
    // commit a walk goal. A walk in progress only re-aims early on or to turn
    // back; otherwise it LANDS (and that bay strikes) before walking on — a
    // steady scroll never chases a moving target through an unlit window
    const dark = D.lit === NONE && maxL < DARK
    // while the page is still moving, a leg is short (off the wide shot it
    // lands on the first bubble, then ≤ 2 bays), so a steady scroll passes
    // lit quotes, not a long dark window; at rest it walks straight there
    const hi = moving ? (D.pos < 0 ? 0 : Math.round(D.pos) + 2) : N - 1
    const lo = moving ? (D.pos <= 0 ? -1 : Math.round(D.pos) - 2) : -1
    const aim = clamp(D.want, lo, hi)
    if (aim !== D.goal && dark) {
      const walking = D.pos !== D.goal
      const reverse = walking && Math.sign(aim - D.pos) !== Math.sign(D.goal - D.pos)
      if (!walking || reverse || D.now - D.walkAt < 0.25) {
        if (!walking || reverse) {
          D.from = D.pos
          D.walkAt = D.now
        }
        D.goal = aim
      }
    }
    // the camera only moves in the dark (reduced motion: a cut, no walk)
    if (D.pos !== D.goal && dark) {
      if (rm) {
        D.pos = D.goal
        D.vel = 0
      } else walk(D.goal, dt)
      if (D.pos === D.goal) D.landed = true
    } else D.vel = 0
    // a lit bay holds while asked for (and at least its minimum); a bay
    // strikes once the camera has landed on it, even if the scroll moved on
    const minLit = D.lit === -1 ? MIN_LIT_CHORUS : MIN_LIT
    let lit = NONE
    if (D.lit !== NONE && (D.lit === D.want || D.now - D.litAt < minLit)) lit = D.lit
    else if (D.lit === NONE && D.pos === D.goal && (D.landed || D.goal === D.want) && D.now - D.offAt >= MIN_OFF) lit = D.goal
    if (lit !== D.lit) {
      if (lit === NONE) {
        D.offAt = D.now
        D.landed = false
      } else D.litAt = D.now
      D.lit = lit
    }
  }

  function layout(fw: number, fh: number) {
    L.W = fw
    L.H = fh
    L.dirty = false
    // desktop: the quote inside its bubble; short landscape (phones sideways,
    // 200% zoom): the quote docked right, the bubble left; portrait: a panel under it
    const inside = fw >= 900 && fw / fh >= 1.15 && fh >= 560
    const side = !inside && fw / fh >= 1.2
    L.inside = inside
    L.side = side
    root.classList.toggle('vc-inside', inside)
    root.classList.toggle('vc-panel', !inside)
    root.classList.toggle('vc-side', side)
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
      L.bodyX.fill(fw / 2)
      L.bodyY.fill(bodyY)
    } else if (side) {
      // the bubble framed in the room left of the docked panel, between the bands
      const gut = (intro.getBoundingClientRect().left - sr.left) * scale
      figs.forEach((f, i) => {
        const left = (f.getBoundingClientRect().left - sr.left) * scale
        const room = left - gut - 8
        const ppu = Math.max(30, Math.min(room / 4.7, (bandBot - bandTop) / comp))
        L.ppu[i] = ppu
        L.bodyX[i] = gut + room / 2
        L.bodyY[i] = (bandTop + bandBot) / 2 - ((compBot - compTop) / 2) * ppu
      })
    } else {
      figs.forEach((f, i) => {
        const h = f.offsetHeight * scale
        const panelTop = bandBot + 6 - h
        const bb = panelTop - 14
        const ppu = Math.max(40, Math.min((fw * 0.9) / 4.9, (bb - bandTop) / comp))
        L.ppu[i] = ppu
        L.bodyX[i] = fw / 2
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
    const x = k * S + (L.W / 2 - L.bodyX[k]) / ppu
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
        const name = neonFromStrokes(nameStrokes, { color: sp.nameColor, radius: 0.0082, hdr: 3.8, radial, depth: 0.05, caps: false })
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

      // ---------------------------------------------------------------- lights (2, fixed)
      // the sign light: under the lit bubble, or a wide strip under the
      // chorus; it's only moved / resized while every tube is dark
      signLight = new THREE.RectAreaLight(0xffffff, 0, 4.2, 1.2)
      streetLight = new THREE.RectAreaLight(new THREE.Color('#ffa126'), 0, 26, 3)
      group.add(signLight, streetLight)

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
      D.init = false
      pace.reset()
      entering = true
    },

    busy() {
      return !settled
    },

    update(local, frame, ctx) {
      if (L.dirty || frame.width !== L.W || frame.height !== L.H) layout(frame.width, frame.height)
      const dt = frame.dt
      const rm = ctx.reducedMotion
      // calm: no stutters (reduced motion, Motion off, or while the page is
      // still moving — a bubble only STRIKES when the reader has come to rest)
      const calm = rm || !!frame.still || Math.abs(frame.velocity) > 0.2
      const instant = rm || !!frame.still
      cl = pace.update(local, dt)
      qc = (cl - A0) / SPAN
      direct(local, dt, rm, Math.abs(frame.velocity) > 0.2)
      const pilot = piloting()

      let maxL = 0
      let sumL = 0
      let hot = -1
      for (let i = 0; i < N; i++) {
        const b = bubbles[i]
        const on = D.lit === -1 || D.lit === i
        const warm = i === pilot ? PILOT * clamp(1.4 - Math.abs(D.pos - i)) : 0
        if (entering) b.striker.set(on ? 1 : 0)
        b.level = b.striker.update(on ? true : warm, dt, calm)
        b.outline.setLevel(b.level)
        b.open.setLevel(b.level)
        b.close.setLevel(b.level)
        // the name writes itself along its tube once the bubble has struck
        if (b.level < 0.05) b.draw = 0
        else if (b.level > 0.6) b.draw = instant || entering ? 1 : Math.min(1, b.draw + dt / 0.55)
        b.name.setLevel(b.level)
        b.name.setDraw(ease.outQuad(b.draw))
        const gl = b.level * 0.32
        b.ghostMat.opacity = gl
        // (no reflections for the chorus: a window of doubled tubes reads as noise)
        for (const g of b.ghosts) g.visible = gl > 0.004 && D.pos > -0.5
        ;(b.pool.material as THREE.MeshBasicMaterial).opacity = b.level * 0.45
        b.pool.visible = b.level > 0.004
        if (b.level > maxL) {
          maxL = b.level
          hot = i
        }
        sumL += b.level
      }
      // the sign light: a strip under the chorus, or under the one lit bubble
      // (they never overlap: the chorus goes dark before anything else strikes)
      const chorusAmt = clamp((sumL - maxL) / (N - 1))
      if (hot < 0) signLight.intensity = 0
      else if (chorusAmt > 0.02 || D.lit === -1) {
        signLight.color.set('#ff8fc6')
        signLight.width = 5 * S
        signLight.position.set(2 * S, Y_B - 0.6, Z_B + 0.3)
        signLight.lookAt(2 * S, FLOOR, Z_B + 3)
        signLight.intensity = (sumL / N) * 7
      } else {
        const sp = SPECS[hot]
        signLight.color.set(hex(sp.color))
        signLight.width = 4.2
        signLight.position.set(hot * S, Y_B - 0.55, Z_B + 0.2)
        signLight.lookAt(hot * S, FLOOR, Z_B + 2.6)
        signLight.intensity = maxL * (sp.color === 'white' ? 5 : 9)
      }

      // the camera's bay (also steers the street light and the haze colour)
      const bay = clamp(D.pos, 0, N - 1)
      const focusX = bay * S
      streetLight.position.set(focusX + 2, 6.5, -5)
      streetLight.lookAt(focusX + 2, -0.5, 2.5)
      streetLight.intensity = 1.6

      const active = D.lit >= 0 ? D.lit : Math.round(bay)
      const w = ctx.world.params
      w.top = '#07060e'
      w.bottom = '#0b0812'
      w.glow = 0.22
      w.glowColor = hex(SPECS[D.lit === -1 ? 0 : active].color)
      w.fog = 0.016
      w.fogColor = '#0a0812'
      w.motes = 0.3
      w.moteColor = hex(SPECS[D.lit === -1 ? 0 : active].color)
      w.env = 0.6
      w.fill = 0.14

      // ---------------------------------------------------------------- copy
      // the headline lives with the lit chorus; a quote with its lit bubble,
      // while the scroll still asks for it (paced by the director, not the scroll)
      const fin = dt / (instant ? 0.12 : 0.32)
      const fout = dt / 0.16
      const toward = (v: number, t: number) => (entering ? t : t > v ? Math.min(t, v + fin) : Math.max(t, v - fout))
      introV = toward(introV, D.lit === -1 ? 1 : 0)
      reveal(intro, ease.inOutQuad(introV))
      setRise(introTitle, D.lit === -1 && local > 0.012)
      let textVis = 0
      for (let i = 0; i < N; i++) {
        // (once the strike has settled, so a stutter never blinks the words)
        figV[i] = toward(figV[i], D.lit === i && D.want === i && (entering || D.now - D.litAt > 0.24) ? 1 : 0)
        reveal(figs[i], ease.inOutQuad(figV[i]), 0)
        textVis = Math.max(textVis, figV[i])
      }
      // stop down the street lights behind the words (desktop: inside the bubble)
      const k = Math.round(bay)
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

      const done = (v: number) => v === 0 || v === 1
      settled =
        !pace.busy &&
        D.pos === D.goal &&
        D.goal === D.want &&
        D.lit === D.want &&
        done(introV) &&
        figV.every(done) &&
        bubbles.every(b => done(b.level) && done(b.draw))
      entering = false
    },

    camera(local, frame: Frame, out) {
      if (!L.W) {
        L.W = frame.width
        L.H = frame.height
      }
      const p0 = out.position
      const t0 = out.target
      // reduced motion: no drift, no arcs (and no walks: the director cuts in the dark)
      const drift = frame.reducedMotion ? 0 : 1
      let fov = FOV
      if (D.pos < 0) {
        // the wide shot (-1) ⇄ bubble 1 (0): the swing
        const w = D.pos + 1
        fov = introPose(p0, t0)
        // a slow creep in the wide shot while the headline reads
        p0.x += clamp(cl / A0) * 0.8 * drift
        if (w > 0) {
          bubblePose(0, push(0, qc), _p1, _t1, drift)
          p0.lerp(_p1, w)
          t0.lerp(_t1, w)
          p0.y += Math.sin(Math.PI * w) * 0.4 * drift
          fov += (FOV - fov) * w
        }
      } else {
        const k0 = Math.min(N - 1, Math.floor(D.pos))
        const f = D.pos - k0
        bubblePose(k0, push(k0, qc), p0, t0, drift)
        if (f > 1e-5 && k0 < N - 1) {
          bubblePose(k0 + 1, push(k0 + 1, qc), _p1, _t1, drift)
          p0.lerp(_p1, f)
          t0.lerp(_t1, f)
        }
        // stepping back while walking the dark window: the next bays swing into view
        const back = Math.min(2.2, Math.abs(D.vel) * 0.5)
        p0.z += back
        p0.y += back * 0.14
      }
      out.fov = fov
      out.parallax = 0.14
    },
  }
}

const _p1 = new THREE.Vector3()
const _t1 = new THREE.Vector3()
