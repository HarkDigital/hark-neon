import * as THREE from 'three'
import type { Chapter, Frame } from '../../core/types'
import { el, rise, setRise, reveal } from '../../core/dom'
import { SECTIONS, SERVICES } from '../../content'
import { clamp, lerp, smoothstep } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { beat } from '../common'
import { Striker, TUBE } from '../../kit/neon'
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
 *   0.02–0.08  the whole chart, every tube dim glass with a faint shimmer
 *              running along it; "What we do" / Eleven ways to be heard.
 *   0.09–0.93  eleven beats: the camera trucks along the chart; the active
 *              tube strikes on in its colour (neighbours stay dim, so the
 *              chart reads as a spectrum) and colours the room (haze,
 *              motes, a halo on the brick behind the tile); the card
 *              names it
 *   0.93–1.00  pull back: all eleven lit at once, the full spectrum, bright
 *              into the cut
 */

const N = SERVICES.length
const A = 0.09
const B = 0.93
const SPAN = (B - A) / N
/** share of a slot spent trucking between tiles (the rest is a dwell) */
const GLIDE = 0.45
/** neighbours' level: dim coloured glass, never crossing the bloom threshold */
const DIM = 0.1
const FOV = 40
/** minimum seconds between lit-tube changes */
const LIT_GAP = 0.4
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

/** the continuous tile index the camera is on: plateaus at each tile, eased trucks between */
function track(local: number) {
  const u = (local - A) / SPAN - 0.5
  const n = Math.floor(u)
  const t = clamp((u - n - (1 - GLIDE) / 2) / GLIDE)
  return clamp(n + smoother(t), 0, N - 1)
}
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
const wideAt = (local: number) => Math.max(1 - smoothstep(0.08, 0.112, local), smoothstep(0.912, 0.948, local))

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
  let card: HTMLElement, body: HTMLElement, num: HTMLElement, swatch: HTMLElement
  let title: HTMLElement, blurb: HTMLElement, tags: HTMLElement
  let shown = -1
  let settling = false
  /*
   * Which tube is lit, paced by TIME (flash safety, WCAG 2.3.1): the lit
   * tube changes at most every LIT_GAP s, and while the reader is scrolling
   * briskly every tube stays dim glass — the tube strikes when the camera
   * comes to rest on it. A teleport (nav jump, test jump) lights at once.
   */
  let clock = 0
  let lit = -1
  let litAt = -1e9
  let travelling = false
  let jumpAt = -1e9
  let prevLocal = -1
  /** measured on resize: the card's top edge at its tallest, its width; the intro's bottom edge (px) */
  let cardTop = -1
  let cardW = 440
  let introBottom = -1

  const fill = (i: number) => {
    const s = SERVICES[i]
    num.textContent = `${s.num} / ${String(N).padStart(2, '0')}`
    swatch.textContent = swatchName(tiles[i]?.color ?? 'pink')
    title.textContent = s.title
    blurb.textContent = s.blurb
    tags.replaceChildren(...s.tags.map(t => Object.assign(document.createElement('li'), { className: 'hud-tag', textContent: t })))
    const hex = tiles[i]?.hex ?? TUBE.pink
    for (const [k, v] of Object.entries(cssVars(hex))) card.style.setProperty(k, v)
  }

  /** size the card to its tallest service (it never jumps), and note where the copy sits */
  const measure = () => {
    if (!card || !tiles.length) return
    card.style.minHeight = ''
    let max = 0
    for (let i = 0; i < N; i++) {
      fill(i)
      max = Math.max(max, card.offsetHeight)
    }
    fill(Math.max(0, shown))
    card.style.minHeight = `${max}px`
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
      body = el('div', 'sv-body', undefined, card)
      const row = el('div', 'sv-row', undefined, body)
      num = el('p', 'hud-label sv-num', '', row)
      swatch = el('p', 'hud-label sv-swatch', '', row)
      title = el('h3', 'sv-title', '', body)
      blurb = el('p', 'hud-body sv-blurb', '', body)
      tags = el('ul', 'hud-tags sv-tags', undefined, body)
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
      const fast = Math.abs(frame.velocity) > 2.5
      const f = track(local)
      const finale = local > 0.926
      const beating = local >= 0.094 && !finale
      const shimmer = local < 0.094 && !calm

      // ---- which tube is lit (time-paced; see `lit`)
      clock += frame.dt
      const teleport = prevLocal < 0 || Math.abs(local - prevLocal) > 0.12
      prevLocal = local
      if (teleport) jumpAt = clock
      const speed = clock - jumpAt < 1.2 ? 0 : Math.abs(frame.velocity)
      if (travelling ? speed < 0.5 : speed > 0.9) travelling = !travelling
      const want = beating && !travelling ? clamp(Math.floor(f + 0.35), 0, N - 1) : -1
      if (want !== lit && (teleport || clock - litAt >= LIT_GAP)) {
        lit = want
        litAt = clock
      }

      // ---- tube levels
      let busy = lit !== want
      const sweep = ((frame.time * 2.4) % 19) - 4
      for (let i = 0; i < N; i++) {
        let tgt: number
        if (finale) tgt = local > 0.928 + i * 0.0021 ? 1 : DIM
        else if (beating) tgt = i === lit ? 1 : DIM
        else {
          // the chart at rest: unlit coloured glass, a faint shimmer running along it
          const d = i - sweep
          tgt = 0.03 + (shimmer ? 0.08 * Math.exp(-d * d * 0.35) : 0)
        }
        // a fast scroll and the finale's all-at-once light up ramp; never stutter
        const lv = strikers[i].update(tgt, frame.dt, calm || fast || finale)
        levels[i] = lv
        tiles[i].icon.setLevel(lv)
        tiles[i].num.setLevel(lv)
        if (Math.abs(lv - tgt) > 0.01) busy = true
      }
      settling = busy || travelling

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
      const fin = smoothstep(0.926, 0.95, local)
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
        hl.intensity = lerp(on * 9, 3.2, fin)
      }
      const wide = wideAt(local)
      trackPos(f, portrait, tp)
      wash.position.set(lerp(tp.x, 0, wide), lerp(tp.y, (b.y0 + b.y1) / 2, wide) + 2.6, 1.2)
      wash.width = lerp(7, portrait ? 8 : 24, wide)
      wash.intensity = 6
      for (const fx of fixtures) fx.setLevel(0.9)

      // ---- copy
      reveal(intro, 1 - smoothstep(0.084, 0.1, local))
      setRise(introTitle, local > 0.012 && local < 0.094)
      reveal(card, smoothstep(0.1, 0.114, local) * (1 - smoothstep(0.912, 0.924, local)), 0)
      const bt = beat(local, N, A, B)
      if (bt.idx !== shown) {
        shown = bt.idx
        fill(shown)
      }
      // the card's copy dips while the camera trucks: at rest it names the lit tube
      const u = (local - A) / SPAN
      const d = Math.min(u - Math.floor(u), Math.ceil(u) - u)
      reveal(body, smoothstep(0.045, 0.12, d), 0)
    },

    camera(local, frame, out) {
      const f = track(local)
      const wide = wideAt(local)
      beatPose(f, frame, pA, tA)
      widePose(frame, local > 0.5, pB, tB)
      const k = wide * wide * (3 - 2 * wide)
      out.position.copy(pA).lerp(pB, k)
      out.target.copy(tA).lerp(tB, k)
      out.fov = FOV
      out.parallax = lerp(0.22, 0.35, k)
    },

    busy: () => settling,
  }
}
