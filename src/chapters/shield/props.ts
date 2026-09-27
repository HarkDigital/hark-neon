import * as THREE from 'three'
import { steelMaterial } from '../../kit/shop'
import type { Stroke } from '../../kit/type'

/*
 * SHIELD props — the utility corner of the shop: a grey steel disconnect
 * (the breaker) with a side lever, neon transformers hanging off an EMT
 * conduit run, GTO cable down to the signs, painted plates, and the sparks
 * that jump off a shorting transformer. Plain geometry; the tubes are kit.
 */

const MONO = '"Azeret Mono Variable", ui-monospace, monospace'

let paint: THREE.MeshStandardMaterial | null = null
let paintDoor: THREE.MeshStandardMaterial | null = null
let rubber: THREE.MeshStandardMaterial | null = null
let conduitMat: THREE.MeshStandardMaterial | null = null
let xfmrMat: THREE.MeshStandardMaterial | null = null
/** grey hammer-tone steel (the panel) */
export const panelPaint = () => (paint ??= new THREE.MeshStandardMaterial({ color: 0x5b5e66, roughness: 0.5, metalness: 0.55, envMapIntensity: 0.75 }))
const doorPaint = () => (paintDoor ??= new THREE.MeshStandardMaterial({ color: 0x676a73, roughness: 0.44, metalness: 0.55, envMapIntensity: 0.8 }))
/** black rubber (GTO cable, boots, grips) */
export const rubberMaterial = () => (rubber ??= new THREE.MeshStandardMaterial({ color: 0x0c0b0d, roughness: 0.55, metalness: 0 }))
/** galvanised EMT conduit */
export const conduitMaterial = () => (conduitMat ??= new THREE.MeshStandardMaterial({ color: 0x8b8e96, roughness: 0.34, metalness: 0.8, envMapIntensity: 0.9 }))
const transformerPaint = () => (xfmrMat ??= new THREE.MeshStandardMaterial({ color: 0x1b1a1f, roughness: 0.42, metalness: 0.35, envMapIntensity: 0.7 }))

// ------------------------------------------------------------------ painted plates

/** A small canvas texture redrawn once the mono face is in (canvas text needs the font). */
export function plate(w: number, h: number, draw: (g: CanvasRenderingContext2D, W: number, H: number) => void, res = 512) {
  const W = res
  const H = Math.max(16, Math.round((res * h) / w))
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  const paintIt = () => {
    g.clearRect(0, 0, W, H)
    draw(g, W, H)
    tex.needsUpdate = true
  }
  paintIt()
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, metalness: 0.1, envMapIntensity: 0.4 })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat)
  return Object.assign(mesh, { repaint: paintIt })
}

/** wait (briefly) for the mono face so canvas text doesn't fall back */
export async function monoReady() {
  try {
    await Promise.race([document.fonts.load(`600 40px ${MONO}`), new Promise(r => setTimeout(r, 1500))])
  } catch {
    /* no FontFaceSet: canvas falls back to ui-monospace */
  }
}

export function monoText(g: CanvasRenderingContext2D, text: string, x: number, y: number, px: number, color: string, weight = 600, align: CanvasTextAlign = 'left', spacing = 0.12) {
  g.font = `${weight} ${px}px ${MONO}`
  g.fillStyle = color
  g.textBaseline = 'middle'
  // letter-spacing by hand (canvas letterSpacing is missing in Safari)
  const chars = [...text]
  const widths = chars.map(ch => g.measureText(ch).width + px * spacing)
  const total = widths.reduce((a, b) => a + b, 0) - px * spacing
  let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x
  g.textAlign = 'left'
  chars.forEach((ch, i) => {
    g.fillText(ch, cx, y)
    cx += widths[i]
  })
}

/** a tiny lightning-in-triangle hazard glyph */
function hazard(g: CanvasRenderingContext2D, cx: number, cy: number, s: number, fill: string, ink: string) {
  g.save()
  g.translate(cx, cy)
  g.fillStyle = fill
  g.beginPath()
  g.moveTo(0, -s * 0.55)
  g.lineTo(s * 0.55, s * 0.42)
  g.lineTo(-s * 0.55, s * 0.42)
  g.closePath()
  g.fill()
  g.fillStyle = ink
  g.beginPath()
  g.moveTo(s * 0.06, -s * 0.28)
  g.lineTo(-s * 0.14, s * 0.07)
  g.lineTo(s * 0.02, s * 0.07)
  g.lineTo(-s * 0.06, s * 0.33)
  g.lineTo(s * 0.16, -s * 0.03)
  g.lineTo(0, -s * 0.03)
  g.closePath()
  g.fill()
  g.restore()
}

// ------------------------------------------------------------------ the breaker

/**
 * A grey steel disconnect box on the wall (back at z = 0) with an external
 * lever on its right side. setThrow(0) = tripped (lever down), 1 = on (up).
 */
export function breakerPanel() {
  const group = new THREE.Group()
  const W = 1.0
  const H = 1.35
  const D = 0.24
  const body = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), panelPaint())
  body.position.z = D / 2
  group.add(body)
  // the door: a slightly proud, lighter panel with a seam
  const door = new THREE.Mesh(new THREE.BoxGeometry(W - 0.07, H - 0.07, 0.018), doorPaint())
  door.position.z = D + 0.009
  group.add(door)
  // hinges on the left
  const hingeG = new THREE.CylinderGeometry(0.016, 0.016, 0.14, 10)
  for (const y of [0.42, -0.42]) {
    const h = new THREE.Mesh(hingeG, steelMaterial())
    h.position.set(-W / 2 + 0.012, y, D + 0.012)
    group.add(h)
  }
  // hasp (right edge of the door)
  const hasp = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.12, 0.03), steelMaterial())
  hasp.position.set(W / 2 - 0.085, -0.5, D + 0.03)
  group.add(hasp)

  // painted plates
  const label = plate(0.62, 0.3, (g, w, h) => {
    g.fillStyle = '#e9e4da'
    g.fillRect(0, 0, w, h)
    g.fillStyle = '#141216'
    g.fillRect(6, 6, w - 12, h - 12)
    hazard(g, 58, h / 2, 76, '#ffa126', '#141216')
    monoText(g, 'SIGN', 112, h * 0.34, 44, '#e9e4da', 700)
    monoText(g, 'CIRCUITS', 112, h * 0.68, 44, '#e9e4da', 700)
  })
  label.position.set(0, 0.36, D + 0.0185)
  group.add(label)
  const tag = plate(0.44, 0.1, (g, w, h) => {
    g.fillStyle = '#d8d2c6'
    g.fillRect(0, 0, w, h)
    monoText(g, 'MAIN · 1 PH', w / 2, h / 2, 50, '#1a181c', 700, 'center')
  })
  tag.position.set(0, -0.44, D + 0.0185)
  group.add(tag)

  // pilot lamp: bezel + lens (the lens is an HDR dot; bloom does the rest)
  const bezel = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.02, 16), steelMaterial())
  bezel.rotation.x = Math.PI / 2
  bezel.position.set(0, 0.06, D + 0.028)
  group.add(bezel)
  const lensMat = new THREE.MeshBasicMaterial({ color: 0xff4220, toneMapped: false })
  const lens = new THREE.Mesh(new THREE.SphereGeometry(0.022, 14, 10), lensMat)
  lens.scale.z = 0.55
  lens.position.set(0, 0.06, D + 0.04)
  group.add(lens)

  // the lever: hub on the side, arm, grip. Pivot rotates about x.
  const pivot = new THREE.Group()
  pivot.position.set(W / 2 + 0.03, 0.02, D * 0.55)
  group.add(pivot)
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.05, 20), steelMaterial())
  hub.rotation.z = Math.PI / 2
  pivot.add(hub)
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.5, 0.055), steelMaterial())
  arm.position.y = 0.25
  pivot.add(arm)
  // a painted safety-orange grip, so the throw reads from across the room
  const grip = new THREE.Mesh(
    new THREE.CylinderGeometry(0.034, 0.038, 0.2, 16),
    new THREE.MeshStandardMaterial({ color: 0xd8401c, roughness: 0.38, metalness: 0.05, envMapIntensity: 0.8 }),
  )
  grip.rotation.z = Math.PI / 2
  grip.position.set(0.07, 0.5, 0)
  pivot.add(grip)
  // the side guide plate the lever sweeps over
  const guide = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.012, 24, 1, false, 0, Math.PI), panelPaint())
  guide.rotation.z = Math.PI / 2
  guide.position.set(W / 2 + 0.006, 0.02, D * 0.55)
  group.add(guide)

  // ON / OFF marks beside the lever
  const onOff = plate(0.1, 0.62, (g, w, h) => {
    monoText(g, 'ON', w / 2, h * 0.08, w * 0.34, '#e9e4da', 700, 'center', 0.05)
    monoText(g, 'OFF', w / 2, h * 0.92, w * 0.28, '#e9e4da', 700, 'center', 0.02)
    g.fillStyle = '#e9e4da'
    g.fillRect(w / 2 - 2, h * 0.18, 4, h * 0.64)
  }, 128)
  onOff.position.set(W / 2 - 0.085, 0.02, D + 0.0185)
  group.add(onOff)

  // conduit hub on the left side
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.05, 14), steelMaterial())
  cap.rotation.z = Math.PI / 2
  cap.position.set(-W / 2 - 0.02, 0.25, 0.1)
  group.add(cap)

  body.position.y = 0
  const OFF = 2.25 // lever down and out
  const ON = 0.3 // lever up
  const tmp = new THREE.Color()
  return {
    group,
    width: W,
    height: H,
    depth: D,
    /** where the conduit leaves the left side (local) */
    conduitAt: new THREE.Vector3(-W / 2 - 0.04, 0.25, 0.1),
    /** 0 tripped → 1 on */
    setThrow(t: number) {
      pivot.rotation.x = OFF + (ON - OFF) * t
    },
    /** pilot lamp colour × intensity (HDR) */
    setPilot(color: THREE.ColorRepresentation, hdr: number) {
      lensMat.color.copy(tmp.set(color)).multiplyScalar(hdr)
    },
  }
}

// ------------------------------------------------------------------ transformers

/** A neon transformer: black can, mounting ears, two HV boots underneath. */
export function transformer() {
  const group = new THREE.Group()
  const W = 0.46
  const H = 0.2
  const D = 0.14
  const can = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), transformerPaint())
  can.position.z = D / 2
  group.add(can)
  const ear = new THREE.BoxGeometry(0.07, 0.12, 0.012)
  for (const s of [-1, 1]) {
    const e = new THREE.Mesh(ear, steelMaterial())
    e.position.set(s * (W / 2 + 0.03), 0, 0.006)
    group.add(e)
  }
  const bootG = new THREE.CylinderGeometry(0.02, 0.028, 0.07, 12)
  const boots: THREE.Vector3[] = []
  for (const s of [-1, 1]) {
    const b = new THREE.Mesh(bootG, rubberMaterial())
    b.position.set(s * 0.15, -H / 2 - 0.035, D * 0.5)
    group.add(b)
    boots.push(new THREE.Vector3(s * 0.15, -H / 2 - 0.07, D * 0.5))
  }
  const sticker = plate(0.26, 0.11, (g, w, h) => {
    g.fillStyle = '#6f6a62'
    g.fillRect(0, 0, w, h)
    hazard(g, 40, h / 2, 64, '#c9801e', '#1a181c')
    monoText(g, '15 kV', 84, h * 0.5, 64, '#1a181c', 700)
  })
  sticker.position.set(0, 0.01, D + 0.001)
  group.add(sticker)
  return { group, width: W, boots }
}

// ------------------------------------------------------------------ conduit & cable

/** EMT conduit along a polyline with rounded bends; merged into one mesh. */
export function conduit(points: THREE.Vector3[], { radius = 0.022, bend = 0.14, radial = 10 } = {}) {
  const path = new THREE.CurvePath<THREE.Vector3>()
  let prev = points[0].clone()
  for (let i = 1; i < points.length; i++) {
    const p = points[i]
    if (i < points.length - 1) {
      const n = points[i + 1]
      const a = p.clone().sub(prev)
      const b = n.clone().sub(p)
      const r = Math.min(bend, a.length() * 0.45, b.length() * 0.45)
      const inPt = p.clone().addScaledVector(a.normalize(), -r)
      const outPt = p.clone().addScaledVector(b.normalize(), r)
      if (inPt.distanceTo(prev) > 1e-4) path.add(new THREE.LineCurve3(prev, inPt))
      path.add(new THREE.QuadraticBezierCurve3(inPt, p.clone(), outPt))
      prev = outPt
    } else path.add(new THREE.LineCurve3(prev, p.clone()))
  }
  const segs = Math.max(8, Math.round(path.getLength() / 0.05))
  const g = new THREE.TubeGeometry(path, segs, radius, radial, false)
  return new THREE.Mesh(g, conduitMaterial())
}

/** a soft cable (GTO) through points */
export function cable(points: THREE.Vector3[], radius = 0.011) {
  const c = new THREE.CatmullRomCurve3(points, false, 'centripetal')
  const g = new THREE.TubeGeometry(c, Math.max(12, Math.round(c.getLength() / 0.03)), radius, 6, false)
  return new THREE.Mesh(g, rubberMaterial())
}

/** conduit straps (one instanced mesh): each at a point, oriented along x or y */
export function straps(at: { p: THREE.Vector3; along: 'x' | 'y' }[]) {
  const g = new THREE.BoxGeometry(0.03, 0.075, 0.05)
  const m = new THREE.InstancedMesh(g, steelMaterial(), at.length)
  const q = new THREE.Quaternion()
  const s = new THREE.Vector3(1, 1, 1)
  const mat = new THREE.Matrix4()
  at.forEach((a, i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), a.along === 'y' ? Math.PI / 2 : 0)
    m.setMatrixAt(i, mat.compose(a.p, q, s))
  })
  return m
}

// ------------------------------------------------------------------ strokes

/** A closed polygon with rounded corners (for hard-cornered tube glyphs; use smooth: false). */
export function roundedPolygon(verts: [number, number][], r: number, z = 0, seg = 6): Stroke {
  const pts: THREE.Vector3[] = []
  const n = verts.length
  for (let i = 0; i < n; i++) {
    const p = new THREE.Vector2(...verts[i])
    const a = new THREE.Vector2(...verts[(i + n - 1) % n]).sub(p).normalize()
    const b = new THREE.Vector2(...verts[(i + 1) % n]).sub(p).normalize()
    const p1 = p.clone().addScaledVector(a, r)
    const p2 = p.clone().addScaledVector(b, r)
    for (let k = 0; k <= seg; k++) {
      const t = k / seg
      const u = 1 - t
      pts.push(new THREE.Vector3(u * u * p1.x + 2 * u * t * p.x + t * t * p2.x, u * u * p1.y + 2 * u * t * p.y + t * t * p2.y, z))
    }
  }
  return { pts, closed: true }
}

/** a small closed circle stroke */
export function circleStroke(cx: number, cy: number, r: number, z = 0, n = 10): Stroke {
  const pts: THREE.Vector3[] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    pts.push(new THREE.Vector3(cx + Math.cos(a) * r, cy + Math.sin(a) * r, z))
  }
  return { pts, closed: true }
}

// ------------------------------------------------------------------ sparks

function hash(n: number) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

/**
 * Sparks off a shorting terminal: short additive streaks, ballistic, a few
 * hundred ms each. Fully derived from (time, burst start): no accumulation.
 */
export class Sparks {
  readonly mesh: THREE.LineSegments
  private pos: Float32Array
  private col: Float32Array
  private geo: THREE.BufferGeometry
  constructor(private per = 14, private bursts = 2) {
    const n = per * bursts
    this.pos = new Float32Array(n * 6)
    this.col = new Float32Array(n * 6)
    this.geo = new THREE.BufferGeometry()
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage))
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4)
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false })
    this.mesh = new THREE.LineSegments(this.geo, mat)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 3
  }

  /**
   * origin: local burst point. list: recent bursts as [start age s, seed].
   * Returns the summed brightness (0..~1) so a light can follow it.
   */
  update(origin: THREE.Vector3, list: [number, number][]) {
    const P = this.pos
    const C = this.col
    let glow = 0
    const g = -7.5
    for (let b = 0; b < this.bursts; b++) {
      const burst = list[b]
      for (let i = 0; i < this.per; i++) {
        const k = (b * this.per + i) * 6
        if (!burst) {
          C.fill(0, k, k + 6)
          continue
        }
        const [age, seed] = burst
        const h1 = hash(seed * 13.7 + i * 1.31)
        const h2 = hash(seed * 7.1 + i * 2.77)
        const h3 = hash(seed * 3.3 + i * 5.19)
        const life = 0.22 + h3 * 0.34
        const a = age - h1 * 0.05
        if (a < 0 || a > life) {
          C.fill(0, k, k + 6)
          continue
        }
        // spray out of the boot: mostly sideways and down, some up
        const ang = -Math.PI * 0.5 + (h1 - 0.5) * Math.PI * 1.5
        const sp = 0.9 + h2 * 1.9
        const vx = Math.cos(ang) * sp
        const vy = Math.sin(ang) * sp + 0.6
        const vz = 0.25 + h3 * 0.7
        const x = origin.x + vx * a
        const y = origin.y + vy * a + 0.5 * g * a * a
        const z = origin.z + vz * a
        const tl = 0.018 + 0.02 * h2
        const tvx = vx
        const tvy = vy + g * a
        P[k] = x
        P[k + 1] = y
        P[k + 2] = z
        P[k + 3] = x - tvx * tl
        P[k + 4] = y - tvy * tl
        P[k + 5] = z - vz * tl
        const f = 1 - a / life
        const e = f * f * 3.2
        // white-hot head, amber tail
        C[k] = e * 1.0
        C[k + 1] = e * 0.82
        C[k + 2] = e * 0.55
        C[k + 3] = e * 0.9
        C[k + 4] = e * 0.42
        C[k + 5] = e * 0.12
        glow += f * f
      }
    }
    this.geo.attributes.position.needsUpdate = true
    this.geo.attributes.color.needsUpdate = true
    return Math.min(1, glow / this.per)
  }

  clear() {
    this.col.fill(0)
    this.geo.attributes.color.needsUpdate = true
  }
}
