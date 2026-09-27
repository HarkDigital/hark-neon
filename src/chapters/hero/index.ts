import * as THREE from 'three'
import type { CameraPose, Chapter, Frame } from '../../core/types'
import { el, reveal, rise, setRise } from '../../core/dom'
import { BRAND, MICROCOPY } from '../../content'
import { clamp, ease, lerp, segment, smoothstep } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { whenRevealed } from '../../kit/images'
import { markStrokes, neonFromStrokes, neonSpill, neonText, Striker, textStrokes, TUBE, type NeonPart } from '../../kit/neon'
import { backerPanel, brickMaterial, concreteMaterial, fluorescentFixture, initAreaLights, steelMaterial } from '../../kit/shop'
import type { Stroke } from '../../kit/type'
import { arrowOutline, floorStreak, roundedFrame, strokeBounds, swash } from './shapes'
import './hero.css'

/*
 * HERO · "Lights On" — the shop's front room at night.
 *
 *   0.00–0.13  landing: the h1 "Make the internet listen." (it strikes on
 *              after the loader), the manifesto and the scroll hint; bare
 *              fluorescents light the brick and the sealed floor; the Hark
 *              mark hangs on its black acrylic backer in unlit grey glass;
 *              only the red OPEN is on. Copy left (phones: top + bottom band).
 *   0.16–0.49  neon on: the camera dollies in; the mark's three tubes strike
 *              one by one, then the colour signs ("listen." writes itself
 *              under the mark); at LIGHTS_OUT the fluorescents go out.
 *   0.57–0.935 payoff: the lit wall framed right (portrait: above the panel);
 *              the locale line + the two CTAs.
 *   0.93–1.00  out: push into the mark (bright tubes for the lights-out cut).
 *
 * Framing is computed, not hand-posed: every camera pose fits the sign
 * cluster's world bounds into the part of the screen the copy leaves free
 * (measured from the DOM once a second), so every sign stays whole at any
 * aspect. Everything derives from `local`; Strikers are the only time-based
 * state (settle ≤ 0.5 s).
 *
 * Lights (count fixed per device): the fluorescent over the mark, the one
 * over the colour signs (desktop only) and the mark's halo between backer and
 * brick — 3 on desktop, 2 on phones. The signs' light on the concrete is
 * additive floor planes (floorStreak) that follow each tube's level.
 *
 * The hero publishes where its mark sits on the landing frame (local 0) as
 * CSS vars on <html> so the loader can hand its emblem over onto it:
 *   --hark-mark-x, --hark-mark-y  centre of the mark's SVG viewBox, CSS px
 *   --hark-mark-size              side of that (square) viewBox, CSS px
 * i.e. an <svg viewBox="0 0 1889.6 1889.9"> sized size×size and centred on
 * (x, y) lies on the hero's tubes.
 */

const WALL_Z = -0.6
const FLOOR_Y = -2.2
/** the backer's standoffs: its face sits this far off the brick */
const STANDOFF = 0.2
/** the plane the framing math works in (between the wall signs and the backer face) */
const SIGN_Z = WALL_Z + STANDOFF
/** local where the fluorescents go out: neon only after this */
const LIGHTS_OUT = 0.49
/** fluorescent RectAreaLight intensity at full level */
const FLUO_I = 150
/** the mark's white HDR (white blooms ~3x harder than colour) */
const MARK_HDR = 1.7
/** the mark SVG viewBox height, in world units (markStrokes(MARK_H)) */
const MARK_H = 2.05
/** "listen." writes itself across this local range */
const WRITE_A = 0.34
const WRITE_B = 0.42
/** the landing copy holds (settled) until INTRO_HOLD, gone by INTRO_OUT */
const INTRO_HOLD = 0.13
const INTRO_OUT = 0.18
/** the payoff copy fades in over PAY_A..PAY_B, out over PAY_C..PAY_D */
const PAY_A = 0.57
const PAY_B = 0.63
const PAY_C = 0.935
const PAY_D = 0.965

type SignId = 'mark' | 'open' | 'arrow' | 'word'
type Place = { x: number; y: number; s?: number; rot?: number }
type Box = { x0: number; x1: number; y0: number; y1: number }

/**
 * Landscape: the mark over "listen." (a lockup), OPEN and the amber arrow in
 * a column to its right. The left of the frame stays dark brick for the copy.
 */
const LAYOUT_L: Record<SignId, Place> = {
  mark: { x: 0, y: 0.8 },
  open: { x: 3.3, y: 1.75, s: 0.86 },
  arrow: { x: 3.25, y: 0.35, s: 0.9 },
  word: { x: 0.05, y: -1.36, s: 0.9 },
}
/** Portrait: a narrow frame — OPEN and the arrow above the mark, "listen." below. */
const LAYOUT_P: Record<SignId, Place> = {
  mark: { x: 0, y: 0.8 },
  open: { x: -0.95, y: 3.08, s: 0.8 },
  arrow: { x: 1.25, y: 3.08, s: 0.72, rot: Math.PI / 2 },
  word: { x: 0.05, y: -1.36, s: 0.84 },
}
/** fixtures per orientation: x, drop height (portrait hangs the first one above OPEN) */
const FIX_L = [
  { x: 0.05, y: 3.05 },
  { x: 3.3, y: 3.05 },
  { x: -3.9, y: 3.9 },
]
const FIX_P = [
  { x: 0.05, y: 4.05 },
  // off to the sides: out of a tablet's frame too
  { x: 6.6, y: 3.05 },
  { x: -5.4, y: 3.9 },
]
/** where the drop rods meet the (unseen) ceiling */
const CEILING_Y = 7.2

type Pose = { p: THREE.Vector3; t: THREE.Vector3; fov: number }
const pose = (fov = 40): Pose => ({ p: new THREE.Vector3(), t: new THREE.Vector3(), fov })

interface Tube {
  part: NeonPart
  s: Striker
  /** should this tube be lit at this local / seconds since the reveal? */
  on(local: number, since: number): boolean
  /** optional: how much of the tube is lit along its length (the word writing itself) */
  draw?(local: number): number
}

type Level = { setLevel(v: number): void }
type Streak = ReturnType<typeof floorStreak>

const easeSine = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * t)

/** index of the i's dot in a word's strokes: the short stroke that isn't the last one */
function dotOfI(strokes: Stroke[]) {
  for (let i = 0; i < strokes.length - 1; i++) if (strokes[i].pts.length <= 3) return i
  return -1
}

/**
 * Fit a world box (on the SIGN_Z plane) into a screen rectangle given in
 * fractions (u: 0 left → 1 right, v: 0 top → 1 bottom). The camera looks
 * straight at the wall from `dist ≥ dMin`, offset by (dx, dy) for a little
 * perspective. Writes into `out`.
 */
function fitBox(out: Pose, b: Box, u0: number, u1: number, v0: number, v1: number, aspect: number, fov: number, dMin: number, dx: number, dy: number) {
  const t = Math.tan((fov * Math.PI) / 360)
  const dw = (b.x1 - b.x0) / (Math.max(0.08, u1 - u0) * 2 * t * aspect)
  const dh = (b.y1 - b.y0) / (Math.max(0.08, v1 - v0) * 2 * t)
  const d = Math.max(dMin, dw, dh)
  const wv = 2 * d * t * aspect
  const hv = 2 * d * t
  const tx = (b.x0 + b.x1) / 2 - ((u0 + u1) / 2 - 0.5) * wv
  const ty = (b.y0 + b.y1) / 2 + ((v0 + v1) / 2 - 0.5) * hv
  out.t.set(tx, ty, SIGN_Z)
  out.p.set(tx + dx, ty + dy, SIGN_Z + d)
  out.fov = fov
  return out
}

export default function create(): Chapter {
  const group = new THREE.Group()
  const signs = {} as Record<SignId, THREE.Group>
  /** each sign's own bounds (unscaled, unrotated), for the framing */
  const signBox = {} as Record<SignId, Box>
  const tubes: Tube[] = []
  const mark: NeonPart[] = []
  /** the mark SVG viewBox centre relative to the sign's origin (the strokes are re-centred on their bounds) */
  const viewBoxAt = new THREE.Vector2()
  let word: NeonPart
  let wordFx: Level[] = []
  let backerW = 3
  let backerH = 3
  const fixtures: { fx: ReturnType<typeof fluorescentFixture>; s: Striker; delay: number; streak: number }[] = []
  let rods: THREE.InstancedMesh
  /**
   * floor streaks: each starts at a point on the floor (x from its sign or
   * fixture, z0 out from the wall) and smears toward the camera, re-aimed
   * every frame — a reflection always points at the viewer
   */
  const streaks: { mesh: Streak; id: SignId | null; x: number; z0: number; len: number; bx: number; sx: number }[] = []
  let markStreak: Streak
  let halo: THREE.RectAreaLight
  let portrait: boolean | null = null
  let revealAt = -1
  let busy = true

  let stage: HTMLElement
  let intro: HTMLElement
  let head: HTMLElement
  let foot: HTMLElement
  let payoff: HTMLElement
  let payInner: HTMLElement
  let title: HTMLElement

  /**
   * The free screen space the copy leaves, in CSS px, measured from the DOM
   * (offsets, so the reveal transforms don't count). Landscape: the right
   * edge of the landing copy / the payoff copy. Portrait: the bottom of the
   * landing title plate, the top of the manifesto plate, the top of the
   * payoff plate. Plus the chrome bands.
   */
  const lay = { w: 0, h: 0, at: -1, safeT: 96, safeB: 804, landR: 560, payR: 420, headB: 260, footT: 600, payT: 560 }
  const P = {
    land: pose(),
    near: pose(),
    pay: pose(),
    pay2: pose(),
    out: pose(),
  }
  let posesKey = ''
  let markKey = ''

  // world tints: fluorescent (cool daylight) → neon only (plum + pink)
  const C = {
    glowCool: new THREE.Color('#9fb6ff'),
    glowNeon: new THREE.Color(TUBE.pink),
    fogCool: new THREE.Color('#0b0d13'),
    fogNeon: new THREE.Color('#0c0610'),
    moteCool: new THREE.Color('#e4ecff'),
    moteNeon: new THREE.Color('#ffc2e0'),
  }
  const glow = new THREE.Color()
  const fog = new THREE.Color()
  const mote = new THREE.Color()

  /** place every sign (and the light and streaks that belong to it) for this orientation */
  function applyLayout(p: boolean) {
    portrait = p
    posesKey = ''
    const L = p ? LAYOUT_P : LAYOUT_L
    for (const id of Object.keys(signs) as SignId[]) {
      const g = signs[id]
      const at = L[id]
      g.position.x = at.x
      g.position.y = at.y
      g.scale.setScalar(at.s ?? 1)
      g.rotation.z = at.rot ?? 0
    }
    // fixtures (and their drop rods and floor streaks) hang at this orientation's spots
    const F = p ? FIX_P : FIX_L
    const mtx = new THREE.Matrix4()
    fixtures.forEach((f, i) => {
      const g = f.fx.group
      g.position.x = F[i].x
      g.position.y = F[i].y
      const len = CEILING_Y - (F[i].y + 0.07)
      for (const sx of [-1, 1]) {
        mtx.makeScale(1, len, 1).setPosition(g.position.x + sx * 0.6, F[i].y + 0.07 + len / 2, g.position.z)
        rods.setMatrixAt(i * 2 + (sx < 0 ? 0 : 1), mtx)
      }
      streaks[f.streak].bx = F[i].x
    })
    rods.instanceMatrix.needsUpdate = true
    for (const st of streaks) {
      if (!st.id) continue
      const at = L[st.id]
      const s = at.s ?? 1
      // a rotated (vertical) sign throws a narrow streak
      st.sx = at.rot ? s * 0.45 : s
      st.bx = at.x + st.x * s
    }
    const m = L.mark
    const face = WALL_Z + STANDOFF + 0.012
    // halo: between the backer and the brick, facing the wall (never in front of the acrylic)
    halo.position.set(m.x, m.y, face - 0.05)
    halo.lookAt(m.x, m.y, WALL_Z - 4)
  }

  /** the union of the signs' bounds in this layout (world, on the wall), padded for the glow */
  function cluster(L: Record<SignId, Place>, pad = 0.22): Box {
    const out: Box = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity }
    for (const id of Object.keys(L) as SignId[]) {
      const b = signBox[id]
      if (!b) continue
      const at = L[id]
      const s = at.s ?? 1
      const c = Math.cos(at.rot ?? 0)
      const sn = Math.sin(at.rot ?? 0)
      for (const [x, y] of [
        [b.x0, b.y0],
        [b.x1, b.y0],
        [b.x0, b.y1],
        [b.x1, b.y1],
      ]) {
        const wx = at.x + s * (x * c - y * sn)
        const wy = at.y + s * (x * sn + y * c)
        out.x0 = Math.min(out.x0, wx)
        out.x1 = Math.max(out.x1, wx)
        out.y0 = Math.min(out.y0, wy)
        out.y1 = Math.max(out.y1, wy)
      }
    }
    out.x0 -= pad
    out.x1 += pad
    out.y0 -= pad
    out.y1 += pad
    return out
  }

  /** offset box of a node relative to the stage (layout only: transforms don't count) */
  function offsetBox(n: HTMLElement) {
    let x = 0
    let y = 0
    for (let e: HTMLElement | null = n; e && e !== stage && e !== document.body; e = e.offsetParent as HTMLElement | null) {
      x += e.offsetLeft
      y += e.offsetTop
    }
    return { l: x, t: y, r: x + n.offsetWidth, b: y + n.offsetHeight }
  }

  /** read the copy's layout (cheap; once a second and on resize) */
  function measure(frame: Frame) {
    lay.w = frame.width
    lay.h = frame.height
    lay.at = performance.now()
    if (!intro || !intro.offsetParent) return
    // .hr-intro spans the space between the chrome bands in every layout
    const pb = offsetBox(intro)
    if (pb.b - pb.t > 40) {
      lay.safeT = pb.t
      lay.safeB = pb.b
    }
    // the right edge of what's actually written (words, not the column box)
    let r = 0
    for (const w of title.querySelectorAll<HTMLElement>('.rise-w')) r = Math.max(r, offsetBox(w).r)
    for (const c of [head.firstElementChild, foot.firstElementChild, foot.lastElementChild] as HTMLElement[]) {
      if (c && getComputedStyle(c).display !== 'none') r = Math.max(r, offsetBox(c).r)
    }
    if (r > 0) lay.landR = r
    let pr = 0
    for (const c of payInner.children) pr = Math.max(pr, offsetBox(c as HTMLElement).r)
    if (pr > 0) lay.payR = pr
    lay.headB = offsetBox(head).b
    lay.footT = offsetBox(foot).t
    lay.payT = offsetBox(payInner).t
  }

  /** the five camera poses for this viewport and copy layout */
  function poses(frame: Frame) {
    const w = Math.max(1, frame.width)
    const h = Math.max(1, frame.height)
    const key = `${w}x${h}:${lay.safeT}:${lay.safeB}:${lay.landR}:${lay.payR}:${lay.headB}:${lay.footT}:${lay.payT}:${portrait}`
    if (key === posesKey) return P
    posesKey = key
    const a = w / h
    const vT = lay.safeT / h
    const vB = lay.safeB / h
    const m = (portrait ? LAYOUT_P : LAYOUT_L).mark
    if (!portrait) {
      const all = cluster(LAYOUT_L)
      // landing: the dark wall right of the copy, from across the room
      fitBox(P.land, all, Math.min(0.62, lay.landR / w + 0.035), 0.955, vT + 0.03, vB - 0.03, a, 42, 12.2, 1.6, 0)
      // ignition: a dolly straight in — the wall keeps its place right of centre
      // (a lit sign sweeping across the frame reads as flashing, block by block)
      fitBox(P.near, all, Math.min(0.5, Math.max(0.3, lay.payR / w + 0.04)), 0.965, vT + 0.02, vB - 0.02, a, 41, 7.4, 0.9, 0.3)
      // payoff: the lit wall right of the CTAs, a little from above (the floor streaks)
      fitBox(P.pay, all, Math.min(0.55, lay.payR / w + 0.05), 0.965, vT + 0.02, vB - 0.02, a, 40, 7.4, 0.2, 0.9)
      P.out.t.set(m.x, m.y, SIGN_Z)
      P.out.p.set(m.x, m.y + 0.05, SIGN_Z + 5.1)
      P.out.fov = 38
    } else {
      const all = cluster(LAYOUT_P)
      // the landing also frames the lit fixture over OPEN (clear of the title plate)
      const lit = { ...all, y1: Math.max(all.y1, FIX_P[0].y + 0.16) }
      fitBox(P.land, lit, 0.05, 0.95, lay.headB / h + 0.015, lay.footT / h - 0.02, a, 52, 10, 0.1, -0.2)
      fitBox(P.near, all, 0.05, 0.95, vT + 0.02, vB - 0.02, a, 51, 9, 0, 0)
      fitBox(P.pay, all, 0.05, 0.95, vT + 0.015, lay.payT / h - 0.025, a, 50, 8.4, 0, 0.35)
      P.out.t.set(m.x, m.y + 0.1, SIGN_Z)
      P.out.p.set(m.x, m.y + 0.2, SIGN_Z + 6.6)
      P.out.fov = 44
    }
    // the payoff's slow push: 4% closer by the end of the hold
    P.pay2.t.copy(P.pay.t)
    P.pay2.p.lerpVectors(P.pay.p, P.pay.t, 0.04)
    P.pay2.fov = P.pay.fov
    return P
  }

  /** a pose along the story (no allocation) */
  function poseAt(local: number, K: typeof P, out: CameraPose) {
    let a: Pose
    let b: Pose
    let k: number
    if (local < 0.5) {
      a = K.land
      b = K.near
      k = easeSine(segment(local, 0.02, 0.5))
    } else if (local < 0.63) {
      a = K.near
      b = K.pay
      k = ease.inOutCubic(segment(local, 0.5, 0.63))
    } else if (local < 0.92) {
      a = K.pay
      b = K.pay2
      k = segment(local, 0.63, 0.92)
    } else {
      a = K.pay2
      b = K.out
      k = easeSine(segment(local, 0.92, 1))
    }
    out.position.lerpVectors(a.p, b.p, k)
    out.target.lerpVectors(a.t, b.t, k)
    out.fov = lerp(a.fov, b.fov, k)
  }

  // the landing frame's camera, rebuilt off-screen to publish the mark's rect
  const probeCam = new THREE.PerspectiveCamera(40, 1, 0.1, 100)
  const probePose: CameraPose = { position: new THREE.Vector3(), target: new THREE.Vector3(), fov: 40, roll: 0, parallax: 0 }
  const pv = new THREE.Vector3()
  function publishMark(frame: Frame) {
    const K = poses(frame)
    if (markKey === posesKey) return
    markKey = posesKey
    const w = frame.width
    const h = frame.height
    poseAt(0, K, probePose)
    probeCam.fov = probePose.fov
    probeCam.aspect = w / Math.max(1, h)
    probeCam.updateProjectionMatrix()
    probeCam.position.copy(probePose.position)
    probeCam.lookAt(probePose.target)
    probeCam.updateMatrixWorld()
    const m = (portrait ? LAYOUT_P : LAYOUT_L).mark
    const cx = m.x + viewBoxAt.x
    const cy = m.y + viewBoxAt.y
    const cz = WALL_Z + STANDOFF + 0.012 + 0.06
    const px = (x: number, y: number) => {
      pv.set(x, y, cz).project(probeCam)
      return [(pv.x * 0.5 + 0.5) * w, (0.5 - pv.y * 0.5) * h]
    }
    const [sx, sy] = px(cx, cy)
    const [lx] = px(cx - MARK_H / 2, cy)
    const [rx] = px(cx + MARK_H / 2, cy)
    const [, ty] = px(cx, cy + MARK_H / 2)
    const [, by] = px(cx, cy - MARK_H / 2)
    const size = ((rx - lx) + (by - ty)) / 2
    const st = document.documentElement.style
    st.setProperty('--hark-mark-x', `${sx.toFixed(1)}px`)
    st.setProperty('--hark-mark-y', `${sy.toFixed(1)}px`)
    st.setProperty('--hark-mark-size', `${size.toFixed(1)}px`)
  }

  const onWall = (id: SignId) => {
    const g = new THREE.Group()
    g.position.z = WALL_Z
    group.add(g)
    signs[id] = g
    return g
  }

  const addStreak = (id: SignId | null, strokes: Stroke[], color: string, width: number, o: { x?: number; z0?: number; len?: number; strength?: number; falloff?: number; seed?: number } = {}) => {
    const len = o.len ?? 4.5
    const mesh = floorStreak(strokes, { color, width, length: len, strength: o.strength ?? 0.4, falloff: o.falloff, seed: o.seed })
    group.add(mesh)
    const x = o.x ?? 0
    streaks.push({ mesh, id, x, z0: o.z0 ?? 0.03, len, bx: x, sx: 1 })
    return mesh
  }
  const aim = (cam: THREE.Vector3) => {
    for (const st of streaks) {
      if (!st.mesh.visible) continue
      const bz = WALL_Z + st.z0
      let dx = st.bx - cam.x
      let dz = bz - cam.z
      const d = Math.hypot(dx, dz) || 1
      dx /= d
      dz /= d
      st.mesh.rotation.set(-Math.PI / 2, 0, Math.atan2(-dx, -dz))
      st.mesh.scale.set(st.sx, 1, 1)
      st.mesh.position.set(st.bx - (dx * st.len) / 2, FLOOR_Y + 0.004, bz - (dz * st.len) / 2)
    }
  }
  const boxOf = (strokes: Stroke[]): Box => {
    const b = strokeBounds(strokes)
    return { x0: b.min.x, x1: b.max.x, y0: b.min.y, y1: b.max.y }
  }

  return {
    id: 'hero',
    group,
    // the CTAs (sr copy item 0): the settled payoff
    anchors: [0.75],
    busy: () => busy,
    async init(ctx) {
      const radial = ctx.mobile ? 6 : 8
      stage = ctx.stage
      initAreaLights()
      whenRevealed().then(() => (revealAt = performance.now() / 1000))

      // ---------------------------------------------------------------- room
      // wide enough that no aspect up to ~2.6:1 sees past the set's ends
      const WALL_W = 38
      const WALL_H = 10
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(WALL_W, WALL_H), brickMaterial({ width: WALL_W, height: WALL_H, tint: '#2a1f27' }))
      wall.position.set(0, FLOOR_Y + WALL_H / 2, WALL_Z)
      group.add(wall)
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(44, 26), concreteMaterial({ width: 44, depth: 26, color: '#2d292f', roughness: 0.42 }))
      floor.rotation.x = -Math.PI / 2
      floor.position.set(0, FLOOR_Y, WALL_Z + 13)
      group.add(floor)
      // a painted skirting where brick meets concrete (a crisp base line)
      const skirt = new THREE.Mesh(new THREE.BoxGeometry(WALL_W, 0.14, 0.03), new THREE.MeshStandardMaterial({ color: 0x0b090c, roughness: 0.5 }))
      skirt.position.set(0, FLOOR_Y + 0.07, WALL_Z + 0.015)
      group.add(skirt)

      // bare fluorescent fixtures on drop rods. Two hang in frame (over the
      // mark and over the colour signs); the third is overhead, out of shot,
      // its reflection lighting the concrete in the foreground. Only the one
      // over the mark (and, on desktop, the one over the colour signs) carries
      // a RectAreaLight: the budget is ≤ 3 lights (≤ 2 on phones).
      const FIX = [
        { z: 0.55, delay: 0.25, stutters: 1 as const, tilt: 0.3, light: true },
        { z: 0.55, delay: 0.6, stutters: 0 as const, tilt: 0.3, light: !ctx.mobile },
        { z: 4.2, delay: 0.8, stutters: 0 as const, tilt: 0, light: false },
      ]
      const rodGeo = new THREE.CylinderGeometry(0.008, 0.008, 1, 6)
      // instanced: its own material (the fixtures' end caps draw steelMaterial() as plain meshes)
      rods = new THREE.InstancedMesh(rodGeo, steelMaterial().clone(), FIX.length * 2)
      rods.frustumCulled = false
      FIX.forEach((f, i) => {
        const fx = fluorescentFixture(1.7, { intensity: FLUO_I, light: f.light })
        fx.group.position.set(FIX_L[i].x, FIX_L[i].y, f.z)
        fx.part.setHdr(2.3)
        if (fx.light) {
          // the diffuser's width, tipped a little toward the brick: a wash down the wall
          fx.light.height = 0.24
          fx.light.rotation.x = -Math.PI / 2 + f.tilt
        }
        group.add(fx.group)
        // the tube's long reflection down the sealed concrete
        const line = [{ pts: [new THREE.Vector3(-0.85, 0, 0), new THREE.Vector3(0.85, 0, 0)] }]
        fx.part.follow(addStreak(null, line, '#dfe8ff', 2.6, { x: FIX_L[i].x, z0: f.z - WALL_Z, len: 7, strength: 0.3, falloff: 2.2, seed: 11 + i }))
        fixtures.push({ fx, s: new Striker({ stutters: f.stutters, depth: 0.5, off: 0.3, ramp: 0.25 }), delay: f.delay, streak: streaks.length - 1 })
      })
      group.add(rods)
      await nextFrame()

      // ---------------------------------------------------------------- the mark
      const ms = markStrokes(MARK_H, 0)
      const all = [...ms.loopA, ...ms.loopB, ...ms.diamond]
      const mb = strokeBounds(all)
      const mc = mb.getCenter(new THREE.Vector2())
      for (const s of all) for (const p of s.pts) p.set(p.x - mc.x, p.y - mc.y, 0)
      // markStrokes centres the SVG viewBox on the origin; after re-centring on the bounds it sits here
      viewBoxAt.set(-mc.x, -mc.y)
      const msz = mb.getSize(new THREE.Vector2())
      backerW = msz.x + 1.15
      backerH = msz.y + 1.0
      signBox.mark = { x0: -backerW / 2, x1: backerW / 2, y0: -backerH / 2, y1: backerH / 2 }
      const markSign = onWall('mark')
      markSign.position.z = WALL_Z + STANDOFF + 0.012
      markSign.add(backerPanel(backerW, backerH, { standoff: STANDOFF }))
      const thresholds = [0.16, 0.22, 0.28]
      ;(['loopA', 'loopB', 'diamond'] as const).forEach((key, i) => {
        const part = neonFromStrokes(ms[key], { color: 'white', radius: 0.016, hdr: MARK_HDR, radial })
        part.group.position.z = 0.06
        markSign.add(part.group)
        const sp = neonSpill(ms[key], { color: '#ffe2ee', width: backerW - 0.03, height: backerH - 0.03, blur: 0.16, strength: 0.06 })
        sp.position.z = 0.002
        markSign.add(sp)
        part.follow(sp)
        mark.push(part)
        const at = thresholds[i]
        tubes.push({ part, s: new Striker({ stutters: 1 }), on: l => l >= at })
      })
      markStreak = addStreak('mark', all, '#fff0f6', backerW, { strength: 0.2, len: 5, falloff: 2.6, seed: 3 })
      await nextFrame()

      // ---------------------------------------------------------------- colour signs
      // OPEN: red letters in a UV-violet frame — the one sign already on when the shop opens
      {
        const g = onWall('open')
        const { part, text } = neonText('OPEN', { font: 'sans', size: 0.44, tracking: 0.2 }, { color: 'red', hdr: 4.3, radial })
        part.group.position.z = 0.075
        g.add(part.group)
        const fw = text.width + 0.66
        const fh = 0.44 + 0.46
        signBox.open = { x0: -fw / 2, x1: fw / 2, y0: -fh / 2, y1: fh / 2 }
        const frameStroke = roundedFrame(fw, fh, 0.14)
        const fr = neonFromStrokes([frameStroke], { color: 'violet', radius: 0.016, hdr: 4.4, smooth: false, radial })
        fr.group.position.z = 0.075
        g.add(fr.group)
        const sp = neonSpill(text.strokes, { color: 'red', width: fw + 1.1, height: fh + 1.0, blur: 0.12, strength: 0.55, res: 192 })
        sp.position.z = 0.004
        g.add(sp)
        part.follow(sp)
        const fsp = neonSpill([frameStroke], { color: 'violet', width: fw + 1.1, height: fh + 1.0, blur: 0.12, strength: 0.5, res: 192 })
        fsp.position.z = 0.005
        g.add(fsp)
        fr.follow(fsp)
        // high on the wall: its reflection lands further out on the floor
        part.follow(addStreak('open', text.strokes, TUBE.red, fw + 0.4, { z0: 0.5, len: 4, strength: 0.12, falloff: 2.6, seed: 5 }))
        fr.follow(addStreak('open', [frameStroke], TUBE.violet, fw + 0.4, { z0: 0.5, len: 4, strength: 0.08, falloff: 2.6, seed: 6 }))
        // strikes a beat after the fluorescents; on for the whole landing
        tubes.push({ part, s: new Striker({ stutters: 1 }), on: (_l, since) => since >= 1.35 })
        tubes.push({ part: fr, s: new Striker({ stutters: 1 }), on: l => l >= 0.415 })
      }
      // an amber arrow pointing at the mark
      {
        const g = onWall('arrow')
        const st = arrowOutline(1.4, 0.64, 0.22, 0.52, 0.05)
        signBox.arrow = boxOf([st])
        const part = neonFromStrokes([st], { color: 'amber', radius: 0.018, hdr: 4.2, smooth: false, radial })
        part.group.position.z = 0.075
        g.add(part.group)
        const sp = neonSpill([st], { color: 'amber', width: 2.5, height: 1.6, blur: 0.12, strength: 0.5, res: 192 })
        sp.position.z = 0.004
        g.add(sp)
        part.follow(sp)
        part.follow(addStreak('arrow', [st], TUBE.amber, 1.9, { z0: 0.3, len: 4, strength: 0.14, falloff: 2.8, seed: 7 }))
        tubes.push({ part, s: new Striker({ stutters: 1 }), on: l => l >= 0.32 })
      }
      await nextFrame()
      // "listen." in pink script (writes itself along its tube) over an argon-blue
      // swash — the h1's pink word, bent in glass under the mark
      {
        const g = onWall('word')
        const size = 0.62
        const text = textStrokes('listen.', { font: 'script', size })
        // the font's dots are 2-point dashes that vanish at this scale: bend
        // them as tight loops, the way a shop bends a dot
        for (const [k, r] of [
          [text.strokes.length - 1, 0.046],
          [dotOfI(text.strokes), 0.034],
        ] as const) {
          const st = text.strokes[k]
          if (!st || st.pts.length > 3) continue
          const c = st.pts[0].clone().lerp(st.pts[st.pts.length - 1], 0.5)
          st.pts = Array.from({ length: 14 }, (_, i) => {
            const a = (i / 14) * Math.PI * 2 - Math.PI / 2
            return new THREE.Vector3(c.x + Math.cos(a) * r, c.y + r * 0.4 + Math.sin(a) * r, 0)
          })
          st.closed = true
        }
        const part = neonFromStrokes(text.strokes, { color: 'pink', hdr: 4.4, radius: size / 28, radial })
        part.group.position.z = 0.075
        g.add(part.group)
        // the swash ends under the "n", clear of the full stop
        const sw = swash(-text.width / 2 + 0.1, text.width / 2 - 0.28, -0.5, 0.07, 0.14)
        const blue = neonFromStrokes([sw], { color: 'blue', radius: 0.019, hdr: 4.4, radial })
        blue.group.position.z = 0.075
        g.add(blue.group)
        signBox.word = boxOf([...text.strokes, sw])
        const psp = neonSpill([...text.strokes, sw], { color: 'pink', width: text.width + 1.3, height: text.height + 1.4, blur: 0.13, strength: 0.55, res: 192 })
        psp.position.z = 0.004
        g.add(psp)
        const bsp = neonSpill([sw], { color: 'blue', width: text.width + 1.3, height: text.height + 1.4, blur: 0.12, strength: 0.6, res: 192 })
        bsp.position.z = 0.005
        g.add(bsp)
        blue.follow(bsp)
        // the floor pools under the word are these additive streaks (no area lights)
        blue.follow(addStreak('word', [sw], TUBE.blue, text.width + 0.5, { strength: 0.42, len: 4.2, falloff: 3.2, seed: 9 }))
        // the pink word's light follows how much of it has been written
        wordFx = [psp, addStreak('word', text.strokes, TUBE.pink, text.width + 0.9, { strength: 0.62, len: 4.6, falloff: 2.9, seed: 8 })]
        word = part
        tubes.push({ part, s: new Striker({ stutters: 0, ramp: 0.12 }), on: l => l >= WRITE_A, draw: l => segment(l, WRITE_A, WRITE_B) })
        tubes.push({ part: blue, s: new Striker({ stutters: 1 }), on: l => l >= 0.44 })
      }

      // ---------------------------------------------------------------- the mark's light on the brick
      halo = new THREE.RectAreaLight(TUBE.white, 0, backerW - 0.5, backerH - 0.5)
      group.add(halo)
      applyLayout(false)

      // ---------------------------------------------------------------- DOM
      // landing: the eyebrow and the h1, then the manifesto and the scroll hint
      // (landscape: one column; portrait: a title plate on top, the rest at the bottom)
      intro = el('div', 'hr-intro', undefined, ctx.stage)
      const introInner = el('div', 'hr-intro-inner', undefined, intro)
      head = el('div', 'hr-intro-head', undefined, introInner)
      const eyebrow = el('p', 'hud-eyebrow hr-eyebrow', undefined, head)
      // wrap only between the phrases (never "… · OPEN / LATE"-style orphans)
      const eb = el('span', 'hr-eyebrow-text', undefined, eyebrow)
      MICROCOPY.signalEyebrow.split(' · ').forEach((part, i) => {
        if (i) eb.append(' · ')
        el('span', 'hr-nowrap', part, eb)
      })
      title = rise(el('h1', 'hud-title hr-title', undefined, head), BRAND.tagline.replace(/(\S+)$/, '<em>$1</em>'))
      foot = el('div', 'hr-intro-foot', undefined, introInner)
      el('p', 'hud-body hr-manifesto', BRAND.manifesto, foot)
      el('p', 'hud-label hr-hint', MICROCOPY.scrollHint + ' ↓', foot)

      // payoff: the lit wall is the headline; the locale line and the two CTAs
      payoff = el('div', 'hr-payoff', undefined, ctx.stage)
      payInner = el('div', 'hr-payoff-inner', undefined, payoff)
      const loc = el('span', 'hr-eyebrow-text', undefined, el('p', 'hud-eyebrow hr-locale', undefined, payInner))
      BRAND.locale.split(' · ').forEach((part, i) => {
        if (i) loc.append(' · ')
        el('span', 'hr-nowrap', part, loc)
      })
      const ctas = el('div', 'hr-ctas', undefined, payInner)
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
      // the same test as the CSS (max-aspect-ratio: 1/1): a square frame is portrait
      const p = frame.height >= frame.width
      if (p !== portrait) applyLayout(p)
      if (frame.width !== lay.w || frame.height !== lay.h || performance.now() - lay.at > 1000) measure(frame)
      publishMark(frame)
      // calm: no stutters (reduced motion, Motion off, or a fast scroll — ramps
      // only). Before the reveal the engine's prewarm drives update() at other
      // locals: never spend the site-wide flash budget on strikes nobody sees.
      const since = revealAt < 0 ? -1 : performance.now() / 1000 - revealAt
      const calm = ctx.reducedMotion || !!frame.still || Math.abs(frame.velocity) > 2.5 || since < 0
      let settled = true

      // the room lights: struck once on reveal, one switch out at LIGHTS_OUT
      let fl = 0
      for (const f of fixtures) {
        const on = since >= f.delay && local < LIGHTS_OUT
        const v = f.s.update(on, frame.dt, calm)
        f.fx.setLevel(v)
        fl += v
        if (Math.abs(v - (on ? 1 : 0)) > 0.002) settled = false
      }
      fl /= fixtures.length

      for (const t of tubes) {
        const on = t.on(local, since)
        const v = t.s.update(on, frame.dt, calm)
        t.part.setLevel(v)
        if (t.draw) t.part.setDraw(ctx.reducedMotion ? 1 : t.draw(local))
        if (Math.abs(v - (on ? 1 : 0)) > 0.002) settled = false
      }
      busy = !settled || (since >= 0 && since < 1.8) || revealAt < 0

      // sign light on the room
      const mk = (mark[0].level + mark[1].level + mark[2].level) / 3
      markStreak.setLevel(mk)
      aim(ctx.camera.position)
      halo.intensity = mk * 7
      const written = word.level * (ctx.reducedMotion ? 1 : segment(local, WRITE_A, WRITE_B))
      for (const fx of wordFx) fx.setLevel(written)

      // the room's air: cool daylight under the fluorescents → plum and pink in neon
      const W = ctx.world.params
      const nl = Math.max(mk, written * 0.8)
      W.glow = lerp(0.2 + 0.3 * nl, 0.24, fl)
      W.glowColor = glow.copy(C.glowNeon).lerp(C.glowCool, fl)
      W.fog = lerp(0.03, 0.026, fl)
      W.fogColor = fog.copy(C.fogNeon).lerp(C.fogCool, fl)
      W.motes = lerp(0.5, 0.8, fl)
      W.moteColor = mote.copy(C.moteNeon).lerp(C.moteCool, fl)
      W.fill = lerp(0.09, 0.6, fl)
      W.env = lerp(0.6, 0.45, fl)
      // a tighter glow so the mark's double outlines stay two tubes, not one white slab
      const PP = ctx.post.params
      PP.bloomRadius = 0.2
      // the out-push: less glow as the mark grows in frame
      PP.bloomStrength = lerp(0.8, 0.5, segment(local, 0.92, 1))

      // copy: the h1 strikes on once the loader has gone (and again on the way back up)
      reveal(intro, 1 - smoothstep(INTRO_HOLD, INTRO_OUT, local))
      setRise(title, since > 0.12 && local < INTRO_OUT)
      reveal(payoff, smoothstep(PAY_A, PAY_B, local) * (1 - smoothstep(PAY_C, PAY_D, local)))
    },

    camera(local: number, frame: Frame, out: CameraPose) {
      poseAt(clamp(local), poses(frame), out)
      out.parallax = 0.22
    },
  }
}
