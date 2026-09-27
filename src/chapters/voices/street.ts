import * as THREE from 'three'
import { rng } from '../../core/math'

/*
 * VOICES: the street beyond the glass, all out of focus.
 *
 *   streetPlate()   the far side of the street painted small (a low-res
 *                   canvas IS the blur): facades, lit windows, shopfront
 *                   glow, the pavement. Flat, dim, below the bloom threshold.
 *   bokeh()         defocused lights as camera-facing discs (instanced quads,
 *                   world-placed so they parallax as the camera trucks):
 *                   sodium streetlamps, tail lights, headlights, window
 *                   lights, a sign across the street. No green.
 */

/** the plate covers x ∈ [X0, X0 + PW], y ∈ [Y0, Y0 + PH] at z = PZ */
const X0 = -34
const PW = 110
const Y0 = -10
const PH = 34
export const PZ = -17

export function streetPlate(): THREE.Mesh {
  const W = 330
  const H = 102
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  const r = rng(41)
  const X = (x: number) => ((x - X0) / PW) * W
  const Y = (y: number) => H - ((y - Y0) / PH) * H
  // night sky over the roofline, then the facades
  const sky = g.createLinearGradient(0, 0, 0, H)
  sky.addColorStop(0, '#0b0a1d')
  sky.addColorStop(0.45, '#120c22')
  sky.addColorStop(1, '#0a0710')
  g.fillStyle = sky
  g.fillRect(0, 0, W, H)
  // buildings across the street
  let x = X0
  while (x < X0 + PW) {
    const w = 6 + r() * 9
    const top = 9 + r() * 9
    const tone = 12 + Math.floor(r() * 10)
    g.fillStyle = `rgb(${tone + 3},${tone - 2},${tone + 8})`
    g.fillRect(X(x), Y(top), X(x + w) - X(x), Y(-1.4) - Y(top))
    // windows: rows of soft lit rectangles, mostly dark
    for (let wy = 3.2; wy < top - 1.5; wy += 2.8) {
      for (let wx = x + 0.9; wx < x + w - 1.2; wx += 1.9) {
        const lit = r()
        if (lit < 0.62) continue
        const warm = r() < 0.75
        const k = 0.55 + r() * 0.45
        g.fillStyle = warm ? `rgba(${(120 * k) | 0},${(78 * k) | 0},${(40 * k) | 0},1)` : `rgba(${(52 * k) | 0},${(66 * k) | 0},${(118 * k) | 0},1)`
        g.fillRect(X(wx), Y(wy + 1.5), X(wx + 1.1) - X(wx), Y(wy) - Y(wy + 1.5))
      }
    }
    x += w + (r() < 0.25 ? 1.5 + r() * 2 : 0)
  }
  // shopfronts at street level: warm glow with a coloured sign now and then
  const signs = ['#6a1540', '#123a66', '#3a1a66', '#6a3a10', '#5a1a14']
  for (let sx = X0 + 2; sx < X0 + PW; sx += 7 + r() * 6) {
    const w = 3 + r() * 3
    const grd = g.createLinearGradient(0, Y(2.2), 0, Y(-1.4))
    grd.addColorStop(0, 'rgba(90,60,40,0.25)')
    grd.addColorStop(1, 'rgba(150,100,60,0.55)')
    g.fillStyle = grd
    g.fillRect(X(sx), Y(2.2), X(sx + w) - X(sx), Y(-1.4) - Y(2.2))
    if (r() < 0.6) {
      g.fillStyle = signs[Math.floor(r() * signs.length)]
      g.fillRect(X(sx + 0.3), Y(3.1), X(sx + w - 0.3) - X(sx + 0.3), Y(2.3) - Y(3.1))
    }
  }
  // the street: dark asphalt, a kerb line, soft pools under the lamps
  const road = g.createLinearGradient(0, Y(-1.4), 0, H)
  road.addColorStop(0, '#120d12')
  road.addColorStop(1, '#060508')
  g.fillStyle = road
  g.fillRect(0, Y(-1.4), W, H - Y(-1.4))
  for (let lx = X0 + 4; lx < X0 + PW; lx += 11) {
    const pool = g.createRadialGradient(X(lx), Y(-2.6), 0, X(lx), Y(-2.6), 14)
    pool.addColorStop(0, 'rgba(120,70,28,0.35)')
    pool.addColorStop(1, 'rgba(120,70,28,0)')
    g.fillStyle = pool
    g.fillRect(X(lx) - 16, Y(-1.4), 32, H - Y(-1.4))
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  const mat = new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(0.62, 0.6, 0.66), toneMapped: false, fog: false, depthWrite: false })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(PW, PH), mat)
  mesh.position.set(X0 + PW / 2, Y0 + PH / 2, PZ)
  mesh.renderOrder = -2
  return mesh
}

const BOKEH_VERT = /* glsl */ `
  attribute vec3 aOffset;
  attribute float aSize;
  attribute vec3 aColor;
  attribute float aSeed;
  uniform float uTime;
  uniform vec4 uHole;
  uniform float uHoleAmt;
  varying vec2 vUv;
  varying vec3 vColor;
  void main() {
    vec3 o = aOffset;
    // moving cars drift along x (aSeed > 1: speed = aSeed - 10), wrapped in a 90-unit lane
    if (aSeed > 1.0) o.x = -30.0 + mod(o.x + 30.0 + uTime * (aSeed - 10.0), 90.0);
    vec4 mv = modelViewMatrix * vec4(o, 1.0);
    // lights behind the words are stopped down (the quote's own "depth of field")
    vec4 c = projectionMatrix * mv;
    vec2 ndc = c.xy / max(c.w, 1e-4);
    float dh = length((ndc - uHole.xy) / max(uHole.zw, vec2(1e-3)));
    float dim = 1.0 - uHoleAmt * (1.0 - smoothstep(0.75, 1.2, dh));
    mv.xy += position.xy * aSize;
    gl_Position = projectionMatrix * mv;
    vUv = position.xy * 2.0;
    vColor = aColor * dim;
  }
`
const BOKEH_FRAG = /* glsl */ `
  uniform float uLevel;
  varying vec2 vUv;
  varying vec3 vColor;
  void main() {
    float r = length(vUv);
    if (r > 1.0) discard;
    // a defocused point light: flat disc, a slightly brighter rim, soft edge
    float disc = 1.0 - smoothstep(0.86, 1.0, r);
    float rim = smoothstep(0.62, 0.9, r) * disc;
    gl_FragColor = vec4(vColor * (disc * 0.62 + rim * 0.38) * uLevel, 1.0);
  }
`

/** Defocused street lights. `level` uniform scales them all. */
export function bokeh(mobile: boolean) {
  const r = rng(7)
  const items: { p: [number, number, number]; s: number; c: string; k: number; seed: number }[] = []
  const add = (p: [number, number, number], s: number, c: string, k: number, seed = 0) => items.push({ p, s, c, k, seed })
  // disc size scales with distance so the blur reads as one aperture
  const size = (z: number, f: number) => (6 - z) * f
  // sodium streetlamps along the kerb, high
  for (let x = -26; x < 64; x += 10.5 + r() * 2) {
    const z = -6.5 - r() * 1.5
    add([x, 5.6 + r() * 0.6, z], size(z, 0.075 + r() * 0.02), '#ffa126', 0.55 + r() * 0.1)
  }
  // parked cars: tail-light pairs and a few headlights, low
  for (let x = -24; x < 62; x += 5 + r() * 7) {
    const z = -4.5 - r() * 2.5
    const red = r() < 0.6
    const c = red ? '#ff4220' : '#ffe6c8'
    const k = red ? 0.45 : 0.32
    const s = size(z, 0.03 + r() * 0.01)
    add([x, -0.55, z], s, c, k)
    add([x + 1.2, -0.55, z], s, c, k)
  }
  // lit windows and shop signs across the street, small and soft
  const signs = ['#ff2e97', '#2cb4ff', '#9b5cff', '#ffa126', '#fff3ea']
  const n = mobile ? 70 : 110
  for (let i = 0; i < n; i++) {
    const x = -28 + r() * 94
    const y = r() < 0.35 ? 1 + r() * 2.2 : 3 + r() * 9
    const z = -12 - r() * 4
    const sign = y < 3.4 && r() < 0.5
    const c = sign ? signs[Math.floor(r() * signs.length)] : r() < 0.8 ? '#ffc98a' : '#a8c8ff'
    add([x, y, z], size(z, 0.018 + r() * 0.03), c, sign ? 0.3 : 0.16 + r() * 0.14)
  }
  // two cars passing now and then (idle motion only; frozen when still)
  add([-10, -0.35, -9], size(-9, 0.04), '#ffe6c8', 0.34, 10 + 3.2)
  add([-8.6, -0.35, -9], size(-9, 0.04), '#ffe6c8', 0.34, 10 + 3.2)
  add([30, -0.4, -10.5], size(-10.5, 0.038), '#ff4220', 0.4, 10 - 2.6)
  add([31.3, -0.4, -10.5], size(-10.5, 0.038), '#ff4220', 0.4, 10 - 2.6)

  const base = new THREE.PlaneGeometry(1, 1)
  const geo = new THREE.InstancedBufferGeometry()
  geo.index = base.index
  geo.setAttribute('position', base.getAttribute('position'))
  const off = new Float32Array(items.length * 3)
  const sz = new Float32Array(items.length)
  const col = new Float32Array(items.length * 3)
  const seed = new Float32Array(items.length)
  const tmp = new THREE.Color()
  items.forEach((it, i) => {
    off.set(it.p, i * 3)
    sz[i] = it.s
    tmp.set(it.c).multiplyScalar(it.k)
    col.set([tmp.r, tmp.g, tmp.b], i * 3)
    // seed: 0 = parked, 10 + v = moving at v units/s
    seed[i] = it.seed
  })
  geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(off, 3))
  geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(sz, 1))
  geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(col, 3))
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1))
  geo.instanceCount = items.length
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uLevel: { value: 1 }, uHole: { value: new THREE.Vector4(0, 0, 1, 1) }, uHoleAmt: { value: 0 } },
    vertexShader: BOKEH_VERT,
    fragmentShader: BOKEH_FRAG,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.frustumCulled = false
  mesh.renderOrder = -1
  return Object.assign(mesh, {
    /** hole: an NDC ellipse (x, y, rx, ry) where discs dim by `amt` */
    update(time: number, level: number, hx = 0, hy = 0, hrx = 1, hry = 1, amt = 0) {
      mat.uniforms.uTime.value = time
      mat.uniforms.uLevel.value = level
      ;(mat.uniforms.uHole.value as THREE.Vector4).set(hx, hy, hrx, hry)
      mat.uniforms.uHoleAmt.value = amt
    },
  })
}
