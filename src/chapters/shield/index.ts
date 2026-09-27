import * as THREE from 'three'
import type { CameraPose, Chapter } from '../../core/types'
import { el, rise, setRise, reveal } from '../../core/dom'
import { SECURITY, STATS } from '../../content'
import { ease, lerp, segment, smoothstep } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { neonFromStrokes, neonSpill, neonText, textStrokes, Striker, TUBE, type NeonPart } from '../../kit/neon'
import { backerPanel, brickMaterial, concreteMaterial, fluorescentFixture, initAreaLights } from '../../kit/shop'
import type { Stroke } from '../../kit/type'
import { breakerPanel, cable, circleStroke, conduit, glowPlane, monoReady, monoText, panelPaint, plate, roundedPolygon, Sparks, straps, transformer } from './props'
import '../chapter.css'
import './shield.css'

/*
 * SHIELD · "Short Circuit" — the utility corner of the shop.
 *
 *   0.03–0.35  the breach: a red warning sign on a black backer ("⚠ HACKED?",
 *              its letters knocked crooked, the K hanging off its supports)
 *              sputters — dropouts re-strike through Strikers (the site flash
 *              budget), slow level wobble, sparks off the transformer's HV
 *              boot, short small post glitch bursts. At most MAX_FAULTS per
 *              visit to the breach, then it rests broken and steady (dim K).
 *              Calm modes: steady from the start.
 *   0.25–0.34  brownout: the sign sags as the camera turns to the breaker
 *              (keeps the pan from sweeping full-bright tubes across the frame)
 *   0.35–0.40  the breaker resets: the lever snaps up (a time-based spring),
 *              the red circuit dies as it passes centre, the pilot goes blue
 *   0.39–0.62  breathe (landing 0.45): "breathe." writes itself in argon blue
 *              on the same board and then BREATHES (0.2 Hz, 0.75↔1; steady
 *              in calm modes); "24/7" strikes above it; the copy panel
 *   0.62–0.97  keep watch: the camera eases back to the whole corner; three
 *              small indicator tubes (monitoring, backups, hardening — words
 *              from SECURITY.body) strike on the status plate and hold
 *
 * Flash safety: every on/off goes through a Striker; the fault clock drops
 * at most one tube every ~1.5 s (plus its budgeted stutter), four times per
 * visit; sparks and the glitch ride the same events; strikes ramp without a
 * stutter on a brisk scroll; nothing flashes > 3/s; no full-frame flashes.
 *
 * Lights: 3 RectAreaLights on desktop (the board halo, the 24/7 halo, the
 * work light), 2 on phones (the 24/7 halo becomes a wider spill). The floor
 * pool and the spark glow are additive planes (props.glowPlane).
 */

// ------------------------------------------------------------------ layout (world, wall face at z = 0)

const BOARD = new THREE.Vector3(0, 0.3, 0.075)
const BOARD_W = 3.7
const BOARD_H = 2.05
const SEVEN = new THREE.Vector3(0.25, 2.07, 0.09)
const BREAKER = new THREE.Vector3(3.4, -0.42, 0)
const STATUS = new THREE.Vector3(3.4, 1.12, 0.075)
const T1 = new THREE.Vector3(-2.5, 0.78, 0)
const T2 = new THREE.Vector3(1.9, 2.16, 0)
const LAMP = new THREE.Vector3(3.4, 1.98, 0.12)
const CONDUIT_X = 2.5
const FLOOR_Y = -2.0
const RUN_Y = 2.78
const RUN_Z = 0.05

// timeline (local)
const BROWN_AT = 0.25 // the tripped sign starts to sag (the camera turns to the breaker)
const LEVER_AT = 0.352 // the breaker is thrown
const BLUE_AT = 0.382 // argon strikes (and writes itself until DRAW_END)
const DRAW_END = 0.435
const SEVEN_AT = 0.415
const WATCH_AT = [0.6, 0.635, 0.67]

// fault clock (breach idle): dropouts at these seconds of REST in the breach
// (the clock runs only while the visitor lingers; reset each visit); after
// MAX_FAULTS the sign rests broken and steady. Irregular, like a real short;
// ≥ 1.55 s apart so one fault — dropout + one budgeted stutter + a short
// glitch — never shares a rolling second with the next.
const FAULTS = [0.25, 2.6, 4.45, 6.55]
const MAX_FAULTS = FAULTS.length
const DROP = 0.14
// strikes ramp (no stutter) above this scroll speed (vh/s): a brisk scroll
// through the reset would stack the argon strike, the 24/7 and the camera pan
const STRIKE_CALM_V = 1.2
// the fault clock only runs while the visitor rests in the breach (a pause or
// a slow drift): a fault on top of a moving camera stacks flashes
const FAULT_V = 0.6

const faultAt = (k: number) => FAULTS[k]
/** when the last fault's echo has died away (s of rest in the breach) */
const FAULTS_DONE = faultAt(MAX_FAULTS - 1) + 0.9
/** steady broken state (level multipliers): triangle, word, the hanging K */
const REST = [0.92, 0.9, 0.62]

// ------------------------------------------------------------------ camera shots

interface Shot {
  /** subject box centre + size (world, on the wall) */
  x: number
  y: number
  w: number
  h: number
  /** where it sits on screen (0..1 from left/top) and how much of it it may fill */
  sx: number
  sy: number
  sw: number
  sh: number
  yaw: number
  pitch: number
  fov: number
  /** highest world y the frame may show (keeps the dark 24/7 out of the breach) */
  top: number
  /** Dutch tilt (radians): the breach is askew; the reset levels it */
  roll: number
}
const KEYS = ['x', 'y', 'w', 'h', 'sx', 'sy', 'sw', 'sh', 'yaw', 'pitch', 'fov', 'top', 'roll'] as const
const NO_TOP = 9

// landscape: copy lives on the left from the landing on
const WIDE: [number, Shot][] = [
  [0.0, { x: -0.7, y: 0.55, w: 5.0, h: 2.5, sx: 0.52, sy: 0.5, sw: 0.9, sh: 0.8, yaw: -0.42, pitch: -0.03, fov: 38, top: 1.6, roll: -0.055 }],
  [0.27, { x: -0.85, y: 0.6, w: 4.3, h: 2.2, sx: 0.52, sy: 0.5, sw: 0.9, sh: 0.8, yaw: -0.34, pitch: -0.02, fov: 38, top: 1.6, roll: -0.04 }],
  [0.34, { x: 3.2, y: 0.15, w: 3.2, h: 2.9, sx: 0.5, sy: 0.5, sw: 0.9, sh: 0.86, yaw: 0.3, pitch: 0.04, fov: 38, top: NO_TOP, roll: 0 }],
  [0.37, { x: 3.25, y: 0.12, w: 3.1, h: 2.8, sx: 0.5, sy: 0.5, sw: 0.9, sh: 0.86, yaw: 0.32, pitch: 0.04, fov: 38, top: NO_TOP, roll: 0 }],
  [0.44, { x: 0.2, y: 0.95, w: 4.0, h: 3.7, sx: 0.7, sy: 0.5, sw: 0.5, sh: 0.76, yaw: 0.05, pitch: 0.0, fov: 38, top: NO_TOP, roll: 0 }],
  [0.6, { x: 0.25, y: 0.95, w: 4.2, h: 3.9, sx: 0.7, sy: 0.5, sw: 0.5, sh: 0.76, yaw: 0.03, pitch: 0.0, fov: 38, top: NO_TOP, roll: 0 }],
  [0.76, { x: 0.8, y: 0.75, w: 7.1, h: 4.2, sx: 0.68, sy: 0.5, sw: 0.62, sh: 0.8, yaw: -0.02, pitch: 0.02, fov: 38, top: NO_TOP, roll: 0 }],
  [1.0, { x: 0.8, y: 0.75, w: 7.4, h: 4.4, sx: 0.68, sy: 0.5, sw: 0.62, sh: 0.8, yaw: -0.04, pitch: 0.02, fov: 38, top: NO_TOP, roll: 0 }],
]
// portrait: copy in the bottom band, the sign above
const TALL: [number, Shot][] = [
  [0.0, { x: -0.25, y: 0.5, w: 4.1, h: 2.6, sx: 0.5, sy: 0.46, sw: 0.97, sh: 0.6, yaw: -0.32, pitch: -0.02, fov: 44, top: NO_TOP, roll: -0.05 }],
  [0.27, { x: -0.3, y: 0.55, w: 3.8, h: 2.4, sx: 0.5, sy: 0.46, sw: 0.97, sh: 0.6, yaw: -0.26, pitch: -0.02, fov: 44, top: NO_TOP, roll: -0.035 }],
  [0.34, { x: 3.45, y: -0.1, w: 1.9, h: 2.4, sx: 0.5, sy: 0.45, sw: 0.9, sh: 0.6, yaw: 0.3, pitch: 0.04, fov: 44, top: NO_TOP, roll: 0 }],
  [0.37, { x: 3.45, y: -0.1, w: 1.85, h: 2.3, sx: 0.5, sy: 0.45, sw: 0.9, sh: 0.6, yaw: 0.32, pitch: 0.04, fov: 44, top: NO_TOP, roll: 0 }],
  [0.44, { x: 0.1, y: 0.95, w: 3.8, h: 3.5, sx: 0.5, sy: 0.25, sw: 0.96, sh: 0.34, yaw: 0.04, pitch: 0.0, fov: 44, top: NO_TOP, roll: 0 }],
  [0.6, { x: 0.12, y: 0.95, w: 3.9, h: 3.6, sx: 0.5, sy: 0.25, sw: 0.96, sh: 0.34, yaw: 0.03, pitch: 0.0, fov: 44, top: NO_TOP, roll: 0 }],
  [0.76, { x: 1.1, y: 0.95, w: 5.9, h: 4.0, sx: 0.5, sy: 0.26, sw: 0.97, sh: 0.38, yaw: -0.02, pitch: 0.02, fov: 44, top: NO_TOP, roll: 0 }],
  [1.0, { x: 1.1, y: 0.95, w: 6.1, h: 4.2, sx: 0.5, sy: 0.26, sw: 0.97, sh: 0.38, yaw: -0.04, pitch: 0.02, fov: 44, top: NO_TOP, roll: 0 }],
]

const tmpShot = {} as Shot
function shotAt(keys: [number, Shot][], local: number): Shot {
  let i = 0
  while (i < keys.length - 2 && local > keys[i + 1][0]) i++
  const [a, A] = keys[i]
  const [b, B] = keys[i + 1]
  const k = ease.inOutCubic(segment(local, a, b))
  for (const key of KEYS) tmpShot[key] = lerp(A[key], B[key], k)
  return tmpShot
}

/** place the camera so the subject box lands in its screen rect */
function solveShot(s: Shot, aspect: number, out: CameraPose) {
  const tv = Math.tan((s.fov * Math.PI) / 360)
  const d = Math.max(s.h / s.sh, s.w / (s.sw * aspect)) / (2 * tv)
  const H = 2 * d * tv
  const W = H * aspect
  out.target.set(s.x - (s.sx - 0.5) * W, Math.min(s.y + (s.sy - 0.5) * H, s.top - H / 2), 0.3)
  out.position.set(
    out.target.x + Math.sin(s.yaw) * d,
    out.target.y + Math.sin(s.pitch) * d,
    out.target.z + Math.cos(s.yaw) * Math.cos(s.pitch) * d,
  )
  out.fov = s.fov
  out.roll = s.roll
}

// ------------------------------------------------------------------ helpers

/** move/rotate a group of strokes about their own centre */
function bend(strokes: Stroke[], rot: number, dx: number, dy: number): Stroke[] {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const s of strokes)
    for (const p of s.pts) {
      minX = Math.min(minX, p.x)
      maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y)
      maxY = Math.max(maxY, p.y)
    }
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const c = Math.cos(rot)
  const sn = Math.sin(rot)
  return strokes.map(s => ({
    closed: s.closed,
    pts: s.pts.map(p => {
      const x = p.x - cx
      const y = p.y - cy
      return new THREE.Vector3(cx + x * c - y * sn + dx, cy + x * sn + y * c + dy, p.z)
    }),
  }))
}

const offset = (strokes: Stroke[], dx: number, dy: number, dz = 0): Stroke[] =>
  strokes.map(s => ({ closed: s.closed, pts: s.pts.map(p => new THREE.Vector3(p.x + dx, p.y + dy, p.z + dz)) }))

/** a small time-based spring (the lever): settles in ~0.35 s */
class Spring {
  x = 0
  v = 0
  update(target: number, dt: number, calm: boolean) {
    const k = 520
    const c = calm ? 2 * Math.sqrt(k) : 24
    let t = Math.min(dt, 0.1)
    while (t > 1e-5) {
      const h = Math.min(t, 1 / 240)
      this.v += (k * (target - this.x) - c * this.v) * h
      this.x += this.v * h
      t -= h
    }
    if (Math.abs(target - this.x) < 1e-3 && Math.abs(this.v) < 1e-3) {
      this.x = target
      this.v = 0
    }
    return this.x
  }
}

// ------------------------------------------------------------------ chapter

export default function create(): Chapter {
  const group = new THREE.Group()
  const stat = STATS.find(s => s.value === '24/7')!

  // tubes + drivers
  type Driven = { part: NeonPart; s: Striker; level: number }
  let red: Driven[] = []
  let blue!: Driven
  let seven!: Driven
  let watch: Driven[] = []
  let redSpill!: THREE.Mesh & { setLevel(v: number): void }
  let breaker!: ReturnType<typeof breakerPanel>
  let sparks!: Sparks
  const sparkOrigin = new THREE.Vector3()
  let fixture!: ReturnType<typeof fluorescentFixture>
  let halo!: THREE.RectAreaLight
  // desktop only (phones: a wider spill carries the 24/7's light on the brick)
  let sevenLight: THREE.RectAreaLight | null = null
  let workLight!: THREE.RectAreaLight
  let floorPool!: ReturnType<typeof glowPlane>
  let sparkGlow!: ReturnType<typeof glowPlane>
  const cSpark = new THREE.Color('#ffb070')
  const lever = new Spring()
  /** seconds spent resting in the breach this visit (the fault clock) */
  let breachRest = 0
  let roomLevel = 0.8
  let settled = true
  let sparksLive = false
  const cRed = new THREE.Color(TUBE.red)
  const cBlue = new THREE.Color(TUBE.blue)
  const cTmp = new THREE.Color()
  const cGlow = new THREE.Color()
  const cBottom = new THREE.Color()
  const cMote = new THREE.Color()
  const bursts: [number, number][] = []

  // DOM
  let copy!: HTMLElement
  let title!: HTMLElement
  // portrait: the free band above the copy panel (fractions of the viewport),
  // measured on resize so the sign always sits clear of the panel
  const band = { top: 0.09, bottom: 0.52 }
  const tall = TALL.map(([l, sh]) => [l, { ...sh }] as [number, Shot])
  const fitTall = () => {
    for (const [l, sh] of tall) {
      if (l < 0.4) continue
      sh.sy = (band.top + band.bottom) / 2
      sh.sh = Math.max(0.12, (band.bottom - band.top) * 0.9)
    }
  }

  return {
    id: 'shield',
    group,
    anchors: [0.45],
    async init(ctx) {
      initAreaLights()
      const radial = ctx.mobile ? 6 : 8

      // ---------------- the room: brick wall, a return wall, sealed concrete
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(18, 9), brickMaterial({ width: 18, height: 9, tint: '#2f242c' }))
      wall.position.set(0.5, 1.0, 0)
      group.add(wall)
      const side = new THREE.Mesh(new THREE.PlaneGeometry(10, 9), brickMaterial({ width: 10, height: 9, tint: '#261d24' }))
      side.rotation.y = -Math.PI / 2
      side.position.set(5.05, 1.0, 5)
      group.add(side)
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(26, 18), concreteMaterial({ width: 26, depth: 18 }))
      floor.rotation.x = -Math.PI / 2
      floor.position.set(0.5, FLOOR_Y, 7)
      group.add(floor)
      await nextFrame()

      // ---------------- the warning board: ⚠ HACKED? (red) over breathe. (argon)
      const board = new THREE.Group()
      board.position.copy(BOARD)
      group.add(board)
      board.add(backerPanel(BOARD_W, BOARD_H))
      const TZ = 0.07
      // warning triangle with a "!" — hard corners, softly rounded
      const triH = 0.6
      const triC = new THREE.Vector2(-1.3, 0.43)
      const tri = roundedPolygon(
        [
          [triC.x - 0.34, triC.y - triH / 2],
          [triC.x + 0.34, triC.y - triH / 2],
          [triC.x, triC.y + triH / 2],
        ],
        0.055,
        TZ,
      )
      const bar: Stroke = { pts: [new THREE.Vector3(triC.x, triC.y + 0.1, TZ), new THREE.Vector3(triC.x, triC.y - 0.1, TZ)] }
      const dot = circleStroke(triC.x, triC.y - 0.2, 0.018, TZ, 8)
      const triStrokes = bend([tri, bar, dot], 0.035, 0, 0)
      const pTri = neonFromStrokes(triStrokes, { color: 'red', radius: 0.016, hdr: 4.2, smooth: false, radial })
      board.add(pTri.group)
      // HACKED? — one letter at a time so the tubes can sit crooked
      const HS = 0.4
      const word = 'HACKED?'
      const full = textStrokes(word, { font: 'sans', size: HS })
      const counts = [...word].map(ch => textStrokes(ch, { font: 'sans', size: HS }).strokes.length)
      const crooked: [number, number, number][] = [
        [0.025, 0, 0.005],
        [-0.04, 0.004, 0.012],
        [0.05, 0, -0.012],
        [-0.34, 0.03, -0.085], // the K has come off a support and hangs
        [0.06, -0.006, 0.018],
        [-0.03, 0, -0.004],
        [0.11, 0.01, -0.02],
      ]
      let at = 0
      const letters = counts.map((n, i) => {
        const s = full.strokes.slice(at, at + n)
        at += n
        const [r, dx, dy] = crooked[i]
        return offset(bend(s, r, dx, dy), 0.42, 0.43, TZ)
      })
      const pWord = neonFromStrokes(letters.filter((_, i) => i !== 3).flat(), { color: 'red', radius: HS / 28, hdr: 4.2, radial, caps: false })
      const pK = neonFromStrokes(letters[3], { color: 'red', radius: HS / 28, hdr: 4.2, radial, caps: false })
      board.add(pWord.group, pK.group)
      const redStrokes = [...triStrokes, ...letters.flat()]
      redSpill = neonSpill(redStrokes, { color: 'red', width: BOARD_W, height: 1.1, cx: 0, cy: 0.43, blur: 0.075, strength: 0.55 })
      redSpill.position.z = 0.002
      board.add(redSpill)
      red = [pTri, pWord, pK].map(part => ({ part, s: new Striker({ stutters: 1 }), level: 0 }))

      // breathe. — argon, script, writes itself
      const b = neonText('breathe.', { font: 'script', size: 0.62 }, { color: 'blue', hdr: 3.9, radius: 0.62 / 30, radial })
      b.part.group.position.set(0.02, -0.44, TZ)
      board.add(b.part.group)
      const bSpill = neonSpill(b.text.strokes, { color: 'blue', width: BOARD_W, height: 1.2, blur: 0.08, strength: 0.34 })
      bSpill.position.set(0.02, -0.44, 0.002)
      board.add(bSpill)
      b.part.follow(bSpill)
      blue = { part: b.part, s: new Striker({ stutters: 1 }), level: 0 }
      await nextFrame()

      // ---------------- 24/7 — argon, bent straight onto the brick. EMS
      // Readability (sans): Osmotron's 7 is a flat-top hook that reads "24/ㄱ"
      const SV = 0.58
      const sv = neonText('24/7', { font: 'sans', size: SV, tracking: 0.22 }, { color: 'blue', hdr: 4, radius: SV / 28, radial, caps: false })
      sv.part.group.position.copy(SEVEN)
      group.add(sv.part.group)
      // phones have no area light on it: a wider, stronger spill carries its light on the brick
      const svSpill = ctx.mobile
        ? neonSpill(sv.text.strokes, { color: 'blue', width: sv.text.width + 2.6, height: 2.2, blur: 0.2, strength: 0.8 })
        : neonSpill(sv.text.strokes, { color: 'blue', width: sv.text.width + 1.4, height: 1.4, blur: 0.09, strength: 0.5 })
      svSpill.position.set(SEVEN.x, SEVEN.y, 0.004)
      group.add(svSpill)
      sv.part.follow(svSpill)
      // no stutter: it strikes a beat after the argon, in the same corner of the frame
      seven = { part: sv.part, s: new Striker({ stutters: 0, ramp: 0.3 }), level: 0 }
      // glass supports (little posts to the brick)
      const post = new THREE.CylinderGeometry(0.008, 0.008, SEVEN.z, 6)
      post.rotateX(Math.PI / 2)
      const posts = new THREE.InstancedMesh(post, new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.2, metalness: 0.2, transparent: true, opacity: 0.6 }), 4)
      const pm = new THREE.Matrix4()
      // each post under a bend of the glass near the baseline
      const svPts = sv.text.strokes.flatMap(s => s.pts)
      const want = new THREE.Vector3()
      ;[-0.4, -0.13, 0.13, 0.4].forEach((f, i) => {
        want.set(f * sv.text.width, -SV * 0.3, 0)
        const p = svPts.reduce((a, b) => (b.distanceToSquared(want) < a.distanceToSquared(want) ? b : a))
        posts.setMatrixAt(i, pm.makeTranslation(SEVEN.x + p.x, SEVEN.y + p.y, SEVEN.z / 2))
      })
      group.add(posts)
      // the tube's two electrode ends (the GTO from T2 runs to them)
      const svStrokes = sv.text.strokes
      const svEnds = [svStrokes[0].pts[0], svStrokes[svStrokes.length - 1].pts[svStrokes[svStrokes.length - 1].pts.length - 1]]

      // ---------------- the breaker
      breaker = breakerPanel()
      breaker.group.position.copy(BREAKER)
      group.add(breaker.group)

      // ---------------- status plate: three small indicator tubes (from SECURITY.body)
      await monoReady()
      const statusG = new THREE.Group()
      statusG.position.copy(STATUS)
      group.add(statusG)
      // matte painted plate (a glossy backer would mirror the work light)
      statusG.add(backerPanel(1.25, 0.95, { material: new THREE.MeshStandardMaterial({ color: 0x1d1c21, roughness: 0.62, metalness: 0.3, envMapIntensity: 0.5 }) }))
      const head = plate(1.05, 0.09, (g, w, h) => {
        monoText(g, 'STATUS', 0, h / 2, h * 0.62, '#a9a2b4', 600, 'left', 0.5)
        g.fillStyle = 'rgba(169,162,180,0.45)'
        g.fillRect(w * 0.36, h / 2 - 1, w * 0.64, 2)
      }, 1024)
      const hm = head.material as THREE.MeshStandardMaterial
      hm.emissive.set(0xffffff)
      hm.emissiveMap = hm.map
      hm.emissiveIntensity = 0.05
      head.position.set(0, 0.34, 0.002)
      statusG.add(head)
      const names = ['MONITORING', 'BACKUPS', 'HARDENING']
      watch = names.map((name, i) => {
        const y = 0.12 - i * 0.22
        const p = neonFromStrokes([{ pts: [new THREE.Vector3(-0.5, y, 0.05), new THREE.Vector3(-0.2, y, 0.05)] }], {
          color: 'ice',
          radius: 0.014,
          hdr: 3.2,
          smooth: false,
          radial,
          caps: false,
        })
        statusG.add(p.group)
        const sp = neonSpill([{ pts: [new THREE.Vector3(-0.5, y, 0), new THREE.Vector3(-0.2, y, 0)] }], {
          color: 'ice',
          width: 0.62,
          height: 0.2,
          cx: -0.35,
          cy: y,
          blur: 0.035,
          strength: 0.5,
        })
        sp.position.z = 0.002
        statusG.add(sp)
        p.follow(sp)
        const lab = plate(0.6, 0.08, (g, _w, h) => monoText(g, name, 0, h * 0.54, h * 0.66, '#e4dde9', 600, 'left', 0.14), 1024)
        const lm = lab.material as THREE.MeshStandardMaterial
        lm.emissive.set(0xffffff)
        lm.emissiveMap = lm.map
        lm.emissiveIntensity = 0.06
        lab.position.set(0.17, y, 0.002)
        statusG.add(lab)
        return { part: p, s: new Striker({ stutters: i === 1 ? 0 : 1 }), level: 0 }
      })
      await nextFrame()

      // ---------------- transformers, conduit, cable
      const t1 = transformer()
      t1.group.position.copy(T1)
      group.add(t1.group)
      const t2 = transformer()
      t2.group.position.copy(T2)
      group.add(t2.group)
      sparkOrigin.copy(t1.boots[1]).add(T1)
      const V = (x: number, y: number, z = RUN_Z) => new THREE.Vector3(x, y, z)
      const hub = breaker.conduitAt.clone().add(BREAKER)
      group.add(conduit([V(hub.x, hub.y, 0.1), V(CONDUIT_X, hub.y, 0.1), V(CONDUIT_X, RUN_Y - 0.4), V(CONDUIT_X, RUN_Y), V(-6, RUN_Y)], { radial }))
      group.add(conduit([V(T1.x, RUN_Y), V(T1.x, T1.y + 0.1)], { radial }))
      group.add(conduit([V(T2.x, RUN_Y), V(T2.x, T2.y + 0.1)], { radial }))
      group.add(conduit([V(BREAKER.x + 0.25, BREAKER.y - breaker.height / 2, 0.1), V(BREAKER.x + 0.25, FLOOR_Y, 0.1)], { radial }))
      // tee boxes where the drops leave the run
      const teeG = new THREE.BoxGeometry(0.11, 0.11, 0.08)
      for (const x of [T1.x, T2.x]) {
        const tee = new THREE.Mesh(teeG, panelPaint())
        tee.position.set(x, RUN_Y, RUN_Z)
        group.add(tee)
      }
      group.add(
        straps([
          { p: V(-4.2, RUN_Y), along: 'x' },
          { p: V(-1.2, RUN_Y), along: 'x' },
          { p: V(0.9, RUN_Y), along: 'x' },
          { p: V(T1.x, 1.8), along: 'y' },
          { p: V(CONDUIT_X, 1.2, 0.1), along: 'y' },
          { p: V(CONDUIT_X, -0.3, 0.1), along: 'y' },
          { p: V(BREAKER.x + 0.25, -1.55, 0.1), along: 'y' },
        ]),
      )
      // GTO: T1 across into the board's left edge; T2 down to the 24/7 electrodes
      for (const [i, bt] of t1.boots.entries()) {
        const p = bt.clone().add(T1)
        const ex = BOARD.x - BOARD_W / 2 + 0.12
        const ey = BOARD.y + (i ? 0.25 : -0.05)
        group.add(cable([p, p.clone().add(new THREE.Vector3(0, -0.14 - i * 0.02, 0.03)), new THREE.Vector3((p.x + ex) / 2, ey - 0.12, 0.1), new THREE.Vector3(ex, ey, 0.04)]))
      }
      for (const [i, bt] of t2.boots.entries()) {
        const p = bt.clone().add(T2)
        const end = new THREE.Vector3(SEVEN.x + svEnds[i].x, SEVEN.y + svEnds[i].y, 0.03)
        group.add(cable([p, p.clone().add(new THREE.Vector3(0, -0.12, 0.03)), new THREE.Vector3((p.x + end.x) / 2, Math.min(p.y, end.y) - 0.18 - i * 0.1, 0.08), end]))
      }

      sparks = new Sparks(16, 3)
      group.add(sparks.mesh)

      // ---------------- lights: 3 RectAreaLights on desktop, 2 on phones (count
      // fixed at init; intensity only at runtime). The floor pool and the
      // spark glow are additive planes.
      halo = new THREE.RectAreaLight(cRed, 0, BOARD_W - 0.2, BOARD_H - 0.2)
      halo.position.set(BOARD.x, BOARD.y, 0.035)
      halo.lookAt(BOARD.x, BOARD.y, -2)
      group.add(halo)
      if (!ctx.mobile) {
        sevenLight = new THREE.RectAreaLight(cBlue, 0, 2.2, 0.8)
        sevenLight.position.set(SEVEN.x, SEVEN.y, 0.32)
        sevenLight.lookAt(SEVEN.x, SEVEN.y, -2)
        group.add(sevenLight)
      }
      // the sign's light pooled on the sealed floor in front of the board
      floorPool = glowPlane(BOARD_W + 1.2, 3.4, 'pool')
      floorPool.rotation.x = -Math.PI / 2
      floorPool.position.set(BOARD.x, FLOOR_Y + 0.004, 1.7)
      group.add(floorPool)
      // the arc's flare on the brick around the transformer boot
      sparkGlow = glowPlane(1.3, 1.3)
      sparkGlow.position.set(sparkOrigin.x, sparkOrigin.y - 0.1, 0.012)
      group.add(sparkGlow)
      // the utility corner's work light: key on the breaker column from the
      // right and in front (the bare fluorescent above it is the visible source)
      workLight = new THREE.RectAreaLight(new THREE.Color('#e6eeff'), 0, 1.6, 1.0)
      workLight.position.set(BREAKER.x + 0.9, 1.2, 1.6)
      workLight.lookAt(BREAKER.x - 0.1, 0.1, 0)
      group.add(workLight)
      fixture = fluorescentFixture(1.15, { light: false })
      fixture.group.position.copy(LAMP)
      group.add(fixture.group)

      // ---------------- DOM
      const dock = el('div', 'sh-dock', undefined, ctx.stage)
      copy = el('div', 'sh-copy hud-panel', undefined, dock)
      el('p', 'hud-eyebrow', SECURITY.eyebrow, copy)
      title = rise(el('h2', 'hud-title sh-title', undefined, copy), 'Hacked? <em class="is-blue">Breathe.</em>')
      // rise() re-wraps <em> without its class: put the argon back
      title.querySelectorAll('em').forEach(e => e.classList.add('is-blue'))
      el('p', 'hud-body sh-body', SECURITY.body, copy)
      const cta = el('a', 'hud-btn sh-cta', SECURITY.cta, copy)
      cta.href = SECURITY.href
      const st = el('div', 'sh-stat', undefined, copy)
      el('span', 'hud-lit sh-stat-v', stat.value, st)
      el('p', 'sh-stat-l', stat.label, st)

      const measure = () => {
        const H = window.innerHeight || 1
        const r = copy.getBoundingClientRect()
        if (!r.height) return
        band.top = Math.max(64, H * 0.085) / H
        // the panel's resting top (reveal() nudges it 14 px while fading in)
        band.bottom = Math.max(band.top + 0.14, (r.top - 14 - 12) / H)
        fitTall()
      }
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(measure)
        ro.observe(copy)
        ro.observe(ctx.stage)
      }
      document.fonts?.ready.then(measure).catch(() => {})
      measure()
    },

    update(local, frame, ctx) {
      const dt = frame.dt
      const quiet = ctx.reducedMotion || !!frame.still
      const calm = quiet || Math.abs(frame.velocity) > 2.5
      const t = frame.time
      let busy = false

      // ---------------- the breaker (time-based snap, settles < 0.4 s)
      const lv = lever.update(local >= LEVER_AT ? 1 : 0, dt, calm)
      breaker.setThrow(lv)
      if (lv !== (local >= LEVER_AT ? 1 : 0)) busy = true
      const tripped = lv < 0.5
      breaker.setPilot(tripped ? TUBE.red : TUBE.blue, tripped ? 3.2 : 2.6)

      // ---------------- the breach: fault clock (idle, time-based). It runs
      // only while the visitor rests in the breach, from the start of this
      // visit; after MAX_FAULTS the sign rests broken and steady (a11y: no
      // endless blink at rest).
      const inBreach = tripped && local > 0.05 && local < LEVER_AT
      const faulting = inBreach && !calm && Math.abs(frame.velocity) < FAULT_V
      if (!inBreach) breachRest = 0
      else if (faulting) breachRest += dt
      const tb = breachRest
      let k = -1
      while (k + 1 < MAX_FAULTS && faultAt(k + 1) <= tb) k++
      const age = k >= 0 ? tb - faultAt(k) : Infinity
      const victim = [2, 0, 2, 1][Math.max(0, k) % 4]
      const dropping = faulting && age < DROP
      // 0 → 1 as the last fault's echo dies: the wobble and the room sway settle
      const rest = quiet ? 1 : inBreach ? smoothstep(FAULTS_DONE, FAULTS_DONE + 2.5, tb) : 0
      const base = [1, 0.94, 0.62]
      // brownout (scroll-driven): the tripped circuit sags as the camera turns
      // to the breaker, so the pan sweeps dim tubes, not full-bright ones
      const sag = 1 - 0.6 * smoothstep(BROWN_AT, BROWN_AT + 0.06, local)
      let redMean = 0
      red.forEach((r, i) => {
        const want = tripped && !(dropping && victim === i)
        const lvl = r.s.update(want ? base[i] : 0, dt, calm)
        const live = 0.84 + 0.1 * Math.sin(t * (1.3 + i * 0.37) + i * 2.1) + 0.06 * Math.sin(t * 0.61 + i)
        r.level = lvl * lerp(live, REST[i], rest) * sag
        r.part.setLevel(r.level)
        redMean += r.level / 3
        if (Math.abs(lvl - (want ? base[i] : 0)) > 0.01) busy = true
      })
      redSpill.setLevel(redMean)

      // sparks + glitch ride the same events
      bursts.length = 0
      if (faulting && k >= 0 && tb < FAULTS_DONE + 0.2) {
        // a two-part crackle per fault: the arc, then a smaller echo
        for (const kk of [k, k - 1]) {
          if (kk < 0) continue
          const a = tb - faultAt(kk)
          if (a >= 0 && a < 0.7) bursts.push([a, kk * 2])
          if (a >= 0.2 && a < 0.9 && bursts.length < 3) bursts.push([a - 0.2, kk * 2 + 1])
        }
        const glow = sparks.update(sparkOrigin, bursts)
        sparksLive = true
        sparkGlow.setLight(cSpark, glow * 0.55)
        if (age < 0.09) ctx.post.params.glitch = 0.16
      } else {
        if (sparksLive) sparks.clear()
        sparksLive = false
        sparkGlow.setLight(cSpark, 0)
      }

      // a brisk scroll through the reset ramps the strikes (no stutter)
      const strikeCalm = calm || Math.abs(frame.velocity) > STRIKE_CALM_V

      // ---------------- breathe: argon strikes, writes itself, then breathes
      const blueOn = !tripped && local >= BLUE_AT
      const bl = blue.s.update(blueOn, dt, strikeCalm)
      if (Math.abs(bl - (blueOn ? 1 : 0)) > 0.01) busy = true
      const breath = quiet ? 1 : 0.875 + 0.125 * Math.sin(2 * Math.PI * 0.2 * t)
      blue.level = bl * breath
      blue.part.setLevel(blue.level)
      blue.part.setDraw(quiet ? 1 : 0.06 + 0.94 * smoothstep(BLUE_AT, DRAW_END, local))

      const sevenOn = !tripped && local >= SEVEN_AT
      seven.level = seven.s.update(sevenOn, dt, strikeCalm)
      seven.part.setLevel(seven.level)
      if (Math.abs(seven.level - (sevenOn ? 1 : 0)) > 0.01) busy = true

      watch.forEach((w, i) => {
        const on = !tripped && local >= WATCH_AT[i]
        w.level = w.s.update(on, dt, strikeCalm)
        w.part.setLevel(w.level)
        if (Math.abs(w.level - (on ? 1 : 0)) > 0.01) busy = true
      })

      // ---------------- the room: a fluorescent that sags on the faults
      const roomTarget = tripped ? (dropping ? 0.5 : 0.72 + 0.06 * (1 - rest) * Math.sin(t * 0.9)) : 1
      roomLevel += (roomTarget - roomLevel) * (1 - Math.exp(-dt / 0.09))
      fixture.setLevel(roomLevel)
      workLight.intensity = roomLevel * 7

      // ---------------- sign light on the room
      const share = blue.level / Math.max(1e-4, blue.level + redMean)
      cTmp.copy(cRed).lerp(cBlue, share)
      halo.color.copy(cTmp)
      halo.intensity = redMean * 22 + blue.level * 15
      floorPool.setLight(cTmp, redMean * 0.26 + blue.level * 0.2)
      if (sevenLight) sevenLight.intensity = seven.level * 7

      // ---------------- world + post
      const s = smoothstep(0.35, 0.42, local)
      const w = ctx.world.params
      cGlow.set(TUBE.red).lerp(cBlue, s)
      cBottom.set('#14060a').lerp(cTmp.set('#060a14'), s)
      cMote.set('#ffb49c').lerp(cTmp.set('#cfeaff'), s)
      w.glowColor = cGlow
      w.glow = lerp(0.2 + 0.3 * redMean, 0.34, s)
      w.bottom = cBottom
      w.moteColor = cMote
      w.motes = 0.55
      w.env = 0.62
      w.fill = 0.3

      // ---------------- copy
      const vis = smoothstep(0.385, 0.425, local) * (1 - smoothstep(0.93, 0.965, local))
      reveal(copy, vis)
      setRise(title, local > 0.39 && local < 0.95)
      // short portrait screens swap the body for the 24/7 legend on keep-watch (CSS)
      const watching = local > 0.64
      if (copy.classList.contains('is-watch') !== watching) copy.classList.toggle('is-watch', watching)

      settled = !busy
    },

    busy() {
      return !settled
    },

    onEnter() {
      breachRest = 0
    },

    onLeave() {
      sparks?.clear()
      sparksLive = false
      breachRest = 0
    },

    camera(local, frame, out) {
      const aspect = frame.width / Math.max(1, frame.height)
      solveShot(shotAt(aspect < 0.9 ? tall : WIDE, local), aspect, out)
      out.parallax = 0.22
    },
  }
}
