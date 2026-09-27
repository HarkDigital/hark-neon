import * as THREE from 'three'
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js'
import { neonFromStrokes, TUBE, type NeonPart, type TubeColor } from './neon'

/*
 * THE SHOP — surfaces and fixtures the tubes live on, shared by every
 * chapter so the whole site is one sign shop after hours.
 *
 *   initAreaLights()          once, before any RectAreaLight renders
 *   brickMaterial(opts)       painted-black brick (procedural tile + bump)
 *   concreteMaterial(opts)    sealed dark concrete floor; glossy enough that a
 *                             RectAreaLight draws a long streak of reflection
 *   backerPanel(w, h, opts)   a black acrylic sign backer on four standoffs
 *   fluorescentFixture(len)   a ceiling fixture: housing, a cool-white tube and
 *                             an optional RectAreaLight; setLevel(v) drives both
 *   tubeLight(part, opts)     a RectAreaLight that follows a NeonPart's level
 *
 * Lights: never add/remove or hide lights at runtime (three recompiles every
 * lit material). Keep each chapter's light count fixed; drive intensity.
 * RectAreaLights are cheap-ish but not free: ≤ 6 per chapter.
 */

let areaInit = false
export function initAreaLights() {
  if (areaInit) return
  RectAreaLightUniformsLib.init()
  areaInit = true
}

function rnd(seed: number) {
  let s = seed >>> 0 || 1
  return () => ((s = (s * 16807) % 2147483647) / 2147483647)
}

const texCache = new Map<string, THREE.Texture>()

/** A brick tile (running bond), albedo + height, as two small canvases. */
function brickTiles(tint: string) {
  const key = `brick:${tint}`
  if (texCache.has(key)) return { map: texCache.get(key)!, bump: texCache.get(key + ':b')! }
  const S = 512
  const rows = 8
  const cols = 4
  const bh = S / rows
  const bw = S / cols
  const mortar = 5
  const a = document.createElement('canvas')
  const b = document.createElement('canvas')
  a.width = a.height = b.width = b.height = S
  const ga = a.getContext('2d')!
  const gb = b.getContext('2d')!
  const r = rnd(11)
  const base = new THREE.Color(tint)
  ga.fillStyle = '#0a090a'
  ga.fillRect(0, 0, S, S)
  gb.fillStyle = '#000'
  gb.fillRect(0, 0, S, S)
  for (let y = 0; y < rows; y++) {
    const off = (y % 2) * (bw / 2)
    for (let x = -1; x <= cols; x++) {
      const px = x * bw + off + mortar / 2
      const py = y * bh + mortar / 2
      const c = base.clone().multiplyScalar(0.75 + r() * 0.5)
      ga.fillStyle = `#${c.getHexString()}`
      ga.fillRect(px, py, bw - mortar, bh - mortar)
      gb.fillStyle = `rgb(${200 + r() * 40 | 0},${200 + r() * 40 | 0},${200 + r() * 40 | 0})`
      gb.fillRect(px, py, bw - mortar, bh - mortar)
      // pits and paint wear
      for (let i = 0; i < 26; i++) {
        const sx = px + r() * (bw - mortar)
        const sy = py + r() * (bh - mortar)
        const rr = 1 + r() * 3.5
        ga.fillStyle = `rgba(${r() > 0.6 ? '70,60,62' : '0,0,0'},${0.18 + r() * 0.3})`
        ga.beginPath()
        ga.arc(sx, sy, rr, 0, Math.PI * 2)
        ga.fill()
        gb.fillStyle = `rgba(0,0,0,${0.2 + r() * 0.4})`
        gb.beginPath()
        gb.arc(sx, sy, rr, 0, Math.PI * 2)
        gb.fill()
      }
    }
  }
  const map = new THREE.CanvasTexture(a)
  map.colorSpace = THREE.SRGBColorSpace
  map.wrapS = map.wrapT = THREE.RepeatWrapping
  map.anisotropy = 4
  const bump = new THREE.CanvasTexture(b)
  bump.colorSpace = THREE.NoColorSpace
  bump.wrapS = bump.wrapT = THREE.RepeatWrapping
  texCache.set(key, map)
  texCache.set(key + ':b', bump)
  return { map, bump }
}

export interface BrickOptions {
  /** paint colour of the bricks (default a black-plum paint) */
  tint?: string
  /** world size of one 8-course tile, metres (default 1.6) */
  tile?: number
  /** surface size, to set the repeat (default 10 x 6) */
  width?: number
  height?: number
}

/** Painted brick for walls. Clone per wall size (the textures are shared). */
export function brickMaterial(o: BrickOptions = {}) {
  const { tint = '#2a2027', tile = 1.6, width = 10, height = 6 } = o
  const { map, bump } = brickTiles(tint)
  const m = map.clone()
  const bmp = bump.clone()
  m.repeat.set(width / tile, height / tile)
  bmp.repeat.copy(m.repeat)
  m.needsUpdate = bmp.needsUpdate = true
  return new THREE.MeshStandardMaterial({ map: m, bumpMap: bmp, bumpScale: 2.2, roughness: 0.82, metalness: 0 })
}

/** Sealed dark concrete: a long reflection streak under every tube light. */
export function concreteMaterial({ color = '#141116', roughness = 0.3, width = 20, depth = 20 } = {}) {
  const key = 'concrete'
  let tex = texCache.get(key)
  if (!tex) {
    const S = 256
    const c = document.createElement('canvas')
    c.width = c.height = S
    const g = c.getContext('2d')!
    const img = g.createImageData(S, S)
    const r = rnd(5)
    // smooth-ish value noise, tileable (coarse grid, wrapped)
    const N = 16
    const grid = Array.from({ length: N * N }, () => r())
    const at = (x: number, y: number) => grid[((y + N) % N) * N + ((x + N) % N)]
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const fx = (x / S) * N
        const fy = (y / S) * N
        const ix = Math.floor(fx)
        const iy = Math.floor(fy)
        const tx = fx - ix
        const ty = fy - iy
        const sx = tx * tx * (3 - 2 * tx)
        const sy = ty * ty * (3 - 2 * ty)
        const v = at(ix, iy) * (1 - sx) * (1 - sy) + at(ix + 1, iy) * sx * (1 - sy) + at(ix, iy + 1) * (1 - sx) * sy + at(ix + 1, iy + 1) * sx * sy
        const n = v * 0.75 + r() * 0.25
        const i = (y * S + x) * 4
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 90 + n * 120
        img.data[i + 3] = 255
      }
    g.putImageData(img, 0, 0)
    tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.NoColorSpace
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping
    texCache.set(key, tex)
  }
  const rm = tex.clone()
  rm.repeat.set(width / 3, depth / 3)
  rm.needsUpdate = true
  return new THREE.MeshStandardMaterial({ color, roughness, roughnessMap: rm, metalness: 0, envMapIntensity: 0.6 })
}

let acrylic: THREE.MeshStandardMaterial | null = null
let steel: THREE.MeshStandardMaterial | null = null
let standoffSteel: THREE.MeshStandardMaterial | null = null
export const acrylicMaterial = () => (acrylic ??= new THREE.MeshStandardMaterial({ color: 0x060507, roughness: 0.16, metalness: 0, envMapIntensity: 0.8 }))
export const steelMaterial = () => (steel ??= new THREE.MeshStandardMaterial({ color: 0x9a9aa2, roughness: 0.38, metalness: 0.85, envMapIntensity: 0.9 }))

/** A black acrylic sign backer (w x h, 1.2 cm thick) on four steel standoffs; face at z = 0. */
export function backerPanel(w: number, h: number, { depth = 0.012, standoff = 0.05, material }: { depth?: number; standoff?: number; material?: THREE.Material } = {}) {
  const g = new THREE.Group()
  const panel = new THREE.Mesh(new THREE.BoxGeometry(w, h, depth), material ?? acrylicMaterial())
  panel.position.z = -depth / 2
  g.add(panel)
  const post = new THREE.CylinderGeometry(0.012, 0.012, standoff, 10)
  post.rotateX(Math.PI / 2)
  const inset = Math.min(w, h) * 0.06 + 0.02
  // instanced: its own material (one material drawn by both an InstancedMesh
  // and plain meshes re-resolves its program on every draw)
  standoffSteel ??= steelMaterial().clone()
  const posts = new THREE.InstancedMesh(post, standoffSteel, 4)
  const m = new THREE.Matrix4()
  let i = 0
  for (const sx of [-1, 1])
    for (const sy of [-1, 1]) posts.setMatrixAt(i++, m.makeTranslation(sx * (w / 2 - inset), sy * (h / 2 - inset), -depth - standoff / 2))
  g.add(posts)
  return g
}

export interface FixtureOptions {
  /** tube colour (default a cool daylight white) */
  color?: TubeColor | string
  /** RectAreaLight intensity at full level (0 = no light; default 6) */
  intensity?: number
  /** add a RectAreaLight (default true) — counts toward the chapter's light budget */
  light?: boolean
}

/**
 * A bare fluorescent ceiling fixture (strip housing + one 38 mm tube),
 * hanging along +x, light facing down. setLevel(v) drives tube + light.
 */
export function fluorescentFixture(length = 1.2, o: FixtureOptions = {}) {
  const { color = '#eef3ff', intensity = 6, light = true } = o
  const group = new THREE.Group()
  const housing = new THREE.Mesh(new THREE.BoxGeometry(length + 0.08, 0.05, 0.1), new THREE.MeshStandardMaterial({ color: 0xbfc0c4, roughness: 0.55, metalness: 0.3 }))
  housing.position.y = 0.045
  group.add(housing)
  const part: NeonPart = neonFromStrokes([{ pts: [new THREE.Vector3(-length / 2, 0, 0), new THREE.Vector3(length / 2, 0, 0)] }], {
    color,
    radius: 0.019,
    hdr: 3.2,
    blockout: false,
    electrodes: false,
    smooth: false,
  })
  group.add(part.group)
  // end caps (the pins' holders)
  const capG = new THREE.CylinderGeometry(0.024, 0.024, 0.04, 12)
  capG.rotateZ(Math.PI / 2)
  for (const s of [-1, 1]) {
    const cap = new THREE.Mesh(capG, steelMaterial())
    cap.position.x = s * (length / 2 + 0.02)
    group.add(cap)
  }
  let area: THREE.RectAreaLight | null = null
  if (light && intensity > 0) {
    initAreaLights()
    const hex = color in TUBE ? TUBE[color as TubeColor] : color
    area = new THREE.RectAreaLight(hex, 0, length, 0.06)
    area.position.y = -0.02
    area.rotation.x = -Math.PI / 2
    group.add(area)
  }
  return {
    group,
    part,
    light: area,
    setLevel(v: number) {
      part.setLevel(v)
      if (area) area.intensity = v * intensity
    },
  }
}

/**
 * A RectAreaLight standing in for a sign's light on the room (floor, wall).
 * Place it where the sign is, facing out; call sync() each frame after the
 * part's level changes. Keep the count fixed per chapter.
 */
export function tubeLight(part: NeonPart, { color, width = 1, height = 0.3, intensity = 4 }: { color?: string; width?: number; height?: number; intensity?: number } = {}) {
  initAreaLights()
  const c = (part.material.uniforms.uColor.value as THREE.Color).clone()
  const light = new THREE.RectAreaLight(color ? new THREE.Color(color) : c, 0, width, height)
  return Object.assign(light, {
    sync() {
      light.intensity = part.level * intensity
    },
  })
}
