import * as THREE from 'three'
import type { Chapter, Frame } from '../../core/types'
import { el, rise, setRise, reveal } from '../../core/dom'
import { SECTIONS, SERVICES } from '../../content'
import { clamp, lerp, smoothstep } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { beat } from '../common'
import { Striker, TUBE } from '../../kit/neon'
import { StoryClock } from '../../kit/pace'
import { brickMaterial, concreteMaterial, fluorescentFixture, initAreaLights, steelMaterial } from '../../kit/shop'
import { buildChart, chartBounds, swatchName, tilePos, tileX, ROW_H, TILE_H, TILE_W, TILE_Y, WALL_Z, type Tile } from './chart'
import '../chapter.css'
import './services.css'

/*
 * SERVICES · "Tube Chart". The shop's colour chart: eleven sample tubes on
 * black acrylic tiles on the brick wall, one colour of gas/phosphor per
 * service, each bent into that service's icon (icons.ts). Landscape hangs
 * the chart as one long row; portrait as a three-column grid (chart.ts).
 *
 *   0.00–0.125 the whole chart, every tube dim glass with a faint shimmer
 *              running along it; "What we do" / Eleven ways to be heard.
 *              (held ~0.35 vh clear of the cut; nav landings arrive here)
 *   0.14–0.86  eleven beats: the camera trucks along the chart; each tube
 *              strikes on in its colour as the camera arrives and cuts out
 *              as it leaves (neighbours stay dim, so the
 *              chart reads as a spectrum) and colours the room (haze,
 *              motes, a halo on the brick behind the tile); the card
 *              names it
 *   0.855–1.0  pull back: all eleven strike by 0.89 and HOLD — the full
 *              spectrum is lit and steady well before the lights-out cut
 *              (from ~0.96), never struck inside it
 *
 * PACING (flash safety, WCAG 2.3.1). Nothing above reads `local` directly:
 * a StoryClock (kit/pace.ts) turns it into `q`, which follows the scroll at
 * a reading rate (1.1 tubes a second; a truck between tubes takes 0.5 s),
 * so the lit tube changes at most ~1.1×/s however fast the page moves. When
 * the reader scans (a brisk scroll, or the story falls > 1.6 tubes behind)
 * the shop goes to TRAVEL: every tube drops to unlit glass, the card fades
 * out, and the clock chases the scroll in a steady pan past dark tiles —
 * nothing bright is left to sweep across the frame. At rest the camera
 * settles, the tube strikes, the card fills.
 */

const N = SERVICES.length
const A = 0.14
const B = 0.86
const SPAN = (B - A) / N
/** share of a slot spent trucking between tiles (the rest is a dwell) */
const GLIDE = 0.55
/** neighbours' level: dim coloured glass, never crossing the bloom threshold */
const DIM = 0.1
/** every tube while the reader scans: unlit glass */
const TRAVEL_LV = 0.04
/** reading pace, in tubes per second (≤ 1.2 item changes/s) */
const READ_RATE = 1.1
/** scanning chase, in tubes per second: proportional to how far behind, clamped */
const CHASE_K = 2.2
const CHASE_MIN = 2.2
const CHASE_MAX = 10
/** minimum seconds between strikes (a second guard behind the clock) */
const LIT_GAP = 0.6
/** the intro: headline + wide shot until INTRO_OUT, the push-in to tile 01 by WIDE_IN */
const INTRO_OUT = 0.125
const WIDE_IN = 0.16
/** beats light from here (the camera arriving on tile 01) */
const LIT_FROM = 0.15
/** the finale: pull back FIN_A–FIN_B, the chart strikes from FIN_STRIKE (tile 11 is already lit) */
const FIN_A = 0.855
const FIN_B = 0.895
const FIN_STRIKE = 0.868
/** past here a moving reader gets no new strikes (the lights-out cut starts ~0.96): nothing strikes just before it */
const FIN_LATE = 0.92
const FOV = 40
const TAN = Math.tan(((FOV / 2) * Math.PI) / 180)
const FIX_Z = 1.3
/** the room per hang: floor height, fixture height */
const ROOM = {
  row: { floor: -1.75, fixY: 3.3, fixX: [-5.2, 0, 5.2, 10.4] },
  // portrait: the copy owns the top of the frame, so no fixtures over the grid
  grid: { floor: chartBounds(true).y0 - 1.0, fixY: chartBounds(true).y1 + 1.0, fixX: [99, 99, 99, 99] },
}

const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)
const portraitOf = (frame: Frame) => frame.height > frame.width
const approach = (x: number, to: number, step: number) => (x < to ? Math.min(to, x + step) : Math.max(to, x - step))

/** the continuous tile index for story position q: plateaus at each tile, eased trucks between */
function track(q: number) {
  const u = (q - A) / SPAN - 0.5
  const n = Math.floor(u)
  const t = clamp((u - n - (1 - GLIDE) / 2) / GLIDE)
  return clamp(n + smoother(t), 0, N - 1)
}
/** the same without plateaus: a steady pan (scanning) */
const trackLinear = (q: number) => clamp((q - A) / SPAN - 0.5, 0, N - 1)

const _p0 = new THREE.Vector2()
const _p1 = new THREE.Vector2()
/** the chart position of a (fractional) tile index */
function trackPos(f: number, portrait: boolean, out: THREE.Vector2) {
  const i = Math.floor(f)
  tilePos(i, portrait, _p0)
  tilePos(Math.min(N - 1, i + 1), portrait, _p1)
  return out.copy(_p0).lerp(_p1, f - i)
}

/** 1 = the wide shot of the whole chart (intro, finale) */
const wideAt = (q: number) => Math.max(1 - smoothstep(INTRO_OUT, WIDE_IN, q), smoothstep(FIN_A, FIN_B, q))

/** the card's per-tube CSS colours (sRGB bytes straight from the hex) */
function cssVars(hex: string) {
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  const mix = (k: number) => `rgb(${Math.round(255 - (255 - r) * k)}, ${Math.round(255 - (255 - g) * k)}, ${Math.round(255 - (255 - b) * k)})`
  return {
    '--sv-core': mix(0.28),
    '--sv-text': mix(0.14),
    '--sv-edge': `rgba(${r}, ${g}, ${b}, 0.55)`,
    '--sv-glow': `rgba(${r}, ${g}, ${b}, 0.85)`,
    '--sv-glow-2': `rgba(${r}, ${g}, ${b}, 0.4)`,
  }
}

export default function create(): Chapter {
  const group = new THREE.Group()
  const beats = beat(0, N, A, B)
  let tiles: Tile[] = []
  let relayoutChart: (portrait: boolean) => boolean = () => false
  const strikers: Striker[] = []
  const levels = new Float32Array(N)
  let fixtures: ReturnType<typeof fluorescentFixture>[] = []
  let rods: THREE.InstancedMesh
  let floor: THREE.Mesh
  let halo: THREE.RectAreaLight[] = []
  let wash: THREE.RectAreaLight
  let hang: boolean | null = null
  const roomColor = new THREE.Color()
  const moteColor = new THREE.Color()
  const tmpC = new THREE.Color()
  const white = new THREE.Color('#ffffff')
  const idle = new THREE.Color('#b24a8c')
  const finA = new THREE.Color(TUBE.pink)
  const finB = new THREE.Color(TUBE.blue)
  const tp = new THREE.Vector2()

  let stage: HTMLElement
  let intro: HTMLElement, introTitle: HTMLElement
  /** the card holds all eleven services stacked in one grid cell: it is always as tall as the tallest, with no measuring */
  let card: HTMLElement
  let bodies: HTMLElement[] = []

  // ---- pacing (time-based; the scene derives from q = clock.value)
  const clock = new StoryClock({ rate: READ_RATE * SPAN })
  let now = 0
  let prevLocal = -1
  let travelling = false
  /** 0 = reading (dwell on each tile) … 1 = scanning (a steady pan) */
  let travK = 0
  /** the card, faded out while scanning */
  let cardK = 1
  /** the service the card shows, and its copy's opacity (dips while it swaps) */
  let shown = 0
  let bodyK = 1
  let lit = -1
  /** the finale's full spectrum has struck (latched until the story backs out of it) */
  let finOn = false
  let litAt = -1e9
  let darkAt = -1e9
  let settling = false
  /** what camera() needs from this frame's update() */
  let camF = 0
  let camWide = 1
  let camQ = 0
  /** measured on resize: the card's top edge, its width; the intro's bottom edge (px) */
  let cardTop = -1
  let cardW = 440
  let introBottom = -1

  /** the card's lit top tube takes service i's colour */
  const paint = (i: number) => {
    for (const [k, v] of Object.entries(cssVars(tiles[i]?.hex ?? TUBE.pink))) card.style.setProperty(k, v)
  }
  const swap = (i: number) => {
    reveal(bodies[shown], 0, 0)
    shown = i
    paint(i)
  }

  /** note where the copy sits (reads only: one layout) */
  const measure = () => {
    if (!card) return
    cardTop = card.offsetTop
    cardW = card.offsetWidth
    introBottom = intro.offsetTop + intro.offsetHeight
  }

  /** hang the chart and the room for this orientation */
  const relayout = (portrait: boolean) => {
    if (hang === portrait) return
    hang = portrait
    relayoutChart(portrait)
    const room = portrait ? ROOM.grid : ROOM.row
    floor.position.y = room.floor
    const m = new THREE.Matrix4()
    fixtures.forEach((f, i) => {
      const x = room.fixX[i]
      f.group.visible = x < 50
      f.group.position.set(x, room.fixY, FIX_Z)
      for (const s of [-1, 1]) rods.setMatrixAt(i * 2 + (s > 0 ? 1 : 0), m.makeTranslation(f.group.visible ? x + s * 0.6 : 999, room.fixY, FIX_Z))
    })
    rods.instanceMatrix.needsUpdate = true
    rods.computeBoundingSphere()
  }

  /** the pose on tile f (continuous), clear of the card */
  const beatPose = (f: number, frame: Frame, pos: THREE.Vector3, tgt: THREE.Vector3) => {
    const w = frame.width
    const h = frame.height
    const aspect = w / h
    const portrait = h > w
    trackPos(f, portrait, tp)
    if (portrait) {
      // the tile sits in the band between the chrome and the card; its grid
      // neighbours show round the edges
      const top = clamp(0.105 * h, 80, 112)
      const bottom = cardTop > 0 ? cardTop - 10 : h * 0.56
      const band = Math.max(120, bottom - top)
      const vw = TILE_W / 0.56
      const vh = Math.max(vw / aspect, (TILE_H * 1.12 * h) / band)
      const yc = (top + bottom) / 2 / h
      const dist = vh / 2 / TAN
      tgt.set(tp.x, tp.y - (0.5 - yc) * vh, 0)
      pos.set(tp.x - 0.3, tgt.y + 0.3, dist)
    } else {
      const vh = aspect < 1.45 ? 3.9 : 3.65
      const dist = vh / 2 / TAN
      const gutter = clamp(0.034 * w, 16, 48)
      const cardFrac = (gutter + cardW) / w
      const fx = 0.5 + 0.5 * cardFrac + 0.02
      tgt.set(tp.x - (fx - 0.5) * vh * aspect, tp.y + 0.04, 0)
      pos.set(tgt.x - 0.5, tp.y + 0.4, dist)
    }
  }

  /**
   * The whole chart in one shot. Landscape in: from past its first tile,
   * looking down its length (the tiles recede, the fixtures over them).
   * Landscape out: square on, the full spectrum in a row. Portrait: the grid
   * square on, clear of the copy.
   */
  const widePose = (frame: Frame, out: boolean, pos: THREE.Vector3, tgt: THREE.Vector3) => {
    const w = frame.width
    const h = frame.height
    const aspect = w / h
    if (h > w) {
      const b = chartBounds(true)
      const top = out ? clamp(0.105 * h, 80, 112) : Math.max(introBottom > 0 ? introBottom + 14 : h * 0.3, h * 0.2)
      const bottom = h - (out ? 0.06 * h : clamp(0.105 * h, 82, 110))
      const band = Math.max(160, bottom - top)
      const gw = (b.x1 - b.x0) * 1.1
      const gh = (b.y1 - b.y0) * 1.04
      const vh = Math.max(gw / aspect, (gh * h) / band)
      const yc = (top + bottom) / 2 / h
      const cy = (b.y0 + b.y1) / 2
      const dist = vh / 2 / TAN
      tgt.set(0, cy - (0.5 - yc) * vh, 0)
      pos.set(out ? 0 : -0.5, tgt.y + (out ? 0.2 : 0.5), dist)
      return
    }
    const x0 = tileX(0)
    if (!out) {
      // narrower screens step back so tile 01 stays whole
      const back = clamp((1.6 - aspect) * 2.2, 0, 1.2)
      tgt.set(x0 + 5.75, TILE_Y + 0.2, 0)
      pos.set(x0 - 5.75 - back, TILE_Y + 0.6 + back * 0.2, 4.5 + back * 0.9)
      return
    }
    const b = chartBounds(false)
    const vw = (b.x1 - b.x0) * 1.1
    const vh = vw / aspect
    const dist = vh / 2 / TAN
    tgt.set(0, TILE_Y + 0.35, 0)
    pos.set(0, TILE_Y + 0.9, dist)
  }

  const pA = new THREE.Vector3()
  const tA = new THREE.Vector3()
  const pB = new THREE.Vector3()
  const tB = new THREE.Vector3()

  return {
    id: 'services',
    group,
    anchors: beats.centers,
    async init(ctx) {
      stage = ctx.stage
      initAreaLights()
      // the wall (tall enough for the grid), the shop's corner past the
      // chart's far end (closes the long view), the floor
      const span = tileX(N - 1) - tileX(0) + 44
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(span, 20), brickMaterial({ width: span, height: 20, tint: '#2c2029' }))
      wall.position.set(0, 2.2, WALL_Z)
      group.add(wall)
      const side = new THREE.Mesh(new THREE.PlaneGeometry(24, 20), brickMaterial({ width: 24, height: 20, tint: '#2c2029' }))
      side.rotation.y = -Math.PI / 2
      side.position.set(tileX(N - 1) + 5.5, 2.2, WALL_Z + 12)
      group.add(side)
      floor = new THREE.Mesh(new THREE.PlaneGeometry(span, 24), concreteMaterial({ width: span, depth: 24 }))
      floor.rotation.x = -Math.PI / 2
      floor.position.set(0, ROOM.row.floor, 12 + WALL_Z)
      group.add(floor)
      await nextFrame()

      const chart = await buildChart(group, ctx.mobile)
      tiles = chart.tiles
      relayoutChart = chart.relayout
      for (let i = 0; i < N; i++) strikers.push(new Striker({ stutters: i % 3 === 1 ? 2 : 1 }))
      await nextFrame()

      // bare fluorescents over the chart on drop rods (no lights of their
      // own: the light budget goes to the tubes)
      fixtures = [0, 1, 2, 3].map(() => {
        const f = fluorescentFixture(1.6, { light: false, color: '#e8eeff' })
        group.add(f.group)
        return f
      })
      const rodG = new THREE.CylinderGeometry(0.008, 0.008, 5, 6)
      rodG.translate(0, 2.5 + 0.07, 0)
      rods = new THREE.InstancedMesh(rodG, steelMaterial(), fixtures.length * 2)
      group.add(rods)

      // lights (fixed count: 3). Two halos sit between the tile and the
      // brick, facing the wall: even and odd tiles alternate, so a light
      // never jumps while it's lit. A cool wash from above rakes the brick.
      halo = [0, 1].map(() => {
        const l = new THREE.RectAreaLight(0xffffff, 0, TILE_W * 0.82, TILE_H * 0.82)
        l.position.set(0, TILE_Y, WALL_Z + 0.13)
        l.lookAt(0, TILE_Y, WALL_Z - 2)
        group.add(l)
        return l
      })
      wash = new THREE.RectAreaLight('#dfe6ff', 0, 7, 0.35)
      wash.position.set(0, 3.0, 1.2)
      wash.lookAt(0, -1.5, WALL_Z - 0.8)
      group.add(wash)
      relayout(ctx.mobile && window.innerHeight > window.innerWidth)

      // ---- DOM
      intro = el('div', 'sv-intro', undefined, stage)
      el('p', 'hud-eyebrow', SECTIONS.services.eyebrow, intro)
      introTitle = rise(el('h2', 'hud-h2', undefined, intro), 'Eleven ways to be <em>heard.</em>')

      card = el('div', 'hud-panel sv-card', undefined, stage)
      bodies = SERVICES.map((s, i) => {
        const b = el('div', 'sv-body', undefined, card)
        const row = el('div', 'sv-row', undefined, b)
        el('p', 'hud-label sv-num', `${s.num} / ${String(N).padStart(2, '0')}`, row)
        el('p', 'hud-label sv-swatch', swatchName(tiles[i].color), row)
        el('h3', 'sv-title', s.title, b)
        el('p', 'hud-body sv-blurb', s.blurb, b)
        const tg = el('ul', 'hud-tags sv-tags', undefined, b)
        for (const t of s.tags) el('li', 'hud-tag', t, tg)
        for (const [k, v] of Object.entries(cssVars(tiles[i].hex))) b.style.setProperty(k, v)
        reveal(b, i === shown ? 1 : 0, 0)
        return b
      })
      paint(shown)
      reveal(card, 0, 0)
      reveal(intro, 0)

      measure()
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => measure()).observe(stage)
      document.fonts?.ready.then(measure, () => {})
    },

    update(local, frame, ctx) {
      const portrait = portraitOf(frame)
      relayout(portrait)
      const calm = ctx.reducedMotion || !!frame.still
      const dt = frame.dt
      now += dt
      const vel = Math.abs(frame.velocity)

      // ---- pacing: q, the story clock's view of local
      const teleport = prevLocal < 0 || Math.abs(local - prevLocal) > 0.12
      prevLocal = local
      const behind = teleport || !Number.isFinite(clock.value) ? 0 : Math.abs(local - clock.value) / SPAN
      if (travelling ? vel < 0.5 && behind < 0.25 : vel > 0.9 || behind > 1.6) travelling = !travelling
      clock.rate = SPAN * (travelling ? clamp(CHASE_K * behind, CHASE_MIN, CHASE_MAX) : READ_RATE)
      const q = clock.update(local, dt)
      const tk = travelling ? 1 : 0
      travK = teleport ? tk : approach(travK, tk, dt / 0.35)
      const f = lerp(track(q), trackLinear(q), travK * travK * (3 - 2 * travK))
      camF = f
      camWide = wideAt(q)
      camQ = q

      // ---- which tube is lit: the one the camera has arrived on. A tube cuts
      // out as the camera leaves it and the next strikes as the camera
      // arrives, so no lit tube (or its halo) ever slides across the frame;
      // at rest the nearest tube lights even between two. At most one
      // strike per LIT_GAP s; none while scanning; none for a moving reader
      // close to the cut (a strike there would be bright-dark-bright with
      // the lights-out and the next scene's strike).
      const atRest = vel < 0.2 && !clock.busy
      const mayStrike = teleport || atRest || local < FIN_LATE
      const near = clamp(Math.round(f), 0, N - 1)
      const arrived = Math.abs(f - Math.round(f)) < 0.08 || atRest
      const want = q < LIT_FROM ? -1 : q > FIN_A ? N - 1 : arrived ? near : -1
      if (travelling || want < 0) {
        if (lit >= 0) {
          lit = -1
          darkAt = now
        }
      } else if (want !== lit && mayStrike && (teleport || (now - litAt >= LIT_GAP && now - darkAt >= 0.2))) {
        lit = want
        litAt = now
      }
      // the finale: struck once, early (FIN_STRIKE), then held into the cut
      if (q <= FIN_STRIKE || travelling) finOn = false
      else if (!finOn && mayStrike) finOn = true

      // ---- tube levels
      let busy = clock.busy || (!travelling && want !== lit && mayStrike)
      // stutters only on arrival (the reader at rest); moving, a strike ramps
      const still = calm || vel > 0.2 || behind > 0.3 || q > FIN_A
      const sweep = ((frame.time * 2.4) % 19) - 4
      let sum = 0
      for (let i = 0; i < N; i++) {
        let tgt: number
        if (q < LIT_FROM) {
          // the chart at rest: unlit coloured glass, a faint shimmer running along it
          const d = i - sweep
          tgt = 0.03 + (calm ? 0 : 0.08 * Math.exp(-d * d * 0.35))
        } else if (travelling) tgt = TRAVEL_LV
        else if (q > FIN_A) tgt = i === lit || (finOn && q > FIN_STRIKE + i * 0.002) ? 1 : DIM
        else tgt = i === lit ? 1 : DIM
        const lv = strikers[i].update(tgt, dt, still)
        levels[i] = lv
        sum += lv
        tiles[i].icon.setLevel(lv)
        tiles[i].num.setLevel(lv)
        if (Math.abs(lv - tgt) > 0.01) busy = true
      }

      // ---- the room takes the lit tubes' colour
      roomColor.setRGB(0, 0, 0)
      let wsum = 0
      let top = 0
      for (let i = 0; i < N; i++) {
        const w = Math.max(0, levels[i] - DIM * 1.2)
        if (w <= 0) continue
        tmpC.set(tiles[i].hex)
        roomColor.r += tmpC.r * w
        roomColor.g += tmpC.g * w
        roomColor.b += tmpC.b * w
        wsum += w
        top = Math.max(top, levels[i])
      }
      if (wsum > 0.001) roomColor.multiplyScalar(1 / wsum).lerp(idle, clamp(1 - wsum * 4))
      else roomColor.copy(idle)
      const wp = ctx.world.params
      wp.glowColor = roomColor
      wp.glow = 0.22 + 0.4 * top
      moteColor.copy(roomColor).lerp(white, 0.45)
      wp.moteColor = moteColor
      wp.motes = 0.45
      wp.fog = 0.024

      // ---- lights
      const fin = smoothstep(FIN_A, FIN_B, q)
      const finGlow = smoothstep(DIM + 0.1, 1, sum / N)
      const b = chartBounds(portrait)
      for (let p = 0; p < 2; p++) {
        // the nearest tile of this parity
        const k = clamp(p + 2 * Math.round((f - p) / 2), p, N - 1 - ((N - 1 - p) % 2))
        const t = tiles[k]
        const on = smoothstep(DIM + 0.1, 1, levels[k])
        // finale: two broad halos behind the chart, warm half and cool half
        const fx = portrait ? 0 : p ? tileX(7.5) : tileX(2.5)
        const fy = portrait ? TILE_Y + (p ? -ROW_H : ROW_H) : TILE_Y
        const hl = halo[p]
        hl.position.x = lerp(t.pos.x, fx, fin)
        hl.position.y = lerp(t.pos.y, fy, fin)
        hl.width = lerp(TILE_W * 0.82, portrait ? b.x1 - b.x0 - 0.6 : 8.5, fin)
        hl.height = lerp(TILE_H * 0.82, portrait ? ROW_H * 1.7 : TILE_H * 0.82, fin)
        tmpC.set(t.hex)
        if (fin > 0) tmpC.lerp(p ? finB : finA, fin)
        hl.color.copy(tmpC)
        hl.intensity = lerp(on * 9, 3.2 * finGlow, fin)
      }
      trackPos(f, portrait, tp)
      wash.position.set(lerp(tp.x, 0, camWide), lerp(tp.y, (b.y0 + b.y1) / 2, camWide) + 2.6, 1.2)
      wash.width = lerp(7, portrait ? 8 : 24, camWide)
      wash.intensity = 6
      for (const fx of fixtures) fx.setLevel(0.9)

      // ---- copy (from q too, so the words and the camera agree)
      reveal(intro, 1 - smoothstep(INTRO_OUT, INTRO_OUT + 0.014, q))
      setRise(introTitle, q > 0.012 && q < INTRO_OUT + 0.008)
      const cardVis = smoothstep(0.148, 0.162, q) * (1 - smoothstep(0.846, 0.858, q))
      const ck = travelling ? 0 : 1
      cardK = teleport || calm ? ck : approach(cardK, ck, dt / (travelling ? 0.2 : 0.3))
      const vis = cardVis * cardK
      // the card always names the tile the camera is on: the panel never
      // hangs empty. A new service swaps in with a quick dip of the copy.
      const cur = clamp(Math.round(f), 0, N - 1)
      if (cur !== shown) {
        if (calm || teleport || vis < 0.02) {
          swap(cur)
          bodyK = 1
        } else {
          bodyK = Math.max(0, bodyK - dt / 0.12)
          if (bodyK <= 0) swap(cur)
        }
      } else bodyK = Math.min(1, bodyK + dt / 0.2)
      reveal(bodies[shown], bodyK, 0)
      reveal(card, vis, 0)

      settling = busy || travK !== tk || cardK !== ck || bodyK < 1 || cur !== shown
    },

    camera(local, frame, out) {
      beatPose(camF, frame, pA, tA)
      widePose(frame, camQ > 0.5, pB, tB)
      const k = camWide * camWide * (3 - 2 * camWide)
      out.position.copy(pA).lerp(pB, k)
      out.target.copy(tA).lerp(tB, k)
      out.fov = FOV
      out.parallax = lerp(0.22, 0.35, k)
    },

    onEnter() {
      // entering is a teleport: the story snaps to wherever the scroll is
      clock.reset()
      prevLocal = -1
    },

    busy: () => settling,
  }
}
