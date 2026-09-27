import * as THREE from 'three'
import { textStrokes, type Stroke } from '../../kit/type'

/*
 * THE BENCH — props for the process chapter (a glass bender's bench):
 *
 *   patternPath()    the design the tube is bent to ("hello" in script), as
 *                    ONE continuous centreline, resampled evenly by arc length
 *   paperTexture()   the full-size pattern sheet: grid, pencil guides, taped
 *                    corners and a hand-lettered title block (single-stroke)
 *   inkRibbon()      marker / pencil lines laid flat on the paper that draw
 *                    themselves along their length (uDraw 0..1)
 *   BendTube         a clear glass tube whose centreline is rewritten every
 *                    frame (straight → bent), glowing orange where it's hot
 *   ribbonFlames()   the ribbon burner's row of small blue gas flames: one
 *                    additive quad, flames drawn in the shader (kept under the
 *                    bloom threshold with their own soft falloff)
 *
 * "Pattern space" is the paper's plane: x right, y up the page, z out of the
 * paper. The chapter lays that space flat on the bench (rotation.x = -PI/2).
 */

// ------------------------------------------------------------------ the design

/**
 * "hello" as one centreline (z = 0), centred on the origin, resampled to `n`
 * evenly spaced points. The EMS script "o" ends in a detached swash; the
 * pattern closes the o and finishes with a loop exit instead, so the whole
 * word is one tube from the h's lead-in to the o's tail.
 */
export function patternPath(size: number, n: number) {
  const t = textStrokes('hello', { font: 'script', size })
  const strokes = t.strokes.map(s => s.pts.map(p => p.clone()))
  let tail: THREE.Vector3[] = []
  if (strokes.length === 6) {
    // drop the o's detached exit swash; loop out of the o's top instead
    strokes.pop()
    const o = strokes[strokes.length - 1]
    const e = o[o.length - 1]
    const u = size
    tail = [
      [0.012, 0.062],
      [0.04, 0.1],
      [0.105, 0.118],
      [0.19, 0.098],
    ].map(([dx, dy]) => new THREE.Vector3(e.x + dx * u, e.y + dy * u, 0))
  }
  const raw: THREE.Vector3[] = []
  for (const s of strokes) for (const p of s) if (!raw.length || raw[raw.length - 1].distanceToSquared(p) > 1e-10) raw.push(p)
  raw.push(...tail)
  // centre the bbox
  const box = new THREE.Box3().setFromPoints(raw)
  const c = box.getCenter(new THREE.Vector3())
  for (const p of raw) p.sub(c).setZ(0)
  const curve = new THREE.CatmullRomCurve3(raw, false, 'centripetal', 0.5)
  const pts = curve.getSpacedPoints(n - 1)
  const size3 = box.getSize(new THREE.Vector3())
  return { pts, width: size3.x, height: size3.y, length: curve.getLength() }
}

// ------------------------------------------------------------------ paper

/** Strokes drawn with a pen on a 2D canvas (single-stroke lettering). */
function penStrokes(g: CanvasRenderingContext2D, strokes: Stroke[], X: (x: number) => number, Y: (y: number) => number) {
  g.beginPath()
  for (const s of strokes) s.pts.forEach((p, i) => (i ? g.lineTo(X(p.x), Y(p.y)) : g.moveTo(X(p.x), Y(p.y))))
  g.stroke()
}

/**
 * The pattern sheet (w x h world units, pattern space centred on 0,0).
 * `guides` = the word's baseline / x-height / ascender lines (pattern y).
 */
export function paperTexture(w: number, h: number, guides: number[], res = 1024) {
  const W = res
  const H = Math.round((res * h) / w)
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const g = cv.getContext('2d')!
  const s = W / w
  const X = (x: number) => (x + w / 2) * s
  const Y = (y: number) => (h / 2 - y) * s

  // paper: warm white with a faint fibre speckle (a small tile, patterned)
  g.fillStyle = '#d8d0c2'
  g.fillRect(0, 0, W, H)
  const tile = document.createElement('canvas')
  tile.width = tile.height = 96
  const tg = tile.getContext('2d')!
  const img = tg.createImageData(96, 96)
  let seed = 7
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  for (let i = 0; i < 96 * 96; i++) {
    const v = r()
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v > 0.5 ? 255 : 0
    img.data[i * 4 + 3] = Math.round(Math.abs(v - 0.5) * 22)
  }
  tg.putImageData(img, 0, 0)
  g.fillStyle = g.createPattern(tile, 'repeat')!
  g.fillRect(0, 0, W, H)
  // soft uneven light / handling marks
  const vg = g.createRadialGradient(W * 0.45, H * 0.45, H * 0.2, W * 0.5, H * 0.5, W * 0.62)
  vg.addColorStop(0, 'rgba(255,250,240,0)')
  vg.addColorStop(1, 'rgba(120,105,90,0.16)')
  g.fillStyle = vg
  g.fillRect(0, 0, W, H)

  // faint blue grid, 5 cm
  g.strokeStyle = 'rgba(70,110,170,0.16)'
  g.lineWidth = 1
  g.beginPath()
  for (let x = -w / 2; x <= w / 2 + 1e-6; x += 0.05) {
    g.moveTo(Math.round(X(x)) + 0.5, 0)
    g.lineTo(Math.round(X(x)) + 0.5, H)
  }
  for (let y = -h / 2; y <= h / 2 + 1e-6; y += 0.05) {
    g.moveTo(0, Math.round(Y(y)) + 0.5)
    g.lineTo(W, Math.round(Y(y)) + 0.5)
  }
  g.stroke()
  // margin rule
  g.strokeStyle = 'rgba(40,36,40,0.5)'
  g.lineWidth = 1.5
  const m = 0.04
  g.strokeRect(X(-w / 2 + m), Y(h / 2 - m), (w - 2 * m) * s, (h - 2 * m) * s)

  // pencil guides for the lettering
  g.strokeStyle = 'rgba(60,58,66,0.32)'
  g.lineWidth = 1.2
  g.setLineDash([10, 6])
  g.beginPath()
  for (const y of guides) {
    g.moveTo(X(-w / 2 + m + 0.03), Y(y))
    g.lineTo(X(w / 2 - m - 0.03), Y(y))
  }
  g.stroke()
  g.setLineDash([])

  // title block, lettered with the single-stroke sans (a draughtsman's hand)
  const bw = 0.34
  const bh = 0.13
  const bx = w / 2 - m - bw
  const by = -h / 2 + m
  g.strokeStyle = 'rgba(40,36,40,0.62)'
  g.lineWidth = 1.5
  g.strokeRect(X(bx), Y(by + bh), bw * s, bh * s)
  g.beginPath()
  g.moveTo(X(bx), Y(by + bh * 0.52))
  g.lineTo(X(bx + bw), Y(by + bh * 0.52))
  g.moveTo(X(bx + bw * 0.58), Y(by + bh * 0.52))
  g.lineTo(X(bx + bw * 0.58), Y(by))
  g.stroke()
  g.lineCap = 'round'
  g.lineJoin = 'round'
  g.strokeStyle = 'rgba(28,26,32,0.85)'
  g.lineWidth = 1.6
  const letter = (str: string, x: number, y: number, size: number) => {
    const t = textStrokes(str, { font: 'sans', size, tracking: 0.18, align: 'left' })
    penStrokes(g, t.strokes, px => X(x + t.width / 2 + px), py => Y(y + py))
  }
  letter('PATTERN  HELLO', bx + 0.016, by + bh * 0.76, 0.024)
  letter('ROSE 12 MM', bx + 0.016, by + bh * 0.26, 0.02)
  letter('1:1', bx + bw * 0.58 + 0.03, by + bh * 0.26, 0.02)
  letter('REV', bx + bw * 0.58 + 0.08, by + bh * 0.26, 0.02)

  // masking tape at the corners
  g.fillStyle = 'rgba(214,196,150,0.9)'
  const tape = (x: number, y: number, a: number) => {
    g.save()
    g.translate(X(x), Y(y))
    g.rotate(a)
    g.fillRect(-0.05 * s, -0.014 * s, 0.1 * s, 0.028 * s)
    g.restore()
  }
  tape(-w / 2 + 0.025, h / 2 - 0.025, -Math.PI / 4)
  tape(w / 2 - 0.025, h / 2 - 0.025, Math.PI / 4)
  tape(-w / 2 + 0.025, -h / 2 + 0.025, Math.PI / 4)
  tape(w / 2 - 0.025, -h / 2 + 0.025, -Math.PI / 4)

  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  return tex
}

// ------------------------------------------------------------------ ink

const INK_VERT = /* glsl */ `
  attribute float aArc;
  attribute float aSide;
  varying float vArc;
  varying float vSide;
  void main() {
    vArc = aArc;
    vSide = aSide;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
const INK_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uDraw, uAlpha;
  varying float vArc;
  varying float vSide;
  void main() {
    if (vArc > uDraw) discard;
    float edge = 1.0 - smoothstep(0.55, 1.0, abs(vSide));
    gl_FragColor = vec4(uColor, uAlpha * edge);
  }
`

/**
 * Flat ribbons along polylines (pattern space, lying at z), drawn in order:
 * uDraw 0..1 runs the pen along the total length.
 */
export function inkRibbon(lines: THREE.Vector3[][], width: number, color: string, alpha = 0.92, z = 0.0008) {
  const lens = lines.map(l => l.reduce((a, p, i) => (i ? a + p.distanceTo(l[i - 1]) : 0), 0))
  const total = lens.reduce((a, b) => a + b, 0) || 1
  const pos: number[] = []
  const arc: number[] = []
  const side: number[] = []
  const idx: number[] = []
  let acc = 0
  let v = 0
  const n = new THREE.Vector3()
  const t = new THREE.Vector3()
  lines.forEach(l => {
    let run = acc
    for (let i = 0; i < l.length; i++) {
      const a = l[Math.max(0, i - 1)]
      const b = l[Math.min(l.length - 1, i + 1)]
      t.subVectors(b, a).setZ(0)
      if (t.lengthSq() < 1e-12) t.set(1, 0, 0)
      t.normalize()
      n.set(-t.y, t.x, 0).multiplyScalar(width / 2)
      if (i) run += l[i].distanceTo(l[i - 1])
      const p = l[i]
      pos.push(p.x + n.x, p.y + n.y, z, p.x - n.x, p.y - n.y, z)
      arc.push(run / total, run / total)
      side.push(1, -1)
      if (i) idx.push(v - 2, v - 1, v, v - 1, v + 1, v)
      v += 2
    }
    acc = run
  })
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('aArc', new THREE.Float32BufferAttribute(arc, 1))
  g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1))
  g.setIndex(idx)
  const mat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uDraw: { value: 0 }, uAlpha: { value: alpha } },
    vertexShader: INK_VERT,
    fragmentShader: INK_FRAG,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  })
  const mesh = new THREE.Mesh(g, mat)
  mesh.renderOrder = 1
  return Object.assign(mesh, {
    setDraw(d: number) {
      mat.uniforms.uDraw.value = d >= 1 ? 1.01 : d
      mesh.visible = d > 0.0005
    },
    /** where the pen is at draw = d (pattern space, on the paper) */
    pointAt(d: number, out: THREE.Vector3) {
      let target = Math.max(0, Math.min(1, d)) * total
      for (let li = 0; li < lines.length; li++) {
        const l = lines[li]
        if (target > lens[li] && li < lines.length - 1) {
          target -= lens[li]
          continue
        }
        for (let i = 1; i < l.length; i++) {
          const seg = l[i].distanceTo(l[i - 1])
          if (target <= seg || i === l.length - 1) return out.copy(l[i - 1]).lerp(l[i], seg > 0 ? Math.min(1, target / seg) : 0).setZ(0)
          target -= seg
        }
      }
      return out.copy(lines[lines.length - 1][lines[lines.length - 1].length - 1]).setZ(0)
    },
  })
}

/**
 * A pen lying on the bench or writing on the paper (pattern space). Its tip
 * is at the group origin; the body runs up and back toward the writer's hand.
 */
export function penMesh(body: string, len = 0.14, r = 0.0085) {
  const g = new THREE.Group()
  const bodyG = new THREE.CylinderGeometry(r, r, len * 0.8, 12)
  bodyG.translate(0, len * 0.2 + len * 0.4, 0)
  const tipG = new THREE.ConeGeometry(r * 0.95, len * 0.2, 12)
  tipG.rotateX(Math.PI)
  tipG.translate(0, len * 0.1, 0)
  const capG = new THREE.CylinderGeometry(r * 1.08, r * 1.08, len * 0.18, 12)
  capG.translate(0, len * 0.91, 0)
  const bodyM = new THREE.MeshStandardMaterial({ color: body, roughness: 0.45, metalness: 0.05 })
  const tipM = new THREE.MeshStandardMaterial({ color: 0x1a1719, roughness: 0.6 })
  const capM = new THREE.MeshStandardMaterial({ color: 0xcfcac2, roughness: 0.5 })
  g.add(new THREE.Mesh(bodyG, bodyM), new THREE.Mesh(tipG, tipM), new THREE.Mesh(capG, capM))
  return g
}

/** A circle as a polyline (pattern space). */
export function circlePts(cx: number, cy: number, r: number, n = 28, a0 = 0, sweep = Math.PI * 2) {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + (sweep * i) / n
    return new THREE.Vector3(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 0)
  })
}

// ------------------------------------------------------------------ bending glass

const GLASS_VERT = /* glsl */ `
  attribute float aHeat;
  uniform vec3 uLightPos;
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vL;
  varying float vHeat;
  void main() {
    vHeat = aHeat;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vec4 mv = viewMatrix * wp;
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    vL = normalize((viewMatrix * vec4(uLightPos, 1.0)).xyz - mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`
const GLASS_FRAG = /* glsl */ `
  uniform vec3 uHot;
  uniform float uOpacity;
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vL;
  varying float vHeat;
  void main() {
    vec3 N = normalize(vN);
    vec3 V = normalize(vV);
    float facing = clamp(abs(dot(N, V)), 0.0, 1.0);
    float rim = 1.0 - facing;
    // clear glass: a cool rim, a warm glint from the work light
    vec3 R = reflect(-V, N);
    float sp = max(dot(R, normalize(vL)), 0.0);
    sp *= sp; sp *= sp; sp *= sp; sp *= sp; sp *= sp; // ^32
    vec3 col = vec3(0.5, 0.56, 0.62) * (0.05 + 0.75 * rim * rim * rim) + vec3(1.0, 0.9, 0.78) * sp * 0.85;
    // hot glass: sodium orange through the wall, whiter where it's hottest
    float h = clamp(vHeat, 0.0, 1.0);
    vec3 hot = mix(uHot * vec3(0.9, 0.45, 0.4), uHot, h) * h * (0.65 + 0.35 * facing);
    col += hot;
    float a = clamp(0.2 + 0.7 * rim * rim + sp + h * 1.2, 0.0, 1.0) * uOpacity;
    gl_FragColor = vec4(col, a);
  }
`

/**
 * A clear tube along a centreline that changes every frame. Fixed topology
 * (n rings x radial); setShape() rewrites positions, normals and heat.
 * Frames use the pattern normal (+z) as reference: the tube never runs
 * vertical, so N = normalize(z x T) is always defined.
 */
export class BendTube {
  mesh: THREE.Mesh
  material: THREE.ShaderMaterial
  centre: THREE.Vector3[]
  heat: Float32Array
  private pos: Float32Array
  private nor: Float32Array
  private heatAttr: THREE.BufferAttribute

  constructor(
    public n: number,
    public radius: number,
    public radial = 8,
  ) {
    this.centre = Array.from({ length: n }, () => new THREE.Vector3())
    this.heat = new Float32Array(n)
    const vc = n * (radial + 1) + 2
    this.pos = new Float32Array(vc * 3)
    this.nor = new Float32Array(vc * 3)
    const heatV = new Float32Array(vc)
    const idx: number[] = []
    for (let i = 0; i < n - 1; i++)
      for (let j = 0; j < radial; j++) {
        const a = i * (radial + 1) + j
        const b = a + radial + 1
        idx.push(a, b, a + 1, b, b + 1, a + 1)
      }
    // flat caps (a fan to a centre vertex at each end)
    const c0 = n * (radial + 1)
    const c1 = c0 + 1
    for (let j = 0; j < radial; j++) {
      idx.push(c0, j + 1, j)
      const last = (n - 1) * (radial + 1)
      idx.push(c1, last + j, last + j + 1)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor, 3).setUsage(THREE.DynamicDrawUsage))
    this.heatAttr = new THREE.BufferAttribute(heatV, 1).setUsage(THREE.DynamicDrawUsage)
    g.setAttribute('aHeat', this.heatAttr)
    g.setIndex(idx)
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uHot: { value: new THREE.Color(1.0, 0.42, 0.1).multiplyScalar(2.6) },
        uLightPos: { value: new THREE.Vector3(0, 3, 0) },
        uOpacity: { value: 1 },
      },
      vertexShader: GLASS_VERT,
      fragmentShader: GLASS_FRAG,
      transparent: true,
      depthWrite: false,
    })
    this.mesh = new THREE.Mesh(g, this.material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 2
  }

  /** rebuild the skin from this.centre / this.heat */
  commit() {
    const { n, radial, radius, centre, pos, nor, heat } = this
    const T = new THREE.Vector3()
    const N = new THREE.Vector3()
    const B = new THREE.Vector3()
    const Z = new THREE.Vector3(0, 0, 1)
    const hv = this.heatAttr.array as Float32Array
    for (let i = 0; i < n; i++) {
      const a = centre[Math.max(0, i - 1)]
      const b = centre[Math.min(n - 1, i + 1)]
      T.subVectors(b, a)
      if (T.lengthSq() < 1e-14) T.set(1, 0, 0)
      T.normalize()
      N.crossVectors(Z, T)
      if (N.lengthSq() < 1e-8) N.set(0, 1, 0)
      N.normalize()
      B.crossVectors(T, N).normalize()
      const p = centre[i]
      for (let j = 0; j <= radial; j++) {
        const ang = (j / radial) * Math.PI * 2
        const cx = Math.cos(ang)
        const sy = Math.sin(ang)
        const nx = N.x * cx + B.x * sy
        const ny = N.y * cx + B.y * sy
        const nz = N.z * cx + B.z * sy
        const k = (i * (radial + 1) + j) * 3
        pos[k] = p.x + nx * radius
        pos[k + 1] = p.y + ny * radius
        pos[k + 2] = p.z + nz * radius
        nor[k] = nx
        nor[k + 1] = ny
        nor[k + 2] = nz
        hv[i * (radial + 1) + j] = heat[i]
      }
    }
    const c0 = n * (radial + 1)
    for (const [ci, pi] of [
      [c0, 0],
      [c0 + 1, n - 1],
    ]) {
      const p = centre[pi]
      pos[ci * 3] = p.x
      pos[ci * 3 + 1] = p.y
      pos[ci * 3 + 2] = p.z
      const q = centre[pi === 0 ? 1 : n - 2]
      T.subVectors(p, q).normalize()
      nor[ci * 3] = T.x
      nor[ci * 3 + 1] = T.y
      nor[ci * 3 + 2] = T.z
      hv[ci] = heat[pi]
    }
    const g = this.mesh.geometry
    g.attributes.position.needsUpdate = true
    g.attributes.normal.needsUpdate = true
    this.heatAttr.needsUpdate = true
  }
}

// ------------------------------------------------------------------ flames

const FLAME_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
const FLAME_FRAG = /* glsl */ `
  uniform float uTime, uJets, uFore, uFocus, uBoost, uAmp, uLevel, uAspect;
  varying vec2 vUv;
  float hash(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
  void main() {
    float jx = vUv.x * uJets;
    float id = floor(jx);
    float qx = (fract(jx) - 0.5);
    float y = vUv.y;
    float r = hash(id + 3.0);
    float fl = 1.0 + uAmp * (0.09 * sin(uTime * (17.0 + r * 9.0) + r * 40.0) + 0.06 * sin(uTime * (29.0 + r * 13.0) + id * 1.7));
    float d = (vUv.x - uFocus) * 7.0;
    float focus = exp(-d * d);
    float h = (0.5 + 0.12 * r) * fl * (1.0 + uBoost * focus) * uFore;
    float t = y / max(h, 0.001);
    // outer envelope: round at the jet, tapering to a soft tip
    float body = max(1.0 - t, 0.0);
    float wOut = 0.3 * sqrt(body) * smoothstep(-0.06, 0.14, t) + 0.02;
    float outer = (1.0 - smoothstep(wOut * 0.45, wOut, abs(qx))) * (1.0 - smoothstep(0.55, 1.0, t)) * step(0.0, t);
    // inner cone: short, bright, cyan-white
    float ti = y / max(h * 0.36, 0.001);
    float wIn = 0.13 * max(1.0 - ti, 0.0) + 0.01;
    float inner = (1.0 - smoothstep(wIn * 0.4, wIn, abs(qx))) * (1.0 - smoothstep(0.7, 1.0, ti));
    // a soft halo round each jet (its own falloff — kept under the bloom threshold)
    float halo = exp(-abs(qx) * 7.0) * exp(-t * 2.2) * 0.2;
    vec3 col = vec3(0.07, 0.2, 1.0) * outer * 0.7 + vec3(0.32, 0.66, 1.0) * inner * 0.85 + vec3(0.12, 0.25, 1.0) * halo;
    // violet tips
    col += vec3(0.25, 0.05, 0.6) * outer * smoothstep(0.45, 0.9, t) * 0.4;
    // fade the quad ends
    col *= smoothstep(0.0, 0.02, vUv.x) * (1.0 - smoothstep(0.98, 1.0, vUv.x));
    gl_FragColor = vec4(col * uLevel, 1.0);
  }
`

/** The ribbon burner's flames: `length` along x, the jets at y = 0, `height` max. */
export function ribbonFlames(length: number, height: number, jets: number) {
  const g = new THREE.PlaneGeometry(length, height)
  g.translate(0, height / 2, 0)
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uJets: { value: jets },
      uFore: { value: 1 },
      uFocus: { value: 0.5 },
      uBoost: { value: 0 },
      uAmp: { value: 1 },
      uLevel: { value: 1 },
      uAspect: { value: length / height },
    },
    vertexShader: FLAME_VERT,
    fragmentShader: FLAME_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  })
  const mesh = new THREE.Mesh(g, mat)
  mesh.renderOrder = 3
  return { mesh, uniforms: mat.uniforms }
}
