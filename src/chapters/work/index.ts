import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { CameraPose, Chapter, Frame } from '../../core/types'
import { el, rise, setRise, reveal } from '../../core/dom'
import { SECTIONS, WORK, workImage } from '../../content'
import { clamp, ease, lerp, smoothstep } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { beat } from '../common'
import { loadScreenshot, placeholderTexture, whenRevealed } from '../../kit/images'
import { blockoutMaterial, NeonPart, neonFromStrokes, neonSpill, Striker, TUBE, type TubeColor } from '../../kit/neon'
import { textStrokes, type Stroke } from '../../kit/type'
import { backerPanel, brickMaterial, concreteMaterial, initAreaLights } from '../../kit/shop'
import './work.css'

/*
 * WORK · THE SIGN WALL. The back wall of the shop, black-plum brick, where
 * finished signs hang waiting for pickup. Each featured project is a slim
 * black lightbox whose face is the site's screenshot (backlit, below the
 * bloom threshold), ringed by a neon frame in its own colour, its name bent
 * in tube lettering above it. The camera trucks along the wall; each sign
 * strikes on as it arrives (its name writes itself) and cuts out as you
 * leave. At the end of the wall, the pickup board: the nine other sites
 * bent in amber under a pink "ready for pickup", then the camera pulls
 * back along the whole wall, every frame lit, into the cut.
 *
 * Everything derives from `local`; Strikers are the only time-based state
 * (they settle in < 0.5 s). Lights: 5 RectAreaLights, count fixed; the two
 * wall halos and two floor washes alternate between even and odd signs and
 * move with the camera.
 */
const FEATURED = WORK.filter(w => w.featured)
const REST = WORK.filter(w => !w.featured)
const isPreview = (url: string) => /harktest\.com/.test(url)
const N = FEATURED.length

// ---- the wall layout (world units ≈ metres; wall face z = 0, floor y = 0)
const SP = 4.6 // sign spacing along the wall
const FACE_W = 2.4
const FACE_H = 1.5 // 16:10, the screenshots' aspect
const BEZEL = 0.07
const BOX_W = FACE_W + BEZEL * 2
const BOX_H = FACE_H + BEZEL * 2
const BOX_D = 0.12
const BOX_Z = 0.035 // back of the lightbox (on hidden standoffs)
const FACE_Z = BOX_Z + BOX_D + 0.0015
const FR_PAD = 0.14
const FR_W = BOX_W + FR_PAD * 2
const FR_H = BOX_H + FR_PAD * 2
const FR_R = 0.17
const FR_Z = 0.1
const SIGN_Y = 1.72
const BOARD_X = N * SP + 0.9
const FACE_MAX = 0.85 // screenshots stay under the bloom threshold

/** each sign's tube colour (no two neighbours alike) and its lettering */
const SPECS: { color: TubeColor; font: 'script' | 'sans'; dy: number }[] = [
  { color: 'pink', font: 'script', dy: 0.04 },
  { color: 'blue', font: 'sans', dy: -0.05 },
  { color: 'amber', font: 'script', dy: 0.07 },
  { color: 'violet', font: 'sans', dy: -0.02 },
  { color: 'red', font: 'script', dy: 0.05 },
  { color: 'white', font: 'sans', dy: -0.04 },
]
/*
 * Bloom vs. the screenshots: a long frame tube round a lightbox pours enough
 * light into bloom's widest mips to veil the screenshot in its colour. So
 * this chapter blooms at a higher threshold (BLOOM_T) and every tube's HDR
 * is set per colour so only the hot CORE of the glass crosses it (the
 * edges don't): the glow stays on the tube and the screenshot stays true.
 * Numbers: the kit's tube shader puts the facing core at luminance ≈
 * CORE[c] · hdr and the silhouette at ≈ EDGE[c] · hdr.
 */
const BLOOM_T = 1.2
const CORE: Record<string, number> = { pink: 0.49, blue: 0.518, amber: 0.605, violet: 0.436, red: 0.477, white: 0.9 }
const EDGE: Record<string, number> = { pink: 0.25, blue: 0.28, amber: 0.367, violet: 0.199, red: 0.24, white: 0.66 }
/** hdr so the core reaches luminance `lum` while the glass edge stays under the threshold */
const hdrFor = (c: TubeColor, lum: number) => Math.min(lum / (CORE[c] ?? 0.5), (BLOOM_T * 0.93) / (EDGE[c] ?? 0.3))
const FRAME_LUM = 1.42
const NAME_LUM = 1.66

// ---- the story schedule (local 0..1)
const A = 0.1
const E = 0.84
const SPAN = (E - A) / N
const T = 0.027 // half a travel between two signs
/** travel k runs from station k to k+1; stations: 0 intro, 1..N signs, N+1 the pickup board */
const TRAVEL: [number, number][] = [[0.08, 0.108]]
for (let i = 1; i < N; i++) TRAVEL.push([A + SPAN * i - T, A + SPAN * i + T])
TRAVEL.push([0.832, 0.858])
const BOARD = N + 1
const OUTRO = 0.935

/** where the story is: station k, travel progress t (0 = holding), hold progress h */
function where(local: number) {
  for (let k = 0; k < TRAVEL.length; k++) {
    const [s, e] = TRAVEL[k]
    if (local < s) {
      const hs = k === 0 ? 0 : TRAVEL[k - 1][1]
      return { k, t: 0, h: clamp((local - hs) / (s - hs)) }
    }
    if (local < e) return { k, t: (local - s) / (e - s), h: 1 }
  }
  const hs = TRAVEL[TRAVEL.length - 1][1]
  return { k: BOARD, t: 0, h: clamp((local - hs) / (OUTRO - hs)) }
}
/**
 * 0..1 visibility of station k's copy: full while the camera holds on it,
 * out early in the travel away (the eased camera has barely moved), in late
 * in the travel toward it (the camera has all but arrived)
 */
function holdVis(local: number, k: number) {
  const inT = TRAVEL[k - 1]
  const outT = TRAVEL[k] as [number, number] | undefined
  const tin = clamp((local - inT[0]) / (inT[1] - inT[0]))
  const tout = outT ? clamp((local - outT[0]) / (outT[1] - outT[0])) : clamp((local - OUTRO + 0.004) / 0.03)
  return smoothstep(0.7, 0.93, tin) * (1 - smoothstep(0.07, 0.3, tout))
}

/** an open rounded rectangle (gap at the bottom centre for the electrodes) */
function roundRect(w: number, h: number, r: number, z: number, gap = 0.07): Stroke {
  const pts: THREE.Vector3[] = []
  const hw = w / 2
  const hh = h / 2
  const arc = (cx: number, cy: number, a0: number) => {
    for (let k = 0; k <= 10; k++) {
      const a = a0 + (k / 10) * (Math.PI / 2)
      pts.push(new THREE.Vector3(cx + Math.cos(a) * r, cy + Math.sin(a) * r, z))
    }
  }
  pts.push(new THREE.Vector3(gap / 2, -hh, z))
  arc(hw - r, -hh + r, -Math.PI / 2)
  arc(hw - r, hh - r, 0)
  arc(-hw + r, hh - r, Math.PI / 2)
  arc(-hw + r, -hh + r, Math.PI)
  pts.push(new THREE.Vector3(-gap / 2, -hh, z))
  return { pts }
}

/**
 * Small lettering as a flat, tube-shaded ribbon lit by the kit's own tube
 * shader (a NeonPart: same level / draw / colour API). Round glass plus a
 * sphere cap on every stroke end cost ~114k triangles for the pickup board's
 * nine names, which render a few pixels tall; this is ~1/6 of that. Three
 * vertices across (edge, core, edge) with normals rolled toward the edges
 * give the same hot-core / cool-rim falloff.
 */
function ribbonPart(strokes: Stroke[], color: TubeColor, radius: number, hdr: number) {
  const lens = strokes.map(st => {
    let l = 0
    for (let i = 1; i < st.pts.length; i++) l += st.pts[i].distanceTo(st.pts[i - 1])
    return l
  })
  const total = lens.reduce((a, b) => a + b, 0) || 1
  const pos: number[] = []
  const nor: number[] = []
  const arc: number[] = []
  const idx: number[] = []
  const t = new THREE.Vector3()
  const sd = new THREE.Vector3()
  let acc = 0
  strokes.forEach((st, si) => {
    const P = st.pts
    if (P.length < 2) return
    const base = pos.length / 3
    let run = 0
    for (let i = 0; i < P.length; i++) {
      const a = P[Math.max(0, i - 1)]
      const b = P[Math.min(P.length - 1, i + 1)]
      t.subVectors(b, a).normalize()
      sd.set(-t.y, t.x, 0)
      if (i > 0) run += P[i].distanceTo(P[i - 1])
      const u = (acc + run) / total
      for (const k of [-1, 0, 1]) {
        pos.push(P[i].x + sd.x * radius * k, P[i].y + sd.y * radius * k, P[i].z + (k === 0 ? radius * 0.5 : 0))
        const nx = sd.x * k * 0.9
        const ny = sd.y * k * 0.9
        const nz = k === 0 ? 1 : 0.44
        const nl = Math.hypot(nx, ny, nz)
        nor.push(nx / nl, ny / nl, nz / nl)
        arc.push(u)
      }
      if (i > 0) {
        const r0 = base + (i - 1) * 3
        const r1 = base + i * 3
        idx.push(r0, r1, r0 + 1, r0 + 1, r1, r1 + 1, r0 + 1, r1 + 1, r0 + 2, r0 + 2, r1 + 1, r1 + 2)
      }
    }
    acc += lens[si]
  })
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  g.setAttribute('aArc', new THREE.Float32BufferAttribute(arc, 1))
  g.setIndex(idx)
  const part = new NeonPart(g, TUBE[color], hdr, null, blockoutMaterial())
  part.material.side = THREE.DoubleSide
  part.length = total
  return part
}

/**
 * Six pickup tickets in one small canvas (decorative job tickets: "PICKUP",
 * a job number, a READY stamp). Bound blank at init; draw() fills it once
 * the mono face has loaded.
 */
function ticketAtlas() {
  const W = 128
  const H = 192
  const c = document.createElement('canvas')
  c.width = W * N
  c.height = H
  const g = c.getContext('2d')!
  const paper = () => {
    for (let i = 0; i < N; i++) {
      g.fillStyle = '#b5a37f'
      g.fillRect(i * W, 0, W, H)
      g.fillStyle = 'rgba(120, 90, 50, 0.16)'
      g.fillRect(i * W, H - 10, W, 10)
      g.fillStyle = 'rgba(255, 250, 235, 0.18)'
      g.fillRect(i * W, 0, W, 6)
    }
  }
  paper()
  const texture = new THREE.CanvasTexture(c)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return {
    texture,
    draw() {
      paper()
      const mono = '"Azeret Mono Variable", ui-monospace, monospace'
      for (let i = 0; i < N; i++) {
        const x = i * W
        // punched hole with a reinforcing ring
        g.fillStyle = '#b09a6e'
        g.beginPath()
        g.arc(x + W / 2, 18, 9, 0, Math.PI * 2)
        g.fill()
        g.fillStyle = '#141116'
        g.beginPath()
        g.arc(x + W / 2, 18, 4.5, 0, Math.PI * 2)
        g.fill()
        g.fillStyle = '#2a2320'
        g.textAlign = 'center'
        g.font = `700 17px ${mono}`
        g.fillText('PICKUP', x + W / 2, 52)
        g.fillRect(x + 14, 60, W - 28, 2)
        g.font = `500 11px ${mono}`
        g.fillText('JOB', x + W / 2, 82)
        g.font = `700 26px ${mono}`
        g.fillText(`26-0${i + 1}`, x + W / 2, 110)
        g.fillRect(x + 14, 122, W - 28, 1)
        // the stamp
        g.save()
        g.translate(x + W / 2, 152)
        g.rotate(-0.2 + 0.07 * (i % 3))
        g.strokeStyle = 'rgba(24, 30, 72, 0.88)'
        g.lineWidth = 3
        g.strokeRect(-44, -17, 88, 32)
        g.fillStyle = 'rgba(24, 30, 72, 0.88)'
        g.font = `800 20px ${mono}`
        g.fillText('READY', 0, 7)
        g.restore()
      }
      texture.needsUpdate = true
    },
  }
}

interface Tube {
  part: NeonPart
  s: Striker
}
interface Sign {
  x: number
  y: number
  color: TubeColor
  frame: Tube
  name: Tube
  face: THREE.MeshBasicMaterial
  faceS: Striker
  /** framing box (world): centre + size */
  box: { cx: number; cy: number; w: number; h: number }
}

type Pose = { p: THREE.Vector3; t: THREE.Vector3 }
const pose = (): Pose => ({ p: new THREE.Vector3(), t: new THREE.Vector3() })

/** fit a world box (on the wall plane) into an NDC region [x0, y0, x1, y1] (y up), camera square to the wall */
function fit(out: Pose, cx: number, cy: number, bw: number, bh: number, r: number[], fov: number, aspect: number, z = 0.1) {
  const tan = Math.tan((fov * Math.PI) / 360)
  const rw = r[2] - r[0]
  const rh = r[3] - r[1]
  const d = Math.max(bw / (rw * tan * aspect), bh / (rh * tan))
  const halfH = d * tan
  const halfW = halfH * aspect
  out.t.set(cx - ((r[0] + r[2]) / 2) * halfW, cy - ((r[1] + r[3]) / 2) * halfH, z)
  out.p.set(out.t.x, out.t.y, z + d)
  return d
}

const _d = new THREE.Vector3()
const _r = new THREE.Vector3()
const _u = new THREE.Vector3()
/** aim a camera at `p` so the world point `s` lands at NDC (nx, ny) */
function aim(out: Pose, p: THREE.Vector3, s: THREE.Vector3, nx: number, ny: number, fov: number, aspect: number) {
  const tv = Math.tan((fov * Math.PI) / 360)
  _d.subVectors(s, p).normalize()
  _r.crossVectors(_d, THREE.Object3D.DEFAULT_UP).normalize()
  _u.crossVectors(_r, _d)
  // the view axis sits opposite the offset: rotate the direction by -offset
  const ox = Math.atan(nx * tv * aspect)
  const oy = Math.atan(ny * tv)
  _d.applyAxisAngle(_u, ox).applyAxisAngle(_r, -oy)
  out.p.copy(p)
  out.t.copy(p).addScaledVector(_d, p.distanceTo(s))
}

export default function create(): Chapter {
  const group = new THREE.Group()
  const signs: Sign[] = []
  const board = {
    frame: null as Tube | null,
    head: null as Tube | null,
    list: null as Tube | null,
    box: { cx: BOARD_X, cy: 2.1, w: 3.4, h: 4 },
  }
  // lights (count fixed: 5)
  let haloE: THREE.RectAreaLight, haloO: THREE.RectAreaLight, floorE: THREE.RectAreaLight, floorO: THREE.RectAreaLight, haloB: THREE.RectAreaLight
  let intro: HTMLElement, introTitle: HTMLElement
  let card: HTMLElement, meta: HTMLElement, name: HTMLElement, blurb: HTMLElement, tags: HTMLElement, visit: HTMLAnchorElement
  let rest: HTMLElement
  let shown = -1
  /** a strike or a lightbox fade is still ramping (keeps the Motion-off heartbeat awake) */
  let settling = false
  let cardW = 400
  let cardH = 290
  let restW = 400
  let restH = 320
  // camera poses, rebuilt when the viewport or the copy's size changes
  const poses = {
    key: '',
    fov: 36,
    introFov: 36,
    introA: pose(),
    introB: pose(),
    signs: Array.from({ length: N }, pose),
    dist: new Array<number>(N).fill(8),
    board: pose(),
    boardD: 8,
    outro: pose(),
  }
  const tmpA = pose()
  const tmpB = pose()

  function buildPoses(frame: Frame) {
    const W = frame.width || 1440
    const H = frame.height || 900
    const portrait = H > W
    const key = `${W}x${H}:${portrait ? cardH + ',' + restH : cardW + ',' + restW}`
    if (key === poses.key) return
    poses.key = key
    const aspect = W / H
    const gutter = clamp(W * 0.034, 16, 48)
    const safeTop = clamp(H * 0.105, 80, 112)
    const safeBot = clamp(H * 0.105, 82, 110)
    const nx = (px: number) => (px / W) * 2 - 1
    const ny = (py: number) => 1 - (py / H) * 2
    const region = (pw: number, ph: number) =>
      portrait
        ? [nx(gutter + 4), ny(H - safeBot - ph - 20), nx(W - gutter - 4), ny(safeTop + 8)]
        : [nx(gutter + pw + 70), ny(H - safeBot - 30), nx(W - gutter - 100), ny(safeTop + 20)]
    const fov = portrait ? 40 : 36
    poses.fov = fov
    const rc = region(cardW, cardH)
    signs.forEach((s, i) => {
      const P = poses.signs[i]
      poses.dist[i] = fit(P, s.box.cx, s.box.cy, s.box.w, s.box.h, rc, fov, aspect)
      // a touch left of square and a little above: the wall recedes to the right
      P.p.x -= 0.32
      P.p.y += 0.12
    })
    const rr = region(restW, restH)
    const b = board.box
    poses.boardD = fit(poses.board, b.cx, b.cy, b.w, b.h, rr, fov, aspect)
    poses.board.p.x -= 0.3
    poses.board.p.y += 0.1
    // intro: down the wall from its near end, the first sign glowing ahead
    const x0 = signs[0]?.x ?? 0
    poses.introFov = fov
    if (portrait) {
      // phones: the headline owns the top; the first sign glows below it,
      // seen a little from the left so the wall still reads in perspective
      const s0 = signs[0]
      const c = new THREE.Vector3(x0, s0 ? s0.box.cy : SIGN_Y, 0.1)
      const z = clamp(4.6 / aspect, 5.8, 10.5)
      aim(poses.introA, new THREE.Vector3(x0 - z * 0.46, 2.15, z), c, 0.06, -0.14, fov, aspect)
      aim(poses.introB, new THREE.Vector3(x0 - z * 0.4, 2.1, z * 0.94), c, 0.06, -0.14, fov, aspect)
    } else {
      // down the wall from its near end: the headline over the dark near
      // bricks on the left, the first sign lit right of it, the rest receding
      const s0 = signs[0]
      const c = new THREE.Vector3(x0, s0 ? s0.box.cy : SIGN_Y, 0.1)
      const nx0 = aspect < 1.45 ? 0.36 : 0.3
      const f0 = (poses.introFov = 44)
      aim(poses.introA, new THREE.Vector3(x0 - 6.8, 2.0, 3.6), c, nx0, 0.04, f0, aspect)
      aim(poses.introB, new THREE.Vector3(x0 - 6.15, 1.97, 3.5), c, nx0, 0.04, f0, aspect)
    }
    // outro: pull back down the whole wall from its far end, every frame lit
    if (portrait) {
      poses.outro.p.set(BOARD_X + 1.5, 2.2, 9.5)
      poses.outro.t.set(BOARD_X - 7, 1.7, 0)
    } else {
      poses.outro.p.set(BOARD_X + 3.2, 2.1, 6.2)
      poses.outro.t.set(BOARD_X - 9.5, 1.65, 0)
    }
  }

  /** the pose held at station k, hold progress h (a slow truck right + a slight push-in) */
  function holdPose(out: Pose, k: number, h: number) {
    if (k === 0) {
      out.p.lerpVectors(poses.introA.p, poses.introB.p, h)
      out.t.lerpVectors(poses.introA.t, poses.introB.t, h)
      return
    }
    const P = k === BOARD ? poses.board : poses.signs[k - 1]
    const d = k === BOARD ? poses.boardD : poses.dist[k - 1]
    const x = (h - 0.5) * 0.22
    out.p.copy(P.p)
    out.t.copy(P.t)
    out.p.x += x
    out.t.x += x * 0.8
    out.p.z -= d * 0.045 * h
  }

  const tube = (part: NeonPart, s: Striker): Tube => ({ part, s })

  return {
    id: 'work',
    group,
    // featured first, then the nine others (srContent / WORK order)
    anchors: [...beat(0, N, A, E).centers, ...REST.map(() => 0.9)],
    async init(ctx) {
      initAreaLights()
      const radial = ctx.mobile ? 6 : 8
      const wallW = BOARD_X + 22
      const wallX = BOARD_X / 2
      // the wall: black-plum painted brick
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(wallW, 6.4), brickMaterial({ tint: '#2e2230', width: wallW, height: 6.4, tile: 1.5 }))
      wall.position.set(wallX, 3.2, 0)
      group.add(wall)
      // sealed concrete floor
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(wallW, 18), concreteMaterial({ width: wallW, depth: 18, roughness: 0.26 }))
      floor.rotation.x = -Math.PI / 2
      floor.position.set(wallX, 0, 9)
      group.add(floor)
      // a painted skirting where they meet
      const skirt = new THREE.Mesh(new THREE.BoxGeometry(wallW, 0.14, 0.03), new THREE.MeshStandardMaterial({ color: 0x0c0a0e, roughness: 0.5 }))
      skirt.position.set(wallX, 0.07, 0.015)
      group.add(skirt)

      const boxMat = new THREE.MeshStandardMaterial({ color: 0x0a090c, roughness: 0.34, metalness: 0.25, envMapIntensity: 0.7 })
      const boxGeo = new THREE.BoxGeometry(BOX_W, BOX_H, BOX_D)
      const faceGeo = new THREE.PlaneGeometry(FACE_W, FACE_H)
      const hardware: THREE.BufferGeometry[] = []
      const tickets: THREE.BufferGeometry[] = []
      const strings: THREE.BufferGeometry[] = []
      const cords: THREE.BufferGeometry[] = []

      for (let i = 0; i < N; i++) {
        const spec = SPECS[i % SPECS.length]
        const w = FEATURED[i]
        const x = i * SP
        const y = SIGN_Y + spec.dy
        const g = new THREE.Group()
        g.position.set(x, y, 0)
        group.add(g)
        // lightbox
        const box = new THREE.Mesh(boxGeo, boxMat)
        box.position.z = BOX_Z + BOX_D / 2
        g.add(box)
        const faceMat = new THREE.MeshBasicMaterial({ map: placeholderTexture('#15121a'), toneMapped: false, color: new THREE.Color(0, 0, 0) })
        const face = new THREE.Mesh(faceGeo, faceMat)
        face.position.z = FACE_Z
        g.add(face)
        // neon frame
        const fs = roundRect(FR_W, FR_H, FR_R, FR_Z)
        const frame = neonFromStrokes([fs], { color: spec.color, radius: 0.016, hdr: hdrFor(spec.color, FRAME_LUM), smooth: false, radial })
        g.add(frame.group)
        const fsp = neonSpill([fs], { color: spec.color, width: FR_W + 1.5, height: FR_H + 1.5, blur: 0.16, strength: 0.34 })
        fsp.position.set(0, 0, 0.004)
        ;(fsp.material as THREE.MeshBasicMaterial).fog = false
        g.add(fsp)
        frame.follow(fsp)
        // the name, bent above the frame
        const probe = textStrokes(w.name, { font: spec.font, size: 1 })
        const cap = Math.min(spec.font === 'script' ? 0.27 : 0.21, (FR_W * 0.94) / probe.width)
        const txt = textStrokes(w.name, { font: spec.font, size: cap, tracking: spec.font === 'sans' ? 0.06 : 0 })
        const ny = FR_H / 2 + 0.2 + cap * (spec.font === 'script' ? 0.85 : 0.6)
        const nm = neonFromStrokes(txt.strokes, { color: spec.color, radius: cap / 30, hdr: hdrFor(spec.color, NAME_LUM), radial })
        nm.group.position.set(0, ny, 0.075)
        g.add(nm.group)
        const nsp = neonSpill(txt.strokes, { color: spec.color, width: txt.width + 0.9, height: cap * 2.6 + 0.7, blur: 0.09, strength: 0.32 })
        nsp.position.set(0, ny, 0.004)
        ;(nsp.material as THREE.MeshBasicMaterial).fog = false
        g.add(nsp)
        nm.follow(nsp)
        // a paper pickup ticket on a string from the frame's lower left (merged below)
        {
          const tw = 0.2
          const th = 0.3
          const tx = x - FR_W / 2 + 0.42
          const top = y - FR_H / 2 - 0.1
          const tg = new THREE.PlaneGeometry(tw, th)
          const uv = tg.attributes.uv as THREE.BufferAttribute
          for (let k = 0; k < uv.count; k++) uv.setX(k, (i + uv.getX(k)) / N)
          tg.rotateZ((i % 2 ? 1 : -1) * (0.06 + 0.03 * (i % 3)))
          tg.translate(tx, top - th / 2, 0.06 + 0.004 * i)
          tickets.push(tg)
          const sp = new THREE.CatmullRomCurve3([
            new THREE.Vector3(tx - 0.03, y - FR_H / 2 + 0.005, FR_Z - 0.01),
            new THREE.Vector3(tx - 0.012, top + 0.03, 0.07),
            new THREE.Vector3(tx, top - 0.03, 0.065),
          ])
          const sg = new THREE.TubeGeometry(sp, 10, 0.0025, 4, false)
          sg.deleteAttribute('uv')
          strings.push(sg)
        }
        // transformer box + power cord to the floor (merged below)
        const tx = x + FR_W / 2 - 0.34
        const ty = y - FR_H / 2 - 0.34
        const tb = new THREE.BoxGeometry(0.24, 0.15, 0.09)
        tb.translate(tx, ty, 0.045)
        hardware.push(tb)
        const cp = new THREE.CatmullRomCurve3([
          new THREE.Vector3(tx + 0.06, ty - 0.07, 0.05),
          new THREE.Vector3(tx + 0.1, ty - 0.4, 0.035),
          new THREE.Vector3(tx + 0.16, 0.5, 0.02),
          new THREE.Vector3(tx + 0.2, 0.012, 0.06),
          new THREE.Vector3(tx + 0.45, 0.012, 0.28),
        ])
        const cg = new THREE.TubeGeometry(cp, 40, 0.009, 5, false)
        cg.deleteAttribute('uv')
        cords.push(cg)
        // the frame's GTO lead into the transformer
        const lp = new THREE.CatmullRomCurve3([
          new THREE.Vector3(x + 0.05, y - FR_H / 2, 0.02),
          new THREE.Vector3(x + 0.6, ty + 0.05, 0.02),
          new THREE.Vector3(tx - 0.12, ty, 0.03),
        ])
        const lg = new THREE.TubeGeometry(lp, 24, 0.006, 5, false)
        lg.deleteAttribute('uv')
        cords.push(lg)
        signs.push({
          x,
          y,
          color: spec.color,
          frame: tube(frame, new Striker({ stutters: i % 2 ? 1 : 2 })),
          name: tube(nm, new Striker({ stutters: 0, ramp: 0.18 })),
          face: faceMat,
          faceS: new Striker({ stutters: 0, ramp: 0.35, off: 0.3 }),
          box: {
            cx: x,
            cy: y + (ny + cap * 0.75 - FR_H / 2) / 2,
            w: Math.max(FR_W, txt.width) + 0.36,
            h: ny + cap * 0.75 + FR_H / 2 + 0.26,
          },
        })
        await nextFrame()
      }

      // ---- the pickup board: the nine other sites, bent in amber
      {
        const list = textStrokes(REST.map(w => w.name).join('\n'), { font: 'sans', size: 0.118, lineHeight: 2.4, align: 'left', tracking: 0.05 })
        const HC = 0.3
        const head = textStrokes('ready for pickup', { font: 'script', size: HC })
        const bw = Math.max(list.width, head.width) + 0.7
        const bh = 0.3 + HC * 1.25 + 0.4 + list.height + 0.36
        const by = 2.05
        const bg = new THREE.Group()
        bg.position.set(BOARD_X, by, 0.07)
        group.add(bg)
        bg.add(backerPanel(bw, bh, { material: new THREE.MeshStandardMaterial({ color: 0x060508, roughness: 0.3, metalness: 0, envMapIntensity: 0.25 }) }))
        const headY = bh / 2 - 0.3 - HC * 0.75
        const hp = neonFromStrokes(head.strokes, { color: 'pink', radius: HC / 28, hdr: hdrFor('pink', NAME_LUM), radial })
        hp.group.position.set(0, headY, 0.045)
        bg.add(hp.group)
        const hsp = neonSpill(head.strokes, { color: 'pink', width: head.width + 0.8, height: 1.1, blur: 0.09, strength: 0.35 })
        hsp.position.set(0, headY, 0.002)
        ;(hsp.material as THREE.MeshBasicMaterial).fog = false
        bg.add(hsp)
        hp.follow(hsp)
        const listY = headY - HC * 0.5 - 0.4 - list.height / 2
        // small lettering: a ribbon (see ribbonPart), no blockout jumpers (they read as
        // scratches across the names at this size), just under the bloom threshold
        // (thin tubes on phones bloomed only at their end caps: a rash of dots).
        // The spill behind is the glow.
        const lp = ribbonPart(list.strokes, 'amber', 0.118 / 26, hdrFor('amber', BLOOM_T * 0.97))
        lp.group.position.set(0, listY, 0.04)
        bg.add(lp.group)
        const lsp = neonSpill(list.strokes, { color: 'amber', width: list.width + 0.6, height: list.height + 0.6, blur: 0.06, strength: 0.34 })
        lsp.position.set(0, listY, 0.002)
        ;(lsp.material as THREE.MeshBasicMaterial).fog = false
        bg.add(lsp)
        lp.follow(lsp)
        // the board's frame on the wall around it
        const bfs = roundRect(bw + 0.3, bh + 0.3, 0.18, 0.09)
        const bf = neonFromStrokes([bfs], { color: 'blue', radius: 0.016, hdr: hdrFor('blue', FRAME_LUM), smooth: false, radial })
        bf.group.position.set(BOARD_X, by, 0)
        group.add(bf.group)
        const bfsp = neonSpill([bfs], { color: 'blue', width: bw + 1.6, height: bh + 1.6, blur: 0.16, strength: 0.32 })
        bfsp.position.set(BOARD_X, by, 0.004)
        ;(bfsp.material as THREE.MeshBasicMaterial).fog = false
        group.add(bfsp)
        bf.follow(bfsp)
        board.frame = tube(bf, new Striker({ stutters: 1 }))
        board.head = tube(hp, new Striker({ stutters: 2 }))
        board.list = tube(lp, new Striker({ stutters: 0, ramp: 0.2 }))
        board.box = { cx: BOARD_X, cy: by, w: bw + 0.6, h: bh + 0.5 }
        // its cord
        const cp = new THREE.CatmullRomCurve3([
          new THREE.Vector3(BOARD_X + bw / 2 - 0.3, by - bh / 2, 0.03),
          new THREE.Vector3(BOARD_X + bw / 2 - 0.25, 0.4, 0.02),
          new THREE.Vector3(BOARD_X + bw / 2 - 0.1, 0.012, 0.08),
          new THREE.Vector3(BOARD_X + bw / 2 + 0.4, 0.012, 0.4),
        ])
        const cg = new THREE.TubeGeometry(cp, 30, 0.009, 5, false)
        cg.deleteAttribute('uv')
        cords.push(cg)
      }
      const ticketTex = ticketAtlas()
      const tk = new THREE.Mesh(mergeGeometries(tickets, false)!, new THREE.MeshStandardMaterial({ map: ticketTex.texture, roughness: 0.92, metalness: 0, side: THREE.DoubleSide }))
      group.add(tk)
      const st = new THREE.Mesh(mergeGeometries(strings, false)!, new THREE.MeshStandardMaterial({ color: 0x8a7d6a, roughness: 0.9 }))
      group.add(st)
      tickets.forEach(g => g.dispose())
      strings.forEach(g => g.dispose())
      const hw = new THREE.Mesh(mergeGeometries(hardware, false)!, new THREE.MeshStandardMaterial({ color: 0x17151a, roughness: 0.5, metalness: 0.4 }))
      group.add(hw)
      const cord = new THREE.Mesh(mergeGeometries(cords, false)!, new THREE.MeshStandardMaterial({ color: 0x050406, roughness: 0.45 }))
      group.add(cord)
      hardware.forEach(g => g.dispose())
      cords.forEach(g => g.dispose())

      // ---- lights: two wall halos + two floor washes that alternate even/odd signs, one for the board
      const mk = (w: number, h: number) => {
        const l = new THREE.RectAreaLight(0xffffff, 0, w, h)
        group.add(l)
        return l
      }
      haloE = mk(FR_W, FR_H)
      haloO = mk(FR_W, FR_H)
      floorE = mk(FR_W * 0.9, 0.08)
      floorO = mk(FR_W * 0.9, 0.08)
      haloB = mk(board.box.w * 0.7, board.box.h * 0.7)
      haloB.color.set(TUBE.pink).lerp(new THREE.Color(TUBE.amber), 0.5)
      haloB.position.set(BOARD_X, board.box.cy, 0.035)
      haloB.lookAt(BOARD_X, board.box.cy, -1)

      // ---- copy
      intro = el('div', 'wk-intro', undefined, ctx.stage)
      el('p', 'hud-eyebrow', SECTIONS.work.eyebrow, intro)
      introTitle = rise(el('h2', 'hud-h2 wk-title', undefined, intro), 'Built to be <em>heard.</em>')
      card = el('div', 'wk-card hud-panel', undefined, ctx.stage)
      meta = el('p', 'hud-label wk-meta', '', card)
      name = el('h3', 'wk-name', '', card)
      blurb = el('p', 'hud-body wk-blurb', '', card)
      tags = el('ul', 'hud-tags', undefined, card)
      visit = el('a', 'hud-btn hud-btn--ghost wk-visit', '', card)
      visit.target = '_blank'
      visit.rel = 'noopener'
      rest = el('div', 'wk-card wk-rest hud-panel', undefined, ctx.stage)
      el('h3', 'wk-name wk-rest-title', 'Nine more, all live.', rest)
      const list = el('ul', 'wk-list', undefined, rest)
      for (const w of REST) {
        const a = el('a', '', w.name, el('li', '', undefined, list))
        el('span', 'wk-arrow', ' ↗', a).setAttribute('aria-hidden', 'true')
        a.href = w.url
        a.target = '_blank'
        a.rel = 'noopener'
      }
      const hello = el('button', 'hud-btn', 'Say hello', rest)
      hello.type = 'button'
      hello.addEventListener('click', () => window.__hark?.land('contact'))
      if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(() => {
          cardW = card.offsetWidth || cardW
          cardH = card.offsetHeight || cardH
          restW = rest.offsetWidth || restW
          restH = rest.offsetHeight || restH
        }).observe(card)
        new ResizeObserver(() => {
          restW = rest.offsetWidth || restW
          restH = rest.offsetHeight || restH
        }).observe(rest)
      }

      // first screenshot right away, the rest after the reveal (decoded off the main thread)
      const load = (i: number) =>
        loadScreenshot(workImage(FEATURED[i].id), { width: 1024 })
          .then(t => {
            const m = signs[i].face
            m.map?.dispose()
            m.map = t
            m.needsUpdate = true
          })
          .catch(() => {})
      load(0)
      // the tickets' lettering once the mono face is in (the atlas is bound blank now: no recompile later)
      whenRevealed()
        .then(() => document.fonts?.load('600 20px "Azeret Mono Variable"').catch(() => undefined))
        .then(() => ticketTex.draw())
        .catch(() => ticketTex.draw())
      whenRevealed().then(async () => {
        for (let i = 1; i < N; i++) await load(i)
      })
    },
    busy: () => settling,
    onEnter() {
      // strike fresh on every entry (the cut is lights-out / strike)
      for (const s of signs) {
        s.frame.s.set(0)
        s.name.s.set(0)
      }
      for (const t of [board.frame, board.head, board.list]) t?.s.set(0)
    },
    update(local, frame, ctx) {
      const dt = frame.dt
      const calm = ctx.reducedMotion || !!frame.still || Math.abs(frame.velocity) > 2.5
      const quiet = ctx.reducedMotion || !!frame.still
      const outro = local >= OUTRO
      const w = where(local)
      const track = w.k + ease.inOutCubic(w.t) // 0 intro, 1..N signs, N+1 board
      settling = false
      const mid = (v: number) => {
        if (v > 0.002 && v < 0.998) settling = true
      }

      for (let i = 0; i < N; i++) {
        const s = signs[i]
        const k = i + 1
        // strikes ~55% into the travel that brings it in; cuts ~35% into the travel out
        const inT = TRAVEL[k - 1]
        const outT = TRAVEL[k]
        const strikeAt = i === 0 ? -1 : lerp(inT[0], inT[1], 0.55)
        const cutAt = lerp(outT[0], outT[1], 0.35)
        const on = (local >= strikeAt && local < cutAt) || outro
        const fl0 = s.frame.s.update(on, dt, calm)
        const nl0 = s.name.s.update(on, dt, calm)
        s.frame.part.setLevel(fl0)
        s.name.part.setLevel(nl0)
        mid(fl0)
        mid(nl0)
        // the name writes itself as the camera arrives (sign 0: during the intro)
        const draw = i === 0 ? smoothstep(0.036, 0.06, local) : smoothstep(lerp(inT[0], inT[1], 0.5), inT[1], local)
        s.name.part.setDraw(quiet || outro ? 1 : draw)
        // the lightbox: backlit when its sign is up, dim otherwise
        const f = s.faceS.update(on ? 1 : 0.3, dt, true)
        s.face.color.setScalar(FACE_MAX * f)
        if (Math.abs(f - (on ? 1 : 0.3)) > 0.002) settling = true
      }
      const boardOn = local >= lerp(TRAVEL[N][0], TRAVEL[N][1], 0.45)
      if (board.frame && board.head && board.list) {
        for (const t of [board.frame, board.head, board.list]) {
          const lv = t.s.update(boardOn, dt, calm)
          t.part.setLevel(lv)
          mid(lv)
        }
        board.list.part.setDraw(quiet ? 1 : smoothstep(lerp(TRAVEL[N][0], TRAVEL[N][1], 0.5), TRAVEL[N][1] + 0.022, local))
        haloB.intensity = board.head.part.level * 3
      }

      // halos + floor washes on the nearest even and odd signs
      const si = clamp(track - 1, 0, N - 1)
      const ie = clamp(2 * Math.round(si / 2), 0, N - 1)
      const io = clamp(2 * Math.round((si - 1) / 2) + 1, 1, N - 1)
      const place = (halo: THREE.RectAreaLight, fl: THREE.RectAreaLight, i: number) => {
        const s = signs[i]
        const c = TUBE[s.color]
        halo.color.set(c)
        fl.color.set(c)
        // off the wall in front of the sign, facing the brick (no shadows: it
        // lights the wall all round the lightbox, a colour halo on the bricks)
        halo.position.set(s.x, s.y + 0.1, 0.55)
        halo.lookAt(s.x, s.y + 0.1, -1)
        fl.position.set(s.x, s.y - FR_H / 2 - 0.02, FR_Z + 0.03)
        fl.lookAt(s.x, 0, 1.4)
        const lv = s.frame.part.level
        halo.intensity = lv * (s.color === 'white' ? 1.4 : 2.6)
        fl.intensity = lv * (s.color === 'white' ? 3 : 5)
      }
      place(haloE, floorE, ie)
      place(haloO, floorO, io)

      // the room: haze tinted by whichever sign is up
      const ci = clamp(Math.round(si), 0, N - 1)
      const p = ctx.world.params
      p.glowColor = w.k === BOARD && !outro ? TUBE.amber : TUBE[signs[ci]?.color ?? 'pink']
      p.glow = 0.22
      p.fog = 0.022
      p.motes = 0.4
      p.moteColor = '#ffe0ef'
      p.env = 0.42
      p.fill = 0.16
      ctx.post.params.bloomStrength = 0.8
      ctx.post.params.bloomRadius = 0.05
      ctx.post.params.bloomThreshold = BLOOM_T

      // ---- copy
      reveal(intro, 1 - smoothstep(0.086, 0.1, local), 0)
      setRise(introTitle, local > 0.03 && local < 0.098)
      const idx = clamp(Math.round(si), 0, N - 1)
      reveal(card, holdVis(local, idx + 1), 0)
      reveal(rest, holdVis(local, BOARD), 0)
      if (idx !== shown) {
        shown = idx
        const it = FEATURED[shown]
        meta.textContent = `${String(shown + 1).padStart(2, '0')} / ${String(N).padStart(2, '0')} · ${it.industry}`
        name.textContent = it.name
        blurb.textContent = it.blurb
        tags.replaceChildren(...it.tags.map(t => Object.assign(document.createElement('li'), { className: 'hud-tag', textContent: t })))
        visit.href = it.url
        visit.textContent = isPreview(it.url) ? 'Preview site ↗' : 'Visit site ↗'
        card.dataset.tube = SPECS[shown % SPECS.length].color
      }
    },
    camera(local, frame, out: CameraPose) {
      buildPoses(frame)
      const w = where(local)
      if (w.t > 0) {
        holdPose(tmpA, w.k, 1)
        holdPose(tmpB, w.k + 1, 0)
        const e = ease.inOutCubic(w.t)
        // the target leads the dolly a little (the eye goes to the next sign first)
        const et = ease.inOutCubic(clamp(w.t * 1.15))
        out.position.lerpVectors(tmpA.p, tmpB.p, e)
        out.target.lerpVectors(tmpA.t, tmpB.t, et)
        // pull back off the wall mid-truck
        const bump = Math.sin(Math.PI * w.t)
        out.position.z += bump * (w.k === 0 ? 0.2 : 0.7)
        out.position.y += bump * 0.08
      } else {
        holdPose(tmpA, w.k, w.h)
        out.position.copy(tmpA.p)
        out.target.copy(tmpA.t)
      }
      if (local > OUTRO) {
        const o = ease.inOutCubic(clamp((local - OUTRO) / (1 - OUTRO)))
        out.position.lerp(poses.outro.p, o)
        out.target.lerp(poses.outro.t, o)
      }
      // the intro looks down the wall a little wider
      out.fov = w.k === 0 ? lerp(poses.introFov, poses.fov, w.t > 0 ? ease.inOutCubic(w.t) : 0) : poses.fov
      out.parallax = 0.22
    },
  }
}
