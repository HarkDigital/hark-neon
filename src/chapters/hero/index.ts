import * as THREE from 'three'
import type { CameraPose, Chapter, Frame } from '../../core/types'
import { el, reveal, rise, setRise } from '../../core/dom'
import { BRAND, MICROCOPY } from '../../content'
import { ease, lerp, segment, smoothstep } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { whenRevealed } from '../../kit/images'
import { markStrokes, neonFromStrokes, neonSpill, neonText, Striker, TUBE, type NeonPart } from '../../kit/neon'
import { backerPanel, brickMaterial, concreteMaterial, fluorescentFixture, initAreaLights, steelMaterial } from '../../kit/shop'
import type { Stroke } from '../../kit/type'
import { arrowOutline, floorStreak, roundedFrame, strokeBounds, swash } from './shapes'
import './hero.css'

/*
 * HERO · "Lights On" — the shop's front room at night.
 *
 *   0.00–0.10  landing: bare fluorescents (struck once, on reveal) light the
 *              brick and the sealed floor; the Hark mark hangs on its black
 *              acrylic backer in unlit grey glass; only the red OPEN is on.
 *              Intro copy top-left (phones: top band).
 *   0.12–0.55  neon on: the camera dollies in; the mark's three tubes strike
 *              one by one, then the colour signs ("Neon" writes itself); at
 *              LIGHTS_OUT the fluorescents go out and the room is neon only.
 *   0.60–0.95  payoff: the lit sign framed right (portrait: above centre);
 *              h1 + CTAs.
 *   0.95–1.00  out: push into the mark (bright tubes for the lights-out cut).
 *
 * Everything derives from `local`; Strikers are the only time-based state
 * (settle ≤ 0.5 s). Six RectAreaLights, fixed: three fluorescents, the mark's
 * halo (between backer and brick) and two low pools under "Neon" (pink,
 * blue). The streaks on the concrete are additive floor planes (floorStreak)
 * that follow each sign's level.
 */

const WALL_Z = -0.6
const FLOOR_Y = -2.2
/** the backer's standoffs: its face sits this far off the brick */
const STANDOFF = 0.2
/** local where the fluorescents go out: neon only after this */
const LIGHTS_OUT = 0.5
/** fluorescent RectAreaLight intensity at full level */
const FLUO_I = 150
/** the mark's white HDR (white blooms ~3x harder than colour) */
const MARK_HDR = 1.7
/** "Neon" writes itself across this local range */
const WRITE_A = 0.33
const WRITE_B = 0.41

type SignId = 'mark' | 'open' | 'arrow' | 'neon'
type Place = { x: number; y: number; s?: number; rot?: number }

/** Landscape: the colour signs cluster right of the mark; the left stays dark brick for the copy. */
const LAYOUT_L: Record<SignId, Place> = {
  mark: { x: 0, y: 0.45 },
  open: { x: 3.6, y: 1.55 },
  arrow: { x: 3.55, y: 0.2 },
  neon: { x: -2.55, y: -1.55, s: 0.92 },
}
/** Portrait: a narrow frame — the signs stack above and below the mark. */
const LAYOUT_P: Record<SignId, Place> = {
  mark: { x: 0, y: 0.6 },
  open: { x: -0.95, y: 2.85, s: 0.8 },
  arrow: { x: 1.25, y: 2.85, s: 0.72, rot: Math.PI / 2 },
  neon: { x: 0, y: -1.62, s: 0.74 },
}
/** fixture drop heights per orientation (portrait hangs the first one above the OPEN sign) */
const FIX_Y_L = [3.0, 3.0, 3.9]
const FIX_Y_P = [3.75, 3.0, 3.9]
/** where the drop rods meet the (unseen) ceiling */
const CEILING_Y = 6.5

type Pose = { p: THREE.Vector3; t: THREE.Vector3; fov: number }
const pose = (px: number, py: number, pz: number, tx: number, ty: number, tz: number, fov: number): Pose => ({
  p: new THREE.Vector3(px, py, pz),
  t: new THREE.Vector3(tx, ty, tz),
  fov,
})
const CAM_L = {
  land: pose(0.9, 0.3, 11.8, -0.95, 0.35, 0, 42),
  near: pose(-0.3, 0.45, 8.8, -0.45, 0.3, 0, 41),
  pay: pose(-1.4, 1.0, 7.7, -1.6, 0.05, 0, 40),
  pay2: pose(-1.3, 1.0, 7.35, -1.52, 0.07, 0, 40),
  out: pose(0, 0.5, 2.6, 0, 0.5, 0, 38),
}
/** 4:3-ish landscape (tablets, small laptops): the payoff pulls back so "Neon" clears the CTAs */
const CAM_L43 = {
  ...CAM_L,
  pay: pose(-1.25, 1.0, 8.4, -1.35, 0.3, 0, 40),
  pay2: pose(-1.15, 1.0, 8.05, -1.28, 0.32, 0, 40),
}
const CAM_P = {
  land: pose(0.1, 0.1, 13.6, 0, 1.3, 0, 52),
  near: pose(0, 0.2, 11.2, 0, 0.9, 0, 51),
  pay: pose(0, 0.3, 10.2, 0, -0.35, 0, 50),
  pay2: pose(0, 0.32, 9.8, 0, -0.3, 0, 50),
  out: pose(0, 0.65, 3.4, 0, 0.65, 0, 44),
}

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

type Cams = typeof CAM_L
const blended: Cams = {
  land: pose(0, 0, 0, 0, 0, 0, 40),
  near: pose(0, 0, 0, 0, 0, 0, 40),
  pay: pose(0, 0, 0, 0, 0, 0, 40),
  pay2: pose(0, 0, 0, 0, 0, 0, 40),
  out: pose(0, 0, 0, 0, 0, 0, 40),
}
/** a camera set between two others (no allocation) */
function blendCams(a: Cams, b: Cams, k: number): Cams {
  for (const key of Object.keys(blended) as (keyof Cams)[]) {
    const o = blended[key]
    o.p.lerpVectors(a[key].p, b[key].p, k)
    o.t.lerpVectors(a[key].t, b[key].t, k)
    o.fov = lerp(a[key].fov, b[key].fov, k)
  }
  return blended
}

export default function create(): Chapter {
  const group = new THREE.Group()
  const signs = {} as Record<SignId, THREE.Group>
  const tubes: Tube[] = []
  const mark: NeonPart[] = []
  let neonWord: NeonPart
  let neonWordFx: Level[] = []
  let swashTube: NeonPart
  let backerW = 3
  let backerH = 3
  const fixtures: { fx: ReturnType<typeof fluorescentFixture>; s: Striker; delay: number }[] = []
  let rods: THREE.InstancedMesh
  /**
   * floor streaks: each starts at a point on the floor (x from its sign or
   * fixture, z0 out from the wall) and smears toward the camera, re-aimed
   * every frame — a reflection always points at the viewer
   */
  const streaks: { mesh: Streak; id: SignId | null; x: number; z0: number; len: number; bx: number; sx: number }[] = []
  let markStreak: Streak
  let halo: THREE.RectAreaLight
  let pinkPool: THREE.RectAreaLight
  let bluePool: THREE.RectAreaLight
  let portrait: boolean | null = null
  let revealAt = -1
  let busy = true

  let intro: HTMLElement
  let payoff: HTMLElement
  let title: HTMLElement

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
    const L = p ? LAYOUT_P : LAYOUT_L
    for (const id of Object.keys(signs) as SignId[]) {
      const g = signs[id]
      const at = L[id]
      g.position.x = at.x
      g.position.y = at.y
      g.scale.setScalar(at.s ?? 1)
      g.rotation.z = at.rot ?? 0
    }
    for (const st of streaks) {
      if (!st.id) continue
      const at = L[st.id]
      const s = at.s ?? 1
      // a rotated (vertical) sign throws a narrow streak
      st.sx = at.rot ? s * 0.45 : s
      st.bx = at.x + st.x * s
    }
    // fixtures (and their drop rods) hang at this orientation's heights
    const fy = p ? FIX_Y_P : FIX_Y_L
    const mtx = new THREE.Matrix4()
    fixtures.forEach((f, i) => {
      const g = f.fx.group
      g.position.y = fy[i]
      const len = CEILING_Y - (fy[i] + 0.07)
      for (const sx of [-1, 1]) {
        mtx.makeScale(1, len, 1).setPosition(g.position.x + sx * 0.6, fy[i] + 0.07 + len / 2, g.position.z)
        rods.setMatrixAt(i * 2 + (sx < 0 ? 0 : 1), mtx)
      }
    })
    rods.instanceMatrix.needsUpdate = true
    const m = L.mark
    const face = WALL_Z + STANDOFF + 0.012
    // halo: between the backer and the brick, facing the wall (never in front of the acrylic)
    halo.position.set(m.x, m.y, face - 0.05)
    halo.lookAt(m.x, m.y, WALL_Z - 4)
    // "Neon": two low lights facing down and out — coloured pools on the concrete
    const n = L.neon
    const ns = n.s ?? 1
    pinkPool.position.set(n.x, n.y, WALL_Z + 0.2)
    pinkPool.lookAt(n.x, FLOOR_Y - 2, WALL_Z + 2.2)
    pinkPool.width = 1.8 * ns
    bluePool.position.set(n.x + 0.05, n.y - 0.5 * ns, WALL_Z + 0.2)
    bluePool.lookAt(n.x, FLOOR_Y - 2, WALL_Z + 2.6)
    bluePool.width = 2.0 * ns
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

  return {
    id: 'hero',
    group,
    anchors: [0.8],
    busy: () => busy,
    async init(ctx) {
      const radial = ctx.mobile ? 6 : 8
      initAreaLights()
      whenRevealed().then(() => (revealAt = performance.now() / 1000))

      // ---------------------------------------------------------------- room
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(24, 8.4), brickMaterial({ width: 24, height: 8.4, tint: '#2a1f27' }))
      wall.position.set(0, FLOOR_Y + 4.2, WALL_Z)
      group.add(wall)
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(28, 24), concreteMaterial({ width: 28, depth: 24, color: '#2d292f', roughness: 0.42 }))
      floor.rotation.x = -Math.PI / 2
      floor.position.set(0, FLOOR_Y, WALL_Z + 12)
      group.add(floor)
      // a painted skirting where brick meets concrete (a crisp base line)
      const skirt = new THREE.Mesh(new THREE.BoxGeometry(24, 0.14, 0.03), new THREE.MeshStandardMaterial({ color: 0x0b090c, roughness: 0.5 }))
      skirt.position.set(0, FLOOR_Y + 0.07, WALL_Z + 0.015)
      group.add(skirt)

      // bare fluorescent fixtures on drop rods. Two hang in frame (over the
      // mark and over the colour signs); the third is overhead, out of shot,
      // lighting the concrete in the foreground. The left of the wall stays
      // darker, behind the copy.
      const FIX = [
        { x: 0.15, y: 3.0, z: 0.55, delay: 0.25, stutters: 1 as const, tilt: 0.3 },
        { x: 4.2, y: 3.0, z: 0.55, delay: 0.6, stutters: 0 as const, tilt: 0.3 },
        { x: -3.9, y: 3.9, z: 4.2, delay: 0.8, stutters: 0 as const, tilt: 0 },
      ]
      const rodGeo = new THREE.CylinderGeometry(0.008, 0.008, 1, 6)
      // instanced: its own material (the fixtures' end caps draw steelMaterial() as plain meshes)
      rods = new THREE.InstancedMesh(rodGeo, steelMaterial().clone(), FIX.length * 2)
      rods.frustumCulled = false
      FIX.forEach((f, i) => {
        const fx = fluorescentFixture(1.7, { intensity: FLUO_I })
        fx.group.position.set(f.x, f.y, f.z)
        fx.part.setHdr(2.3)
        if (fx.light) {
          // the diffuser's width, tipped a little toward the brick: a wash down the wall
          fx.light.height = 0.24
          fx.light.rotation.x = -Math.PI / 2 + f.tilt
        }
        group.add(fx.group)
        fixtures.push({ fx, s: new Striker({ stutters: f.stutters, depth: 0.5, off: 0.3, ramp: 0.25 }), delay: f.delay })
        // the tube's long reflection down the sealed concrete
        const line = [{ pts: [new THREE.Vector3(-0.85, 0, 0), new THREE.Vector3(0.85, 0, 0)] }]
        fx.part.follow(addStreak(null, line, '#dfe8ff', 2.6, { x: f.x, z0: f.z - WALL_Z, len: 7, strength: 0.3, falloff: 2.2, seed: 11 + i }))
      })
      group.add(rods)
      await nextFrame()

      // ---------------------------------------------------------------- the mark
      const ms = markStrokes(2.05, 0)
      const all = [...ms.loopA, ...ms.loopB, ...ms.diamond]
      const mb = strokeBounds(all)
      const mc = mb.getCenter(new THREE.Vector2())
      for (const s of all) for (const p of s.pts) p.set(p.x - mc.x, p.y - mc.y, 0)
      const msz = mb.getSize(new THREE.Vector2())
      backerW = msz.x + 1.15
      backerH = msz.y + 1.0
      const markSign = onWall('mark')
      markSign.position.z = WALL_Z + STANDOFF + 0.012
      markSign.add(backerPanel(backerW, backerH, { standoff: STANDOFF }))
      const thresholds = [0.15, 0.215, 0.28]
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
        tubes.push({ part: fr, s: new Striker({ stutters: 1 }), on: l => l >= 0.43 })
      }
      // an amber arrow pointing at the mark
      {
        const g = onWall('arrow')
        const st = arrowOutline(1.4, 0.64, 0.22, 0.52, 0.05)
        const part = neonFromStrokes([st], { color: 'amber', radius: 0.018, hdr: 4.2, smooth: false, radial })
        part.group.position.z = 0.075
        g.add(part.group)
        const sp = neonSpill([st], { color: 'amber', width: 2.5, height: 1.6, blur: 0.12, strength: 0.5, res: 192 })
        sp.position.z = 0.004
        g.add(sp)
        part.follow(sp)
        part.follow(addStreak('arrow', [st], TUBE.amber, 1.9, { z0: 0.3, len: 4, strength: 0.14, falloff: 2.8, seed: 7 }))
        tubes.push({ part, s: new Striker({ stutters: 1 }), on: l => l >= 0.385 })
      }
      await nextFrame()
      // "Neon" in pink script (writes itself along its tube) over an argon-blue swash
      {
        const g = onWall('neon')
        const { part, text } = neonText('Neon', { font: 'script', size: 0.62 }, { color: 'pink', hdr: 4.4, radial })
        part.group.position.z = 0.075
        g.add(part.group)
        const sw = swash(-text.width / 2 + 0.15, text.width / 2 + 0.2, -0.5, 0.07, 0.2)
        const blue = neonFromStrokes([sw], { color: 'blue', radius: 0.019, hdr: 4.4, radial })
        blue.group.position.z = 0.075
        g.add(blue.group)
        const psp = neonSpill([...text.strokes, sw], { color: 'pink', width: text.width + 1.3, height: text.height + 1.4, blur: 0.13, strength: 0.55, res: 192 })
        psp.position.z = 0.004
        g.add(psp)
        const bsp = neonSpill([sw], { color: 'blue', width: text.width + 1.3, height: text.height + 1.4, blur: 0.12, strength: 0.6, res: 192 })
        bsp.position.z = 0.005
        g.add(bsp)
        blue.follow(bsp)
        blue.follow(addStreak('neon', [sw], TUBE.blue, text.width + 0.4, { strength: 0.32, len: 4, falloff: 3.4, seed: 9 }))
        // the pink word's light follows how much of it has been written
        neonWordFx = [psp, addStreak('neon', text.strokes, TUBE.pink, text.width + 0.8, { strength: 0.5, len: 4.5, falloff: 3, seed: 8 })]
        neonWord = part
        swashTube = blue
        tubes.push({ part, s: new Striker({ stutters: 0, ramp: 0.12 }), on: l => l >= WRITE_A, draw: l => segment(l, WRITE_A, WRITE_B) })
        tubes.push({ part: blue, s: new Striker({ stutters: 1 }), on: l => l >= 0.45 })
      }

      // ---------------------------------------------------------------- sign light on the room (count fixed: 3 fluorescents + 3 here)
      halo = new THREE.RectAreaLight(TUBE.white, 0, backerW - 0.5, backerH - 0.5)
      pinkPool = new THREE.RectAreaLight(TUBE.pink, 0, 1.8, 0.35)
      bluePool = new THREE.RectAreaLight(TUBE.blue, 0, 2.0, 0.2)
      group.add(halo, pinkPool, bluePool)
      applyLayout(false)

      // ---------------------------------------------------------------- DOM
      intro = el('div', 'hr-intro', undefined, ctx.stage)
      el('p', 'hud-eyebrow', MICROCOPY.signalEyebrow, intro)
      el('p', 'hud-body', BRAND.manifesto, intro)
      el('p', 'hud-label hr-hint', MICROCOPY.scrollHint + ' ↓', intro)

      payoff = el('div', 'hr-payoff', undefined, ctx.stage)
      const inner = el('div', 'hr-payoff-inner', undefined, payoff)
      el('p', 'hud-label hr-locale', BRAND.locale, inner)
      title = rise(el('h1', 'hud-title hr-title', undefined, inner), 'Make the internet <em>listen.</em>')
      const ctas = el('div', 'hr-ctas', undefined, inner)
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
      const p = frame.height > frame.width
      if (p !== portrait) applyLayout(p)
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
      const written = neonWord.level * (ctx.reducedMotion ? 1 : segment(local, WRITE_A, WRITE_B))
      for (const fx of neonWordFx) fx.setLevel(written)
      pinkPool.intensity = written * 10
      bluePool.intensity = swashTube.level * 10

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
      const P = ctx.post.params
      P.bloomRadius = 0.2

      // copy
      reveal(intro, 1 - smoothstep(0.075, 0.13, local))
      reveal(payoff, smoothstep(0.62, 0.68, local) * (1 - smoothstep(0.935, 0.965, local)))
      setRise(title, local > 0.63 && local < 0.95)
    },

    camera(local: number, frame: Frame, out: CameraPose) {
      const aspect = frame.width / Math.max(1, frame.height)
      const w43 = aspect < 1 ? 0 : 1 - segment(aspect, 1.33, 1.6)
      const K = aspect < 1 ? CAM_P : w43 <= 0 ? CAM_L : blendCams(CAM_L, CAM_L43, w43)
      let a: Pose
      let b: Pose
      let k: number
      if (local < 0.56) {
        a = K.land
        b = K.near
        k = easeSine(segment(local, 0.0, 0.56))
      } else if (local < 0.68) {
        a = K.near
        b = K.pay
        k = ease.inOutCubic(segment(local, 0.56, 0.68))
      } else if (local < 0.92) {
        a = K.pay
        b = K.pay2
        k = segment(local, 0.68, 0.92)
      } else {
        a = K.pay2
        b = K.out
        k = easeSine(segment(local, 0.92, 1))
      }
      out.position.lerpVectors(a.p, b.p, k)
      out.target.lerpVectors(a.t, b.t, k)
      out.fov = lerp(a.fov, b.fov, k)
      out.parallax = 0.22
    },
  }
}
