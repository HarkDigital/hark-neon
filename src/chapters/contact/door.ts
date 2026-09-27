import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { neonFromStrokes, neonSpill, textStrokes, TUBE, type NeonPart } from '../../kit/neon'
import type { Stroke } from '../../kit/type'
import { brickMaterial, concreteMaterial, fluorescentFixture, tubeLight } from '../../kit/shop'

/*
 * CONTACT · the shop's front door at closing time, seen from inside.
 *
 *   the front wall      painted brick with the door opening (a notch, so the
 *                       brick courses run straight across), a shallow reveal
 *   the storefront      dark-bronze aluminium: jambs, header, transom bar, a
 *                       glass door leaf with a push bar and a closer arm
 *   the OPEN sign       the classic window sign, built like the real ones: red
 *                       sans letters (one tube, blockout jumpers behind), a
 *                       blue border bent from one length (electrodes at the
 *                       gap), both clipped by clear tube supports to a black
 *                       wire frame, a transformer on the back, a cord, hung
 *                       from the door rail by two chains. Its reflection sits
 *                       in the dark glass behind it.
 *   "Say hello."        pink script on the brick beside the door, on standoffs
 *   the rest of the shop two fluorescent fixtures, an amber arrow pointing at
 *                       the door, a UV star — the lights that go out at closing
 *
 * Six RectAreaLights, fixed: the two fixtures, OPEN (into the room), and one
 * halo on the brick for each wall sign.
 */

export const DOOR = {
  /** door opening half-width and height */
  halfW: 0.62,
  openH: 2.92,
  /** the storefront's room-side face and the glass plane */
  frameZ: -0.12,
  glassZ: -0.165,
  /** OPEN sign: centre and size (tubes' plane) */
  sign: new THREE.Vector3(0, 1.5, -0.075),
  signW: 1.02,
  signH: 0.47,
}

/** polyline with rounded (filleted) corners — neon is bent, never mitred */
function fillet(corners: [number, number][], r: number, closed = false, segs = 7): THREE.Vector3[] {
  const P = corners.map(([x, y]) => new THREE.Vector2(x, y))
  const out: THREE.Vector3[] = []
  const n = P.length
  const push = (v: THREE.Vector2) => out.push(new THREE.Vector3(v.x, v.y, 0))
  for (let i = 0; i < n; i++) {
    const p = P[i]
    const isEnd = !closed && (i === 0 || i === n - 1)
    if (isEnd) {
      push(p)
      continue
    }
    const a = P[(i - 1 + n) % n]
    const b = P[(i + 1) % n]
    const u = a.clone().sub(p)
    const v = b.clone().sub(p)
    const lu = u.length()
    const lv = v.length()
    u.divideScalar(lu)
    v.divideScalar(lv)
    const ang = Math.acos(THREE.MathUtils.clamp(u.dot(v), -1, 1))
    const t = Math.min(r / Math.tan(ang / 2), lu * 0.48, lv * 0.48)
    const s = p.clone().addScaledVector(u, t)
    const e = p.clone().addScaledVector(v, t)
    // quadratic Bézier through the corner ≈ a bend
    for (let k = 0; k <= segs; k++) {
      const q = k / segs
      const x = (1 - q) * (1 - q) * s.x + 2 * (1 - q) * q * p.x + q * q * e.x
      const y = (1 - q) * (1 - q) * s.y + 2 * (1 - q) * q * p.y + q * q * e.y
      push(new THREE.Vector2(x, y))
    }
  }
  return out
}

/** sample points along strokes every `step` (for tube supports) */
function samplesAlong(strokes: Stroke[], step: number, skip = 0.5) {
  const pts: THREE.Vector3[] = []
  for (const s of strokes) {
    let acc = step * skip
    for (let i = 1; i < s.pts.length; i++) {
      const a = s.pts[i - 1]
      const b = s.pts[i]
      const d = a.distanceTo(b)
      while (acc <= d) {
        pts.push(a.clone().lerp(b, acc / d))
        acc += step
      }
      acc -= d
    }
  }
  return pts
}

function box(w: number, h: number, d: number, x: number, y: number, z: number) {
  const g = new THREE.BoxGeometry(w, h, d)
  g.translate(x, y, z)
  return g
}

/** the street outside the glass: indigo night, a few far lights out of focus */
function streetTexture() {
  const W = 256
  const H = 256
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  // night sky over the street: indigo, warming toward the city's glow at the horizon
  const grd = g.createLinearGradient(0, 0, 0, H)
  grd.addColorStop(0, '#10152f')
  grd.addColorStop(0.4, '#1c2450')
  grd.addColorStop(0.58, '#33284f')
  // the kerb, then the dark road
  grd.addColorStop(0.6, '#121022')
  grd.addColorStop(1, '#08070e')
  g.fillStyle = grd
  g.fillRect(0, 0, W, H)
  // far lights, all out of focus: a sodium lamp, a blue sign across the street, tail lights
  const dots: [number, number, number, string][] = [
    [150, 52, 30, 'rgba(255,170,90,0.42)'],
    [150, 52, 9, 'rgba(255,215,160,0.7)'],
    [60, 110, 22, 'rgba(90,140,255,0.3)'],
    [96, 170, 6, 'rgba(255,60,50,0.5)'],
    [114, 170, 6, 'rgba(255,60,50,0.5)'],
  ]
  for (const [x, y, r, col] of dots) {
    const rg = g.createRadialGradient(x, y, 0, x, y, r)
    rg.addColorStop(0, col)
    rg.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = rg
    g.beginPath()
    g.arc(x, y, r, 0, Math.PI * 2)
    g.fill()
  }
  // the lamp's pool on the pavement
  const pool = g.createRadialGradient(150, 162, 0, 150, 162, 80)
  pool.addColorStop(0, 'rgba(255,170,90,0.14)')
  pool.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = pool
  g.fillRect(60, 154, 180, 60)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

export interface Lamp {
  part: NeonPart
  /** RectAreaLight following the part (may be null) */
  sync?: () => void
}

export function buildShop(group: THREE.Group, mobile: boolean) {
  const radial = mobile ? 6 : 8
  const syncs: (() => void)[] = []
  const supports: { at: THREE.Vector3; len: number }[] = []

  // ---------------------------------------------------------------- room
  const { halfW, openH, frameZ, glassZ } = DOOR
  const wallShape = new THREE.Shape()
  wallShape.moveTo(-7, 0)
  wallShape.lineTo(-halfW, 0)
  wallShape.lineTo(-halfW, openH)
  wallShape.lineTo(halfW, openH)
  wallShape.lineTo(halfW, 0)
  wallShape.lineTo(7.5, 0)
  wallShape.lineTo(7.5, 3.7)
  wallShape.lineTo(-7, 3.7)
  wallShape.closePath()
  // ShapeGeometry UVs are world metres: one brick tile per 1.5 m
  const wall = new THREE.Mesh(new THREE.ShapeGeometry(wallShape), brickMaterial({ tint: '#33242e', tile: 1.5, width: 1, height: 1 }))
  group.add(wall)

  const paint = new THREE.MeshStandardMaterial({ color: 0x141016, roughness: 0.78, metalness: 0 })
  const reveal = mergeGeometries([
    box(0.02, openH, -frameZ + 0.02, -halfW - 0.01, openH / 2, frameZ / 2),
    box(0.02, openH, -frameZ + 0.02, halfW + 0.01, openH / 2, frameZ / 2),
    box(halfW * 2 + 0.04, 0.02, -frameZ + 0.02, 0, openH + 0.01, frameZ / 2),
  ])!
  group.add(new THREE.Mesh(reveal, paint))

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(18, 16), concreteMaterial({ width: 18, depth: 16, color: '#131016', roughness: 0.34 }))
  floor.rotation.x = -Math.PI / 2
  floor.position.set(0.5, 0, 7.9)
  group.add(floor)

  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(18, 16), new THREE.MeshStandardMaterial({ color: 0x0a080c, roughness: 0.92 }))
  ceiling.rotation.x = Math.PI / 2
  ceiling.position.set(0.5, 3.7, 7.9)
  group.add(ceiling)

  // a rubber door mat
  const mat = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.012, 0.8), new THREE.MeshStandardMaterial({ color: 0x0d0c0e, roughness: 0.95 }))
  mat.position.set(0, 0.006, 0.5)
  group.add(mat)

  // the street beyond the glass
  const street = new THREE.Mesh(
    new THREE.PlaneGeometry(9, 5.5),
    new THREE.MeshBasicMaterial({ map: streetTexture(), toneMapped: false, fog: false }),
  )
  street.position.set(0, 1.9, -3.4)
  group.add(street)

  // ---------------------------------------------------------------- storefront
  // clear-anodised aluminium: at night it only shows what the tubes throw on it
  const bronze = new THREE.MeshStandardMaterial({ color: 0x77777e, roughness: 0.34, metalness: 0.85, envMapIntensity: 1.2 })
  const P = 0.05 // frame profile face width
  const D = 0.1 // profile depth
  const fz = frameZ - D / 2
  const leafL = -halfW + P + 0.004
  const leafR = halfW - P - 0.004
  const leafTop = 2.16
  const stile = 0.09
  const botRail = 0.25
  const topRail = 0.09
  const transom = 2.24
  const frame = mergeGeometries([
    // jambs and head of the storefront
    box(P, openH, D, -halfW + P / 2, openH / 2, fz),
    box(P, openH, D, halfW - P / 2, openH / 2, fz),
    box(halfW * 2, P, D, 0, openH - P / 2, fz),
    // transom bar
    box(halfW * 2, transom - leafTop + 0.02, D, 0, (leafTop + transom) / 2, fz),
    // the leaf: stiles and rails (a touch proud of the frame)
    box(stile, leafTop - 0.01, 0.05, leafL + stile / 2, (leafTop + 0.01) / 2, frameZ - 0.02),
    box(stile, leafTop - 0.01, 0.05, leafR - stile / 2, (leafTop + 0.01) / 2, frameZ - 0.02),
    box(leafR - leafL, botRail, 0.05, 0, 0.01 + botRail / 2, frameZ - 0.02),
    box(leafR - leafL, topRail, 0.05, 0, leafTop - topRail / 2, frameZ - 0.02),
    // glass stops (thin beads round the glass)
    box(0.012, leafTop - topRail - botRail, 0.02, leafL + stile + 0.006, (leafTop - topRail + botRail) / 2, frameZ + 0.004),
    box(0.012, leafTop - topRail - botRail, 0.02, leafR - stile - 0.006, (leafTop - topRail + botRail) / 2, frameZ + 0.004),
    // the closer: a box on the transom bar and its arm
    box(0.3, 0.06, 0.07, leafR - 0.28, transom - 0.02, frameZ + 0.035),
    box(0.26, 0.018, 0.02, leafR - 0.32, leafTop - 0.03, frameZ + 0.06),
  ])!
  group.add(new THREE.Mesh(frame, bronze))

  // push bar (satin steel) on its two brackets
  const satin = new THREE.MeshStandardMaterial({ color: 0x5a5a62, roughness: 0.5, metalness: 0.8, envMapIntensity: 1 })
  const barG = new THREE.CylinderGeometry(0.016, 0.016, leafR - leafL - 2 * stile + 0.1, 16)
  barG.rotateZ(Math.PI / 2)
  barG.translate(0, 1.02, frameZ + 0.07)
  const brk = [-1, 1].map(s => {
    const g = new THREE.CylinderGeometry(0.011, 0.011, 0.07, 10)
    g.rotateX(Math.PI / 2)
    g.translate(s * (leafR - stile / 2 - 0.01), 1.02, frameZ + 0.035)
    g.deleteAttribute('uv')
    return g
  })
  barG.deleteAttribute('uv')
  group.add(new THREE.Mesh(mergeGeometries([barG, ...brk])!, satin))

  // glass: dark, glossy, a little see-through
  const glass = new THREE.MeshStandardMaterial({
    color: 0x0a0c14,
    roughness: 0.05,
    metalness: 0.1,
    transparent: true,
    opacity: 0.34,
    envMapIntensity: 1.6,
    depthWrite: false,
  })
  const gDoor = new THREE.Mesh(new THREE.PlaneGeometry(leafR - leafL - 2 * stile, leafTop - topRail - botRail), glass)
  gDoor.position.set(0, (leafTop - topRail + botRail) / 2, glassZ)
  const gTrans = new THREE.Mesh(new THREE.PlaneGeometry(halfW * 2 - 2 * P, openH - P - transom), glass)
  gTrans.position.set(0, (openH - P + transom) / 2, glassZ)
  gDoor.renderOrder = gTrans.renderOrder = 2
  group.add(gDoor, gTrans)

  // ---------------------------------------------------------------- the OPEN sign
  const sign = new THREE.Group()
  sign.position.copy(DOOR.sign)
  group.add(sign)
  const { signW, signH } = DOOR
  const r = 0.0074
  const letters = textStrokes('OPEN', { font: 'sans', size: 0.205, tracking: 0.14 })
  // optical centring: the sans caps sit a hair high in their box
  for (const s of letters.strokes) for (const p of s.pts) p.y -= 0.004
  const openPart = neonFromStrokes(letters.strokes, { color: 'red', radius: r, hdr: 4.4, radial, depth: 0.034 })
  const gap = 0.05
  const border: Stroke = {
    pts: fillet(
      [
        [gap / 2, -signH / 2],
        [signW / 2, -signH / 2],
        [signW / 2, signH / 2],
        [-signW / 2, signH / 2],
        [-signW / 2, -signH / 2],
        [-gap / 2, -signH / 2],
      ],
      0.07,
      false,
      9,
    ),
  }
  const borderPart = neonFromStrokes([border], { color: 'blue', radius: r, hdr: 4.2, radial, smooth: false, depth: 0.034 })
  sign.add(openPart.group, borderPart.group)

  // the black wire frame behind the tubes
  const frameZs = -0.042
  const wire = new THREE.MeshStandardMaterial({ color: 0x0b0a0c, roughness: 0.45, metalness: 0.6 })
  const fw = signW - 0.05
  const fh = signH - 0.06
  const t = 0.008
  const wireG = mergeGeometries([
    box(fw, t, t, 0, fh / 2, frameZs),
    box(fw, t, t, 0, -fh / 2, frameZs),
    box(t, fh, t, -fw / 2, 0, frameZs),
    box(t, fh, t, fw / 2, 0, frameZs),
    box(fw, t, t, 0, -0.035, frameZs),
    // the transformer on the back, and its strap
    box(0.2, 0.075, 0.035, 0.05, -fh / 2 + 0.02, frameZs - 0.024),
    box(0.012, 0.1, 0.04, -0.02, -fh / 2 + 0.02, frameZs - 0.02),
  ])!
  sign.add(new THREE.Mesh(wireG, wire))
  // the power cord: out of the transformer, down past the push bar, to the floor and off to the wall
  const cord = new THREE.CatmullRomCurve3(
    [
      new THREE.Vector3(0.15, -fh / 2 + 0.01, frameZs - 0.04),
      new THREE.Vector3(0.2, -0.32, -0.06),
      new THREE.Vector3(0.24, -0.62, -0.02),
      new THREE.Vector3(0.3, -1.05, 0.05),
      new THREE.Vector3(0.36, -1.43, 0.2),
      new THREE.Vector3(0.52, -1.482, 0.32),
      new THREE.Vector3(0.86, -1.482, 0.12),
      new THREE.Vector3(0.95, -1.482, 0.1),
    ],
    false,
    'centripetal',
  )
  const cordMesh = new THREE.Mesh(new THREE.TubeGeometry(cord, 90, 0.0045, 6, false), new THREE.MeshStandardMaterial({ color: 0x0c0b0d, roughness: 0.6 }))
  sign.add(cordMesh)

  // clear tube supports: tube → frame
  const signSupports = [
    ...samplesAlong([border], 0.27, 0.3),
    ...samplesAlong(letters.strokes, 0.3, 0.5),
  ]
  for (const p of signSupports) supports.push({ at: p.clone().add(sign.position).setZ(sign.position.z + frameZs + 0.004), len: -frameZs - 0.006 })

  // the sign's light on the glass right behind it (red letters, blue border)
  const sGlassZ = glassZ - DOOR.sign.z + 0.003
  const openSpill = neonSpill(letters.strokes, { color: 'red', width: signW + 0.6, height: signH + 0.5, blur: 0.05, strength: 0.55 })
  const borderSpill = neonSpill([border], { color: 'blue', width: signW + 0.6, height: signH + 0.5, blur: 0.05, strength: 0.45 })
  openSpill.position.z = borderSpill.position.z = sGlassZ
  // additive light ON the glass: draw it after the glass
  openSpill.renderOrder = borderSpill.renderOrder = 3
  sign.add(openSpill, borderSpill)
  openPart.follow(openSpill)
  borderPart.follow(borderSpill)

  // its reflection in the dark glass: a mirrored, dim copy behind the glass plane
  const reflect = new THREE.Group()
  reflect.position.set(sign.position.x, sign.position.y, 2 * glassZ - sign.position.z)
  reflect.scale.z = -1
  for (const part of [openPart, borderPart]) {
    const u = part.material.uniforms
    const m = new THREE.ShaderMaterial({
      uniforms: { uColor: u.uColor, uOff: u.uOff, uLevel: u.uLevel, uDraw: u.uDraw, uHdr: { value: 0.55 } },
      vertexShader: part.material.vertexShader,
      fragmentShader: part.material.fragmentShader,
    })
    reflect.add(new THREE.Mesh(part.tube.geometry, m))
  }
  group.add(reflect)

  // chains: from the frame's top corners up to cup hooks in the door's top rail
  const hookY = leafTop - topRail / 2
  const chainLinks: THREE.Matrix4[] = []
  const linkLen = 0.024
  for (const s of [-1, 1]) {
    const x = sign.position.x + s * (fw / 2 - 0.03)
    const y0 = sign.position.y + fh / 2 + 0.006
    const z0 = sign.position.z + frameZs
    const top = new THREE.Vector3(x, hookY, frameZ + 0.01)
    const bottom = new THREE.Vector3(x, y0, z0)
    const n = Math.max(2, Math.round(top.distanceTo(bottom) / (linkLen * 0.78)))
    for (let i = 0; i < n; i++) {
      const p = bottom.clone().lerp(top, (i + 0.5) / n)
      const m = new THREE.Matrix4().compose(
        p,
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, i % 2 ? Math.PI / 2 : 0, 0)),
        new THREE.Vector3(1, 1, 1),
      )
      chainLinks.push(m)
    }
    // cup hook
    supports.push({ at: new THREE.Vector3(x, hookY, frameZ + 0.004), len: 0.02 })
  }
  const linkG = new THREE.TorusGeometry(0.0072, 0.0019, 5, 12)
  linkG.scale(1, 1.7, 1)
  const chainMat = new THREE.MeshStandardMaterial({ color: 0xb8b8c0, roughness: 0.3, metalness: 0.95 })
  const chains = new THREE.InstancedMesh(linkG, chainMat, chainLinks.length)
  chainLinks.forEach((m, i) => chains.setMatrixAt(i, m))
  group.add(chains)

  // ---------------------------------------------------------------- "Say hello." on the brick
  const hello = new THREE.Group()
  const helloT = textStrokes('Say hello.', { font: 'script', size: 0.33 })
  const helloX = halfW + 0.42 + helloT.width / 2
  hello.position.set(helloX, 1.78, 0.055)
  group.add(hello)
  const helloPart = neonFromStrokes(helloT.strokes, { color: 'pink', radius: 0.33 / 30, hdr: 4.4, radial, depth: 0.05 })
  hello.add(helloPart.group)
  const helloSpill = neonSpill(helloT.strokes, { color: 'pink', width: helloT.width + 1.1, height: helloT.height + 1.0, blur: 0.1, strength: 0.6, res: 384 })
  helloSpill.position.z = -0.053
  hello.add(helloSpill)
  // (not part.follow: the chapter scales this spill and its halo by how much of the word is written)
  for (const p of samplesAlong(helloT.strokes, 0.34, 0.5)) supports.push({ at: p.clone().add(hello.position).setZ(0.002), len: 0.05 })

  // ---------------------------------------------------------------- the other signs (they close first)
  const wallSign = (strokes: Stroke[], color: string, x: number, y: number, rad: number, hdr: number, w: number, h: number, smooth = true) => {
    const g = new THREE.Group()
    g.position.set(x, y, 0.045)
    group.add(g)
    const part = neonFromStrokes(strokes, { color, radius: rad, hdr, radial, depth: 0.04, smooth })
    g.add(part.group)
    const sp = neonSpill(strokes, { color, width: w, height: h, blur: 0.08, strength: 0.5 })
    sp.position.z = -0.043
    g.add(sp)
    part.follow(sp)
    for (const p of samplesAlong(strokes, 0.3, 0.5)) supports.push({ at: p.clone().add(g.position).setZ(0.002), len: 0.042 })
    return { part, g }
  }
  // an amber arrow pointing at the door
  const arrowStrokes: Stroke[] = [
    { pts: fillet([[-0.42, 0], [0.34, 0]], 0.02) },
    { pts: fillet([[0.12, 0.19], [0.37, 0], [0.12, -0.19]], 0.03, false, 6) },
  ]
  const arrow = wallSign(arrowStrokes, TUBE.amber, -1.32, 1.46, 0.0085, 4, 1.4, 0.9, false)
  // a UV star, higher and further along the wall
  const star: [number, number][] = []
  for (let i = 0; i < 10; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / 5
    const rr = i % 2 ? 0.13 : 0.3
    star.push([Math.cos(a) * rr, Math.sin(a) * rr])
  }
  const starSign = wallSign([{ pts: fillet(star, 0.025, true, 5), closed: true }], TUBE.violet, -2.55, 2.2, 0.0085, 4.4, 1.1, 1.1, false)

  // ---------------------------------------------------------------- tube supports (one instanced mesh)
  const supG = new THREE.CylinderGeometry(0.0045, 0.0045, 1, 6)
  supG.rotateX(Math.PI / 2)
  supG.translate(0, 0, 0.5)
  const supM = new THREE.MeshStandardMaterial({ color: 0xc8d0d8, roughness: 0.25, metalness: 0, transparent: true, opacity: 0.55 })
  const sup = new THREE.InstancedMesh(supG, supM, supports.length)
  supports.forEach((s, i) => sup.setMatrixAt(i, new THREE.Matrix4().makeTranslation(s.at.x, s.at.y, s.at.z).multiply(new THREE.Matrix4().makeScale(1, 1, s.len))))
  group.add(sup)

  // ---------------------------------------------------------------- fluorescents
  const rodMat = new THREE.MeshStandardMaterial({ color: 0x3a3a40, roughness: 0.5, metalness: 0.7 })
  const fixture = (x: number, z: number, len: number, intensity: number) => {
    const f = fluorescentFixture(len, { intensity })
    f.group.position.set(x, 2.98, z)
    const rodG = mergeGeometries(
      [-1, 1].map(s => {
        const g = new THREE.CylinderGeometry(0.004, 0.004, 3.7 - 2.98, 5)
        g.translate(s * len * 0.38, (3.7 - 2.98) / 2 + 0.05, 0)
        return g
      }),
    )!
    f.group.add(new THREE.Mesh(rodG, rodMat))
    group.add(f.group)
    return f
  }
  const flA = fixture(-1.65, 0.7, 1.2, 16)
  const flB = fixture(1.55, 0.95, 1.2, 16)
  // bare white tubes bloom ~3x harder than coloured ones
  flA.part.setHdr(2.1)
  flB.part.setHdr(2.1)

  // ---------------------------------------------------------------- the signs' light on the room (4 + 2 fixtures = 6)
  // a thin emitter: on the sealed floor its reflection is a streak, not a slab
  const openLight = tubeLight(openPart, { width: 0.5, height: 0.08, intensity: 6 })
  openLight.position.set(0, DOOR.sign.y, 0.02)
  openLight.lookAt(0, DOOR.sign.y - 0.25, 3)
  group.add(openLight)
  syncs.push(() => openLight.sync())
  const wallLight = (part: NeonPart, x: number, y: number, w: number, h: number, i: number, sync = true) => {
    const l = tubeLight(part, { width: w, height: h, intensity: i })
    l.position.set(x, y, 0.16)
    l.lookAt(x, y, -1)
    group.add(l)
    if (sync) syncs.push(() => l.sync())
    return l
  }
  const helloLight = wallLight(helloPart, helloX, 1.78, helloT.width * 0.9, 0.5, 6, false)
  wallLight(arrow.part, -1.3, 1.46, 0.7, 0.3, 5)
  // the sign's red on the door and the brick round it (a wash from the room side)
  const doorLight = tubeLight(openPart, { width: 1.1, height: 0.7, intensity: 4 })
  doorLight.position.set(0, DOOR.sign.y + 0.05, 0.42)
  doorLight.lookAt(0, DOOR.sign.y - 0.1, -1)
  group.add(doorLight)
  syncs.push(() => doorLight.sync())

  return {
    openPart,
    borderPart,
    helloPart,
    arrowPart: arrow.part,
    starPart: starSign.part,
    flA,
    flB,
    helloWidth: helloT.width,
    helloX,
    sync() {
      for (const s of syncs) s()
    },
    /** "Say hello."'s wall light follows how much of the word is lit (level x written) */
    setHelloGlow(v: number) {
      helloSpill.setLevel(v)
      helloLight.intensity = v * 6
    },
  }
}
