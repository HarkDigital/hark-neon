import * as THREE from 'three'
import type { Chapter, Frame } from '../../core/types'
import { el, rise, setRise, reveal } from '../../core/dom'
import { PROCESS, SECTIONS, STATS } from '../../content'
import { clamp, ease, lerp, segment, smoothstep, window01 } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { beat } from '../common'
import { neonFromStrokes, neonSpill, Striker, textStrokes, type NeonPart } from '../../kit/neon'
import type { Stroke } from '../../kit/type'
import { brickMaterial, concreteMaterial, fluorescentFixture, initAreaLights, tubeLight } from '../../kit/shop'
import { BendTube, circlePts, inkRibbon, paperTexture, patternPath, penMesh, ribbonFlames } from './bench'
import './process.css'

/*
 * PROCESS · THE BENCH — how a neon sign is actually made, as Hark's process.
 *
 * A steel-topped bending bench under one warm work light: a full-size paper
 * pattern, a ribbon burner (a row of small blue gas flames), a length of clear
 * glass, and the brick wall above it where finished pieces hang.
 *
 *   0.00–0.12  establishing; the intro headline (SECTIONS.process)
 *   0.14–0.30  01 Listen     — the pattern is sketched: ink runs along the word
 *   0.30–0.46  02 Prototype  — the pattern complete, checked in red pencil;
 *                              a straight clear tube slides in above it
 *   0.46–0.62  03 Build      — the tube is heated and bent to the pattern,
 *                              glowing orange where it's hot (low, across the flame)
 *   0.62–0.78  04 Support    — the finished piece strikes on in pink on the
 *                              bench, the light running along it, and stays lit
 *   0.80–0.96  the stats bent in argon on the wall, striking on in sequence
 *   0.96–1.00  everything lit for the cut
 *
 * Everything derives from `local`; frame.time only drives the flames' flicker.
 * Pattern space (the paper's plane: x right, y up the page, z out of the paper)
 * is laid flat on the bench by the `pat` group.
 */

const SHOW = [STATS[0], STATS[2], STATS[1]] // 10 years, $1M+, 15
const TAGS = ['The pattern · ink on paper, full size', 'Reversed · checked · glass cut to length', 'Ribbon burner · heat, bend, repeat', 'Burned in · lit · looked after']

const TOP = 0.92 // bench top (world y)
const PX = -0.2 // paper centre (world x, z)
const PZ = 0.0
const PAPER_W = 1.6
const PAPER_H = 0.9
const WORD = 0.4 // script size of the pattern word
const WORD_Y = -0.02 // pattern-space y of the word's centre
const NPTS = 300
const LS = 1.2 // the straight tube's length
const R_GLASS = 0.0115
const R_NEON = 0.0125
const BURNER_Z = 0.57
const BURNER_L = 1.26
const WALL_Z = -0.95
const STAT_S = 0.28
const STAT_GAP = 0.4
/** local ranges the marker / red pencil write over */
const MARKER = [0.15, 0.275]
const PENCIL = [0.325, 0.38]

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

// ------------------------------------------------------------------ camera keys

type Mode = 'head' | 'card' | 'stats'
interface Key {
  t: [number, number, number]
  yaw: number
  pitch: number
  w: number
  h: number
  mode: Mode
  /** portrait overrides */
  pt?: [number, number, number]
  pw?: number
  ph?: number
  pyaw?: number
  ppitch?: number
}
const K = {
  est0: { t: [0.3, 1.4, -0.2], yaw: -15, pitch: 11, w: 3.5, h: 2.6, mode: 'head', pt: [0.1, 1.2, -0.1], pw: 2.4, ph: 2.1 },
  est1: { t: [0.25, 1.1, -0.05], yaw: -9, pitch: 22, w: 2.9, h: 1.95, mode: 'head', pt: [0.1, 1.02, 0.02], pw: 2.0, ph: 1.5 },
  topA: { t: [PX, TOP, PZ + 0.02], yaw: 0, pitch: 64, w: 1.8, h: 1.02, mode: 'card', pw: 1.5, ph: 1.0 },
  topB: { t: [PX, TOP, PZ + 0.02], yaw: 3, pitch: 67, w: 1.7, h: 0.98, mode: 'card', pw: 1.42, ph: 0.95 },
  b2A: { t: [PX + 0.02, TOP, PZ - 0.03], yaw: -10, pitch: 52, w: 1.85, h: 1.0, mode: 'card', pw: 1.5, ph: 1.0 },
  b2B: { t: [PX + 0.02, TOP, PZ - 0.03], yaw: -14, pitch: 50, w: 1.75, h: 0.95, mode: 'card', pw: 1.45, ph: 0.95 },
  b3A: { t: [PX - 0.05, TOP + 0.03, PZ + 0.0], yaw: 28, pitch: 17, w: 1.55, h: 0.6, mode: 'card', pw: 1.2, ph: 0.75, ppitch: 24 },
  b3B: { t: [PX - 0.1, TOP + 0.03, PZ + 0.0], yaw: 22, pitch: 18, w: 1.45, h: 0.56, mode: 'card', pw: 1.15, ph: 0.72, ppitch: 25 },
  b4A: { t: [PX, TOP + 0.02, PZ], yaw: -22, pitch: 34, w: 1.8, h: 0.9, mode: 'card', pw: 1.45, ph: 0.95 },
  b4B: { t: [PX, TOP + 0.02, PZ], yaw: -16, pitch: 30, w: 1.7, h: 0.86, mode: 'card', pw: 1.4, ph: 0.9 },
  stA: { t: [0, 1.72, WALL_Z + 0.1], yaw: -4, pitch: 5, w: 4.4, h: 2.0, mode: 'stats', pt: [0, 1.96, WALL_Z + 0.1], pw: 1.75, ph: 1.95 },
  stB: { t: [0, 1.74, WALL_Z + 0.1], yaw: 2, pitch: 6, w: 4.2, h: 1.95, mode: 'stats', pt: [0, 1.96, WALL_Z + 0.1], pw: 1.7, ph: 1.9 },
  stC: { t: [0, 1.74, WALL_Z + 0.1], yaw: 3, pitch: 6, w: 4.0, h: 1.9, mode: 'stats', pt: [0, 1.96, WALL_Z + 0.1], pw: 1.65, ph: 1.85 },
} satisfies Record<string, Key>
/** [local, key]; consecutive A→B pairs are slow holds, the rest are moves */
const TRACK: [number, Key][] = [
  [0.0, K.est0],
  [0.115, K.est1],
  [0.17, K.topA],
  [0.29, K.topB],
  [0.34, K.b2A],
  [0.44, K.b2B],
  [0.495, K.b3A],
  [0.6, K.b3B],
  [0.655, K.b4A],
  [0.765, K.b4B],
  [0.83, K.stA],
  [0.95, K.stB],
  [1.0, K.stC],
]
const HOLDS = new Set([2, 4, 6, 8, 10, 11])

interface Resolved {
  t: THREE.Vector3
  yaw: number
  pitch: number
  w: number
  h: number
  cx: number
  cy: number
  fx: number
  fy: number
}

// ------------------------------------------------------------------ helpers

function shiftStrokes(strokes: Stroke[], dx: number, dy: number): Stroke[] {
  return strokes.map(s => ({ pts: s.pts.map(p => V(p.x + dx, p.y + dy, p.z)), closed: s.closed }))
}

/**
 * A stat value as tube strokes. Numerals are bent in the sans (EMS
 * Readability): the display face's 5 reads as an S and its zero is slashed.
 * "years" goes in script beside the 10.
 */
function statStrokes(i: number, S: number) {
  if (i === 0) {
    const a = textStrokes('10', { font: 'sans', size: S, tracking: 0.08 })
    const k = S * 1.05
    const b = textStrokes('years', { font: 'script', size: k })
    const gap = S * 0.2
    const total = a.width + gap + b.width
    // script baseline is font y 0.262; centred text puts it at (0.262 - 0.5) * size
    const by = -S / 2 - (0.262 - 0.5) * k
    return { strokes: [...shiftStrokes(a.strokes, -total / 2 + a.width / 2, 0), ...shiftStrokes(b.strokes, -total / 2 + a.width + gap + b.width / 2, by)], width: total, height: S }
  }
  const t = textStrokes(i === 1 ? '$1M+' : '15', { font: 'sans', size: S, tracking: 0.08 })
  return { strokes: t.strokes, width: t.width, height: S }
}

// ------------------------------------------------------------------ chapter

export default function create(): Chapter {
  const group = new THREE.Group()
  const pat = new THREE.Group()
  const B = beat(0, PROCESS.length, 0.14, 0.78)

  // DOM
  let head: HTMLElement
  let title: HTMLElement
  const cards: HTMLElement[] = []
  let statsBox: HTMLElement
  const statEls: HTMLElement[] = []
  const statX = [NaN, NaN, NaN]

  // scene handles
  let P: THREE.Vector3[] = []
  let glass: BendTube
  let sign: NeonPart
  let signLight: ReturnType<typeof tubeLight>
  let marker: ReturnType<typeof inkRibbon>
  let pencil: ReturnType<typeof inkRibbon>
  let flames: ReturnType<typeof ribbonFlames>
  let flameLight: THREE.RectAreaLight
  let work: ReturnType<typeof fluorescentFixture>
  let statLight: THREE.RectAreaLight
  let electrodes: THREE.Group
  let markerPen: THREE.Group
  let redPen: THREE.Group
  const penTip = V(0, 0, 0)
  const qWrite = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), V(0.3, -0.55, 0.78).normalize())
  const qRestM = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), V(0.22, 1, 0).normalize())
  const qRestR = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), V(-0.1, 1, 0).normalize())
  const restM = V(0.9, -0.24, 0.0085)
  const restR = V(0.99, -0.16, 0.0065)
  const stats: { g: THREE.Group; part: NeonPart; s: Striker; at: number; w: number }[] = []
  const pieces: { part: NeonPart; s: Striker }[] = []
  const signS = new Striker({ stutters: 2 })
  const workS = new Striker({ stutters: 1, depth: 0.45 })
  let restY = 0.3
  let lastShape = ''
  let settling = false

  // camera state (computed in update, written in camera)
  const pose = { position: V(0, 2, 4), target: V(0, 1, 0), fov: 38 }
  const cam = new THREE.PerspectiveCamera(38, 1, 0.05, 100)
  const regions = { w: 0, h: 0, tick: 0, cardRight: 0, cardTop: 0, headBottom: 0, statsTop: 0, labelsTop: 0 }

  const tA = V(0, 0, 0)
  const tB = V(0, 0, 0)
  const tmp = V(0, 0, 0)
  const vR = V(0, 0, 0)
  const vU = V(0, 0, 0)
  const Y1 = V(0, 1, 0)

  function measure(frame: Frame) {
    const r = regions
    r.w = frame.width
    r.h = frame.height
    let right = 0
    let top = frame.height
    for (const c of cards) {
      const b = c.getBoundingClientRect()
      right = Math.max(right, b.right)
      top = Math.min(top, b.top)
    }
    r.cardRight = right
    r.cardTop = top
    r.headBottom = head.getBoundingClientRect().bottom
    const sb = statsBox.getBoundingClientRect()
    r.statsTop = sb.top
    let lt = frame.height
    for (const s of statEls) lt = Math.min(lt, s.getBoundingClientRect().top)
    r.labelsTop = lt
  }

  function resolve(k: Key, portrait: boolean, frame: Frame, out: Resolved) {
    const W = Math.max(1, frame.width)
    const H = Math.max(1, frame.height)
    const t = portrait && k.pt ? k.pt : k.t
    out.t.set(t[0], t[1], t[2])
    out.yaw = portrait && k.pyaw != null ? k.pyaw : k.yaw
    out.pitch = portrait && k.ppitch != null ? k.ppitch : k.pitch
    out.w = portrait && k.pw != null ? k.pw : k.w
    out.h = portrait && k.ph != null ? k.ph : k.h
    const g = Math.min(48, Math.max(16, W * 0.034))
    const topBand = 76
    const botBand = 64
    let x0 = 0
    let x1 = W
    let y0 = topBand
    let y1 = H - botBand
    if (!portrait) {
      if (k.mode === 'card') {
        x0 = regions.cardRight + 20
        x1 = W - g
      } else if (k.mode === 'head') {
        x0 = W * 0.26
        x1 = W - g
      } else {
        x0 = g
        x1 = W - g
        y1 = regions.labelsTop - 14
      }
    } else if (k.mode === 'card') y1 = regions.cardTop - 12
    else if (k.mode === 'head') y0 = regions.headBottom + 12
    else y1 = regions.statsTop - 12
    if (x1 - x0 < W * 0.3) x0 = x1 - W * 0.3
    if (y1 - y0 < H * 0.3) y0 = y1 - H * 0.3
    out.cx = ((x0 + x1) / W) - 1
    out.cy = 1 - (y0 + y1) / H
    out.fx = (x1 - x0) / W
    out.fy = (y1 - y0) / H
  }

  const rA: Resolved = { t: V(0, 0, 0), yaw: 0, pitch: 0, w: 0, h: 0, cx: 0, cy: 0, fx: 1, fy: 1 }
  const rB: Resolved = { t: V(0, 0, 0), yaw: 0, pitch: 0, w: 0, h: 0, cx: 0, cy: 0, fx: 1, fy: 1 }

  function computePose(local: number, frame: Frame) {
    const portrait = frame.height > frame.width
    let i = 0
    while (i < TRACK.length - 2 && local > TRACK[i + 1][0]) i++
    const [a0, ka] = TRACK[i]
    const [a1, kb] = TRACK[i + 1]
    let f = clamp((local - a0) / Math.max(1e-6, a1 - a0))
    f = HOLDS.has(i) ? f : ease.inOutCubic(f)
    resolve(ka, portrait, frame, rA)
    resolve(kb, portrait, frame, rB)
    const L = (a: number, b: number) => a + (b - a) * f
    tA.lerpVectors(rA.t, rB.t, f)
    const yaw = THREE.MathUtils.degToRad(L(rA.yaw, rB.yaw))
    const pitch = THREE.MathUtils.degToRad(L(rA.pitch, rB.pitch))
    const w = L(rA.w, rB.w)
    const h = L(rA.h, rB.h)
    const cx = L(rA.cx, rB.cx)
    const cy = L(rA.cy, rB.cy)
    const fx = L(rA.fx, rB.fx)
    const fy = L(rA.fy, rB.fy)
    const fov = portrait ? 46 : 38
    const tanV = Math.tan(THREE.MathUtils.degToRad(fov / 2))
    const tanH = tanV * Math.max(0.2, frame.width / Math.max(1, frame.height))
    const dist = Math.max(w / 2 / (tanH * fx), h / 2 / (tanV * fy))
    const dir = tB.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch))
    const fwd = tmp.copy(dir).negate()
    const right = vR.crossVectors(fwd, Y1).normalize()
    const up = vU.crossVectors(right, fwd)
    const hw = dist * tanH
    const hh = dist * tanV
    pose.target.copy(tA).addScaledVector(right, -cx * hw).addScaledVector(up, -cy * hh)
    pose.position.copy(pose.target).addScaledVector(dir, dist)
    pose.fov = fov
  }

  // ---------------------------------------------------------------- bending

  /** the glass centreline + heat for this local (pattern space) */
  function shapeGlass(local: number) {
    const n = NPTS
    const C = glass.centre
    const heat = glass.heat
    const x0 = -LS / 2
    const b2 = ease.outCubic(segment(local, 0.305, 0.365))
    const b3 = segment(local, 0.46, 0.62)
    heat.fill(0)
    if (local < 0.46) {
      // lying straight above the pattern (slid in from the offcuts on the right)
      const dx = 1.15 * (1 - b2)
      for (let i = 0; i < n; i++) C[i].set(x0 + (i / (n - 1)) * LS + dx, restY, R_GLASS)
      return
    }
    if (b3 >= 1) {
      for (let i = 0; i < n; i++) C[i].set(P[i].x, P[i].y, R_GLASS)
      return
    }
    // 1. lift it and bring its end to the start of the pattern
    const s = ease.inOutCubic(segment(b3, 0.0, 0.2))
    // 2. the bend front runs along the word
    const f = ease.inOutQuad(segment(b3, 0.2, 0.9))
    const cool = 1 - smoothstep(0.86, 1.0, b3)
    const lift = 0.035 * s * (1 - smoothstep(0.88, 1.0, b3))
    const k = 0.035
    const fi = f * (n - 1)
    const i0 = Math.min(n - 2, Math.floor(fi))
    const Pf = tmp.copy(P[i0]).lerp(P[i0 + 1], fi - i0)
    const p0 = P[0]
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1)
      const restX = x0 + u * LS
      // straight, held above the paper, starting from the bend point
      const sx = Pf.x + (u - f) * LS
      const sy = Pf.y
      const w = smoothstep(f - k, f + k * 0.4, u)
      const bx = lerp(P[i].x, sx, w)
      const by = lerp(P[i].y, sy, w)
      const bz = R_GLASS + lift * w
      if (s < 1) {
        // phase 1: from rest to the start line (the front hasn't moved yet)
        const lx = p0.x + u * LS
        C[i].set(lerp(restX, lx, s), lerp(restY, p0.y, s), R_GLASS + 0.035 * s)
      } else C[i].set(bx, by, bz)
      // heat: hottest at the bend, cooling behind it
      const d = (u - f) / 0.03
      const behind = u < f ? Math.exp(-(f - u) / 0.07) * 0.45 : 0
      heat[i] = s >= 1 ? (Math.exp(-d * d) + behind) * cool : 0
    }
  }

  /** a pen writing along its ink (tip on the line) or lying on the bench */
  function posePen(pen: THREE.Group, ink: ReturnType<typeof inkRibbon>, [a, b]: number[], d: number, rest: THREE.Vector3, qRest: THREE.Quaternion, local: number) {
    const w = smoothstep(a - 0.014, a, local) * (1 - smoothstep(b, b + 0.014, local))
    ink.pointAt(d, penTip)
    penTip.z = 0.001
    pen.position.lerpVectors(rest, penTip, w)
    pen.position.z += Math.sin(w * Math.PI) * 0.05
    pen.quaternion.slerpQuaternions(qRest, qWrite, w)
  }

  return {
    id: 'process',
    group,
    // the four steps, then the stats beat (srContent makes the first stat a keyboard stop)
    anchors: [...B.centers, 0.88],
    busy: () => settling,
    async init(ctx) {
      initAreaLights()
      const radial = ctx.mobile ? 6 : 8

      // ---------------- room
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(10, 5), brickMaterial({ width: 10, height: 5, tint: '#2e2230' }))
      wall.position.set(0, 2.5, WALL_Z)
      group.add(wall)
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(14, 10), concreteMaterial({ width: 14, depth: 10 }))
      floor.rotation.x = -Math.PI / 2
      group.add(floor)

      // ---------------- the bench: steel top, dark frame, a low shelf
      const steelTop = new THREE.MeshStandardMaterial({ color: 0x8b8c93, metalness: 0.45, roughness: 0.48, envMapIntensity: 0.5 })
      const frameMat = new THREE.MeshStandardMaterial({ color: 0x1b1a20, metalness: 0.55, roughness: 0.5 })
      const shelfMat = new THREE.MeshStandardMaterial({ color: 0x241b17, roughness: 0.8 })
      const top = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.04, 1.34), steelTop)
      top.position.set(0, TOP - 0.02, 0.03)
      group.add(top)
      const apron = new THREE.Mesh(new THREE.BoxGeometry(2.76, 0.1, 0.03), frameMat)
      apron.position.set(0, TOP - 0.09, 0.68)
      group.add(apron)
      const legG = new THREE.BoxGeometry(0.06, TOP - 0.04, 0.06)
      const legs = new THREE.InstancedMesh(legG, frameMat, 4)
      const m4 = new THREE.Matrix4()
      let li = 0
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) legs.setMatrixAt(li++, m4.makeTranslation(sx * 1.32, (TOP - 0.04) / 2, 0.03 + sz * 0.58))
      group.add(legs)
      const shelf = new THREE.Mesh(new THREE.BoxGeometry(2.66, 0.03, 1.2), shelfMat)
      shelf.position.set(0, 0.22, 0.03)
      group.add(shelf)
      await nextFrame()

      // ---------------- the pattern (pattern space laid flat on the bench)
      pat.rotation.x = -Math.PI / 2
      pat.position.set(PX, TOP + 0.0015, PZ)
      group.add(pat)
      const path = patternPath(WORD, NPTS)
      P = path.pts.map(p => V(p.x, p.y + WORD_Y, 0))
      restY = WORD_Y + path.height / 2 + 0.1
      // pencil guides: baseline / x-height / ascender of the script
      const yAt = (fy: number) => {
        let minY = Infinity
        for (const p of P) minY = Math.min(minY, p.y)
        return minY + (fy - 0.03) * WORD
      }
      const paper = new THREE.Mesh(
        new THREE.PlaneGeometry(PAPER_W, PAPER_H),
        new THREE.MeshStandardMaterial({ map: paperTexture(PAPER_W, PAPER_H, [yAt(0.262), yAt(0.52), yAt(0.98)], ctx.mobile ? 768 : 1024), roughness: 0.92, metalness: 0, envMapIntensity: 0.25 }),
      )
      pat.add(paper)

      // 01: the word in marker, drawn along its length
      marker = inkRibbon([P], 0.0065, '#15121a', 0.94)
      pat.add(marker)
      // 02: checked in red pencil — electrode circles, a dimension line, a tick
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      for (const p of P) {
        minX = Math.min(minX, p.x)
        maxX = Math.max(maxX, p.x)
        minY = Math.min(minY, p.y)
      }
      const dimY = minY - 0.05
      const tick = (x: number) => [V(x, dimY - 0.018, 0), V(x, dimY + 0.018, 0)]
      const pen: THREE.Vector3[][] = [
        circlePts(P[0].x, P[0].y, 0.03, 26, Math.PI, -Math.PI * 2),
        circlePts(P[NPTS - 1].x, P[NPTS - 1].y, 0.03, 26, 0, Math.PI * 2),
        tick(minX),
        [V(minX, dimY, 0), V(maxX, dimY, 0)],
        tick(maxX),
      ]
      const ok = textStrokes('OK', { font: 'sans', size: 0.045, tracking: 0.2, align: 'left' })
      for (const s of shiftStrokes(ok.strokes, maxX + 0.08 + ok.width / 2, dimY + 0.06)) pen.push(s.pts)
      pen.push([V(maxX + 0.2, dimY + 0.06, 0), V(maxX + 0.222, dimY + 0.035, 0), V(maxX + 0.27, dimY + 0.1, 0)])
      pencil = inkRibbon(pen, 0.0032, '#b0232e', 0.85, 0.0009)
      pat.add(pencil)
      // the marker and the red pencil that do the drawing
      markerPen = penMesh('#1d1b22')
      redPen = penMesh('#b8322f', 0.17, 0.0065)
      pat.add(markerPen, redPen)

      // 03: the clear glass that gets bent
      glass = new BendTube(NPTS, R_GLASS, radial)
      glass.material.uniforms.uLightPos.value.set(PX + 0.25, 2.8, 0.05) // the work light's glint
      pat.add(glass.mesh)

      // 04: the finished piece (pink), its light on the paper and the bench
      sign = neonFromStrokes([{ pts: P.map(p => V(p.x, p.y, R_NEON)) }], { color: 'pink', radius: R_NEON, hdr: 3.8, blockout: false, electrodes: false, smooth: false, radial })
      // the part not yet lit is discarded, so the clear glass shows there
      sign.setHideUndrawn(true)
      pat.add(sign.group)
      const spill = neonSpill([{ pts: P }], { color: 'pink', width: PAPER_W, height: PAPER_H, blur: 0.05, strength: 0.28, res: 512 })
      spill.position.z = 0.0016
      pat.add(spill)
      sign.follow(spill)
      signLight = tubeLight(sign, { width: 1.2, height: 0.5, intensity: 1.6 })
      signLight.position.set(PX, TOP + 0.28, PZ - WORD_Y)
      signLight.rotation.x = -Math.PI / 2
      group.add(signLight)

      // electrodes + the burn-in leads to a small transformer (shown once it's bent)
      electrodes = new THREE.Group()
      const metal = new THREE.MeshStandardMaterial({ color: 0x8d8b90, metalness: 0.8, roughness: 0.35 })
      const rubber = new THREE.MeshStandardMaterial({ color: 0x0b0a0d, roughness: 0.55 })
      const ends = [
        { p: P[0], q: P[4] },
        { p: P[NPTS - 1], q: P[NPTS - 5] },
      ]
      const box = V(-1.02, 0.34, 0.0)
      for (const [ei, { p, q }] of ends.entries()) {
        const dir = V(p.x - q.x, p.y - q.y, 0).normalize()
        const shell = new THREE.Mesh(new THREE.CylinderGeometry(R_NEON * 1.5, R_NEON * 1.5, 0.05, 12), metal)
        const c = V(p.x, p.y, R_NEON).addScaledVector(dir, 0.028)
        shell.position.copy(c)
        shell.quaternion.setFromUnitVectors(V(0, 1, 0), dir)
        electrodes.add(shell)
        const tipOut = c.clone().addScaledVector(dir, 0.028)
        const lane = restY + 0.09
        const pts = [tipOut, tipOut.clone().addScaledVector(dir, 0.035).setZ(0.008)]
        if (ei === 0) pts.push(V(p.x - 0.16, p.y + 0.02, 0.006), V(box.x + 0.2, box.y - 0.14, 0.006))
        else pts.push(V(p.x + 0.09, lane - 0.04, 0.006), V(p.x - 0.1, lane, 0.006), V(box.x + 0.4, lane + 0.01, 0.006))
        pts.push(V(box.x + 0.15, box.y - 0.03 + ei * 0.06, 0.006), V(box.x + 0.1, box.y - 0.03 + ei * 0.06, 0.05))
        const wire = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 60, 0.0035, 5), rubber)
        electrodes.add(wire)
      }
      pat.add(electrodes)
      // the transformer (a black box with a lit pilot)
      const xf = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.15, 0.17), frameMat)
      xf.position.set(PX + box.x, TOP + 0.075, PZ - box.y)
      group.add(xf)
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.11, 0.05), new THREE.MeshStandardMaterial({ color: 0x8a8580, metalness: 0.6, roughness: 0.4 }))
      plate.position.set(PX + box.x, TOP + 0.09, PZ - box.y + 0.0851)
      group.add(plate)
      await nextFrame()

      // ---------------- the ribbon burner along the front edge
      const burner = new THREE.Group()
      burner.position.set(PX, TOP, BURNER_Z)
      group.add(burner)
      const pipeG = new THREE.CylinderGeometry(0.019, 0.019, BURNER_L + 0.08, 16)
      pipeG.rotateZ(Math.PI / 2)
      const pipe = new THREE.Mesh(pipeG, new THREE.MeshStandardMaterial({ color: 0x9c9690, metalness: 0.85, roughness: 0.3 }))
      pipe.position.y = 0.06
      burner.add(pipe)
      const standG = new THREE.BoxGeometry(0.03, 0.045, 0.08)
      for (const sx of [-1, 1]) {
        const st = new THREE.Mesh(standG, frameMat)
        st.position.set(sx * (BURNER_L / 2 - 0.05), 0.022, 0)
        burner.add(st)
      }
      // brass valve + gas hose off the right end, down behind the bench edge
      const valve = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.05, 12), new THREE.MeshStandardMaterial({ color: 0xa8843e, metalness: 0.9, roughness: 0.3 }))
      valve.position.set(BURNER_L / 2 + 0.07, 0.06, 0)
      valve.rotation.z = Math.PI / 2
      burner.add(valve)
      const hose = new THREE.Mesh(
        new THREE.TubeGeometry(new THREE.CatmullRomCurve3([V(BURNER_L / 2 + 0.1, 0.06, 0), V(BURNER_L / 2 + 0.3, 0.03, -0.05), V(BURNER_L / 2 + 0.55, 0.01, -0.3), V(BURNER_L / 2 + 0.8, 0.01, -0.62)]), 40, 0.009, 6),
        rubber,
      )
      burner.add(hose)
      flames = ribbonFlames(BURNER_L, 0.075, 58)
      flames.mesh.position.set(0, 0.078, 0)
      burner.add(flames.mesh)
      flameLight = new THREE.RectAreaLight('#3d78ff', 0, BURNER_L, 0.08)
      flameLight.position.set(PX, TOP + 0.12, BURNER_Z - 0.02)
      flameLight.rotation.x = -Math.PI / 2 + 0.55
      group.add(flameLight)

      // ---------------- glass: offcuts on the bench, stock leaning on the wall
      const glassMat = new THREE.MeshStandardMaterial({ color: 0xdfe8f0, metalness: 0, roughness: 0.08, transparent: true, opacity: 0.4, envMapIntensity: 1.4, depthWrite: false })
      const offG = new THREE.CylinderGeometry(R_GLASS, R_GLASS, 1, 10)
      offG.rotateZ(Math.PI / 2)
      const off = new THREE.InstancedMesh(offG, glassMat, 3)
      const q = new THREE.Quaternion()
      const sc = V(1, 1, 1)
      ;[
        [0.98, 0.22, 0.62, 0.05],
        [1.02, 0.28, 0.48, -0.08],
        [0.95, 0.12, 0.34, 0.12],
      ].forEach(([x, z, len, a], i) => {
        q.setFromAxisAngle(V(0, 1, 0), a)
        sc.set(len, 1, 1)
        off.setMatrixAt(i, m4.compose(V(x, TOP + R_GLASS, z), q, sc))
      })
      off.renderOrder = 2
      group.add(off)
      const stockG = new THREE.CylinderGeometry(0.008, 0.008, 1.62, 8)
      const stock = new THREE.InstancedMesh(stockG, glassMat, 9)
      const tint = ['#ffe0f0', '#e8f4ff', '#fff4e0', '#f0e6ff', '#ffffff', '#ffe6e0', '#e0f0ff', '#fff0f8', '#f4f4ff']
      for (let i = 0; i < 9; i++) {
        const x = 1.6 + i * 0.026 + Math.sin(i * 2.3) * 0.012
        q.setFromEuler(new THREE.Euler(-0.2 - (i % 3) * 0.015, 0, (i - 4) * 0.012))
        stock.setMatrixAt(i, m4.compose(V(x, 0.8, WALL_Z + 0.2), q, V(1, 1, 1)))
        stock.setColorAt(i, new THREE.Color(tint[i]))
      }
      stock.renderOrder = 2
      group.add(stock)

      // ---------------- the work light
      work = fluorescentFixture(1.6, { color: '#ffe3c4', intensity: 40 })
      work.group.position.set(PX + 0.25, 2.8, 0.05)
      group.add(work.group)
      await nextFrame()

      // ---------------- finished pieces on the wall (lit from the first frame)
      const arrow: Stroke[] = [
        { pts: [V(-0.4, -0.13, 0), V(-0.22, -0.03, 0), V(0.0, 0.015, 0), V(0.31, 0.0, 0)] },
        { pts: [V(0.14, 0.15, 0), V(0.33, 0.0, 0), V(0.14, -0.15, 0)] },
      ]
      const star: Stroke[] = [{ pts: Array.from({ length: 10 }, (_, i) => V(Math.sin((i / 10) * Math.PI * 2) * (i % 2 ? 0.09 : 0.22), Math.cos((i / 10) * Math.PI * 2) * (i % 2 ? 0.09 : 0.22), 0)), closed: true }]
      const piece = (strokes: Stroke[], color: string, x: number, y: number, rot: number, smooth: boolean, mirror = false) => {
        const g = new THREE.Group()
        g.position.set(x, y, WALL_Z + 0.05)
        g.rotation.z = rot
        if (mirror) g.scale.x = -1
        const part = neonFromStrokes(strokes, { color, radius: 0.011, hdr: 4, smooth, radial })
        g.add(part.group)
        const sp = neonSpill(strokes, { color, width: 1.3, height: 1.1, blur: 0.08, strength: 0.5 })
        sp.position.z = -0.048
        g.add(sp)
        part.follow(sp)
        group.add(g)
        pieces.push({ part, s: new Striker({ stutters: 1 }) })
      }
      piece(arrow, 'amber', 2.2, 1.42, 0.3, true, true)
      piece(star, 'violet', 2.3, 2.3, 0.12, false)

      // ---------------- the stats, bent in argon on the wall
      for (let i = 0; i < 3; i++) {
        const st = statStrokes(i, STAT_S)
        const g = new THREE.Group()
        const part = neonFromStrokes(st.strokes, { color: 'blue', radius: STAT_S / 30, hdr: 4, radial })
        g.add(part.group)
        const sp = neonSpill(st.strokes, { color: 'blue', width: st.width + 0.7, height: STAT_S + 0.8, blur: 0.07, strength: 0.5 })
        sp.position.z = -0.048
        g.add(sp)
        part.follow(sp)
        group.add(g)
        stats.push({ g, part, s: new Striker({ stutters: 1 }), at: 0.815 + i * 0.025, w: st.width })
      }
      // frame the row (landscape) / the stack (portrait) from the bent widths
      const rowW = stats.reduce((a, b) => a + b.w, 0) + STAT_GAP * 2
      const colW = Math.max(...stats.map(s => s.w))
      K.stA.w = rowW + 0.75
      K.stB.w = rowW + 0.6
      K.stC.w = rowW + 0.5
      K.stA.pw = colW + 0.45
      K.stB.pw = colW + 0.38
      K.stC.pw = colW + 0.32
      statLight = new THREE.RectAreaLight('#2cb4ff', 0, 3.4, 0.9)
      statLight.position.set(0, 1.95, WALL_Z + 0.4)
      group.add(statLight)

      // ---------------- DOM
      head = el('div', 'pr-head', undefined, ctx.stage)
      el('p', 'hud-eyebrow', SECTIONS.process.eyebrow, head)
      title = rise(el('h2', 'hud-h2 pr-h2', undefined, head), 'We listen first. Then we <em>build.</em>')
      PROCESS.forEach((p, i) => {
        const c = el('div', 'pr-card hud-panel', undefined, ctx.stage)
        const num = el('p', 'pr-num', undefined, c)
        el('span', 'pr-num-n', String(i + 1).padStart(2, '0'), num)
        el('span', 'pr-num-of', `/ ${String(PROCESS.length).padStart(2, '0')}`, num)
        el('span', 'pr-num-tag', TAGS[i], num)
        el('h3', 'pr-title', p.title, c)
        el('p', 'hud-body pr-text', p.text, c)
        reveal(c, 0, 0)
        cards.push(c)
      })
      statsBox = el('div', 'pr-stats', undefined, ctx.stage)
      for (const s of SHOW) {
        const d = el('div', 'pr-stat', undefined, statsBox)
        el('p', 'pr-stat-v', s.value, d)
        el('p', 'pr-stat-l', s.label, d)
        reveal(d, 0, 0)
        statEls.push(d)
      }
      reveal(head, 0, 0)
    },

    update(local, frame, ctx) {
      const calm = ctx.reducedMotion || !!frame.still || Math.abs(frame.velocity) > 2.5
      const portrait = frame.height > frame.width
      if (regions.w !== frame.width || regions.h !== frame.height || ++regions.tick % 90 === 0) measure(frame)
      computePose(local, frame)

      // ---------------- world + post
      const wp = ctx.world.params
      wp.fog = 0.02
      wp.fogColor = '#07050a'
      wp.glow = 0.3
      wp.glowColor = local > 0.62 ? '#ff2e97' : '#2c6bff'
      wp.motes = 0.55
      wp.moteColor = '#ffe2c8'
      wp.env = 0.5
      wp.fill = 0.14

      // ---------------- lights on the bench
      settling = false
      const wl = workS.update(true, frame.dt, calm)
      work.setLevel(wl)
      for (const p of pieces) p.part.setLevel(p.s.update(true, frame.dt, calm))

      // ---------------- 01: ink
      marker.setDraw(ease.inOutQuad(segment(local, MARKER[0], MARKER[1])))
      pencil.setDraw(segment(local, PENCIL[0], PENCIL[1]))
      posePen(markerPen, marker, MARKER, ease.inOutQuad(segment(local, MARKER[0], MARKER[1])), restM, qRestM, local)
      posePen(redPen, pencil, PENCIL, segment(local, PENCIL[0], PENCIL[1]), restR, qRestR, local)

      // ---------------- 02/03: the glass
      glass.mesh.visible = local >= 0.3 && local < 0.72
      if (glass.mesh.visible) {
        const key = local < 0.46 ? `r${segment(local, 0.305, 0.365).toFixed(4)}` : local >= 0.62 ? 'bent' : `b${local.toFixed(5)}`
        if (key !== lastShape) {
          lastShape = key
          shapeGlass(local)
          glass.commit()
        }
      }
      // flames: the heat follows the bend
      const b3 = segment(local, 0.46, 0.62)
      const bendF = ease.inOutQuad(segment(b3, 0.2, 0.9))
      const fi = bendF * (NPTS - 1)
      const fx = P.length ? P[Math.min(NPTS - 1, Math.round(fi))].x : 0
      const heating = smoothstep(0.08, 0.22, b3) * (1 - smoothstep(0.86, 1.0, b3))
      const fu = flames.uniforms
      fu.uTime.value = frame.time
      fu.uAmp.value = ctx.reducedMotion ? 0.25 : 1
      fu.uFocus.value = (fx + BURNER_L / 2) / BURNER_L
      fu.uBoost.value = 0.35 * heating
      // flames face the lens (a cylindrical billboard round the burner) and
      // foreshorten as the camera climbs
      const fy = TOP + 0.078
      const dy = pose.position.y - fy
      const dz = pose.position.z - BURNER_Z
      flames.mesh.rotation.x = Math.atan2(-dy, dz)
      fu.uFore.value = Math.max(0.3, dz / Math.hypot(dy, dz))
      const flick = ctx.reducedMotion || frame.still ? 0 : Math.sin(frame.time * 21) * 0.08 + Math.sin(frame.time * 33.7) * 0.05
      flameLight.intensity = (2.2 + 1.4 * heating) * (1 + flick)

      // ---------------- 04: the finished piece strikes on and stays lit
      const signOn = local >= 0.625
      const sl = signS.update(signOn, frame.dt, calm)
      sign.setLevel(sl)
      sign.setDraw(ease.inOutQuad(segment(local, 0.625, 0.685)))
      signLight.sync()
      electrodes.visible = local >= 0.6

      // ---------------- stats on the wall
      let avg = 0
      stats.forEach((s, i) => {
        const on = local >= s.at
        const lv = s.s.update(on, frame.dt, calm)
        s.part.setLevel(lv)
        avg += lv / 3
        // hung unlit on the wall once the camera heads there (not behind the intro)
        s.g.visible = local >= 0.765
        if (portrait) s.g.position.set(0, 2.54 - i * 0.58, WALL_Z + 0.05)
        else {
          const gap = STAT_GAP
          const total = stats.reduce((a, b) => a + b.w, 0) + gap * 2
          let x = -total / 2
          for (let j = 0; j < i; j++) x += stats[j].w + gap
          s.g.position.set(x + s.w / 2, 1.95, WALL_Z + 0.05)
        }
        if (lv > 0.001 && lv < 0.999) settling = true
      })
      statLight.intensity = avg * 7
      if (portrait) {
        statLight.width = 1.6
        statLight.height = 1.8
        statLight.position.y = 1.96
      } else {
        statLight.width = 3.6
        statLight.height = 0.9
        statLight.position.y = 1.95
      }
      if ((wl > 0.001 && wl < 0.999) || (sl > 0.001 && sl < 0.999)) settling = true

      // ---------------- DOM
      reveal(head, smoothstep(0.03, 0.055, local) * (1 - smoothstep(0.128, 0.142, local)), 0)
      setRise(title, local > 0.035 && local < 0.14)
      cards.forEach((c, i) => {
        const a = 0.14 + i * 0.16
        reveal(c, window01(local, a + 0.004, a + 0.156, 0.012), 10)
      })
      const sv = window01(local, 0.8, 0.955, 0.02)
      if (!portrait) {
        cam.fov = pose.fov
        cam.aspect = frame.width / Math.max(1, frame.height)
        cam.position.copy(pose.position)
        cam.lookAt(pose.target)
        cam.updateProjectionMatrix()
        cam.updateMatrixWorld()
      }
      statEls.forEach((d, i) => {
        const on = local >= stats[i].at - 0.005
        reveal(d, sv * (on ? 1 : 0), 0)
        if (!portrait) {
          tmp.copy(stats[i].g.position)
          tmp.project(cam)
          // centred under its numeral, kept on screen
          const half = Math.min(290, frame.width * 0.27) / 2 + 12
          const x = Math.round(clamp((tmp.x * 0.5 + 0.5) * frame.width, half, frame.width - half))
          if (statX[i] !== x) {
            statX[i] = x
            d.style.transform = `translate3d(${x}px, 0, 0) translate3d(-50%, 0, 0)`
          }
        } else if (statX[i] !== -1) {
          statX[i] = -1
          d.style.transform = ''
        }
      })
    },

    camera(_local, _frame, out) {
      out.position.copy(pose.position)
      out.target.copy(pose.target)
      out.fov = pose.fov
      out.parallax = 0.12
    },
  }
}
