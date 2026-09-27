import * as THREE from 'three'
import type { Stroke } from '../../kit/type'
import { neonFromStrokes, neonSpill, textStrokes, TUBE, TUBE_CHART, type NeonPart, type TubeColor } from '../../kit/neon'
import { acrylicMaterial, steelMaterial } from '../../kit/shop'
import { nextFrame } from '../../core/yield'
import { ICONS } from './icons'

/*
 * SERVICES · the tube chart itself: eleven black acrylic sample tiles on
 * standoffs along a brick wall, one per service, each with its icon bent in
 * that tube colour, its number bent small in the plain sans, and a printed
 * colour label ("ROSE · 15MM · NE", decorative).
 *
 * Geometry is built once; the chapter drives levels.
 */

/** tile size (world units) and spacing along +x */
export const TILE_W = 1.66
export const TILE_H = 2.2
export const SPACING = 1.95
/** tile centre height */
export const TILE_Y = 0.4
/** the icons are authored ~1 unit tall; bent a touch smaller on the tile */
const ICON_SCALE = 0.9
const ICON_Y = 0.02
/** tube depth in front of the acrylic face */
const TUBE_Z = 0.06
/** the tile number's cap height */
const NUM_SIZE = 0.13
/** the backer stands this far off the wall */
export const STANDOFF = 0.25
const BACKER_D = 0.014
export const WALL_Z = -BACKER_D - STANDOFF

/** the chart's printed colour names (decorative): name, glass bore, gas */
const SWATCH: Record<TubeColor, [string, number, string]> = {
  red: ['Neon red', 15, 'NE'],
  coral: ['Coral', 12, 'NE'],
  amber: ['Amber', 15, 'NE'],
  gold: ['Gold', 12, 'AR'],
  pink: ['Rose', 15, 'NE'],
  magenta: ['Magenta', 12, 'AR'],
  violet: ['UV violet', 12, 'AR'],
  lavender: ['Lavender', 12, 'AR'],
  blue: ['Argon blue', 15, 'AR'],
  turquoise: ['Turquoise', 12, 'AR'],
  white: ['Snow white', 15, 'AR'],
  ice: ['Ice', 12, 'AR'],
}

/** "Rose · 15mm" — the colour's chart name */
export function swatchName(c: TubeColor) {
  const [name, bore] = SWATCH[c]
  return `${name} · ${bore}mm`
}

export const tileX = (i: number) => (i - (TUBE_CHART.length - 1) / 2) * SPACING

/**
 * Two hangs of the same chart. Landscape: one long row along the wall.
 * Portrait: a three-column grid (4 rows, the last two centred), so a phone
 * can hold the whole chart in one shot.
 */
export const GRID_COLS = 3
export const ROW_H = TILE_H + 0.32
const GRID_ROWS = Math.ceil(TUBE_CHART.length / GRID_COLS)
export function tilePos(i: number, portrait: boolean, out: THREE.Vector2) {
  if (!portrait) return out.set(tileX(i), TILE_Y)
  const row = Math.floor(i / GRID_COLS)
  const inRow = Math.min(GRID_COLS, TUBE_CHART.length - row * GRID_COLS)
  const col = i % GRID_COLS
  return out.set((col - (inRow - 1) / 2) * SPACING, TILE_Y + ((GRID_ROWS - 1) / 2 - row) * ROW_H)
}
/** the chart's extent in the current hang */
export function chartBounds(portrait: boolean) {
  if (!portrait) {
    const hw = (tileX(TUBE_CHART.length - 1) - tileX(0) + TILE_W) / 2
    return { x0: -hw, x1: hw, y0: TILE_Y - TILE_H / 2, y1: TILE_Y + TILE_H / 2 }
  }
  const hw = ((GRID_COLS - 1) * SPACING + TILE_W) / 2
  const hh = ((GRID_ROWS - 1) * ROW_H + TILE_H) / 2
  return { x0: -hw, x1: hw, y0: TILE_Y - hh, y1: TILE_Y + hh }
}

export interface Tile {
  index: number
  color: TubeColor
  hex: string
  group: THREE.Group
  icon: NeonPart
  num: NeonPart
  /** current position of the tile's centre (updated by relayout) */
  pos: THREE.Vector2
}

const v3 = (p: [number, number], s: number, y: number, z: number) => new THREE.Vector3(p[0] * s, p[1] * s + y, z)

function iconStrokes(i: number): Stroke[] {
  return ICONS[i].map(s => ({ pts: s.pts.map(p => v3(p, ICON_SCALE, ICON_Y, TUBE_Z)), closed: s.closed }))
}

// ---------------------------------------------------------------- labels

const LBL_W = 512
const LBL_H = 80
const LBL_COLS = 2
const LBL_ROWS = 6
/** printed label size on the tile (world units) */
const LABEL_W = 1.08
const LABEL_H = (LABEL_W * LBL_H) / LBL_W

/** all eleven labels in one small atlas canvas; redraws when the mono face lands */
function labelAtlas() {
  const c = document.createElement('canvas')
  c.width = LBL_W * LBL_COLS
  c.height = 512
  const g = c.getContext('2d')!
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  const draw = () => {
    g.clearRect(0, 0, c.width, c.height)
    TUBE_CHART.forEach((col, i) => {
      const x0 = (i % LBL_COLS) * LBL_W
      const y0 = Math.floor(i / LBL_COLS) * LBL_H
      const [name, bore, gas] = SWATCH[col]
      // colour swatch: a printed dot (kept well under the bloom threshold)
      g.fillStyle = TUBE[col]
      g.globalAlpha = 0.9
      g.beginPath()
      g.arc(x0 + 24, y0 + LBL_H / 2, 13, 0, Math.PI * 2)
      g.fill()
      g.globalAlpha = 1
      g.fillStyle = '#ffffff'
      g.textBaseline = 'middle'
      g.font = '600 30px "Azeret Mono Variable", ui-monospace, monospace'
      const label = `${name.toUpperCase()} · ${bore}MM`
      g.fillText(label, x0 + 50, y0 + LBL_H / 2 + 1)
      const w = g.measureText(label).width
      g.font = '400 24px "Azeret Mono Variable", ui-monospace, monospace'
      g.globalAlpha = 0.62
      g.fillText(`· ${gas}`, x0 + 50 + w + 12, y0 + LBL_H / 2 + 1)
      g.globalAlpha = 1
    })
    tex.needsUpdate = true
  }
  draw()
  const f = document.fonts
  if (f) {
    f.load('600 30px "Azeret Mono Variable"').then(draw, () => {})
    f.ready.then(draw, () => {})
  }
  return tex
}

function labelGeometry(i: number) {
  const g = new THREE.PlaneGeometry(LABEL_W, LABEL_H)
  const u0 = ((i % LBL_COLS) * LBL_W) / (LBL_W * LBL_COLS)
  const u1 = u0 + 1 / LBL_COLS
  const v1 = 1 - (Math.floor(i / LBL_COLS) * LBL_H) / 512
  const v0 = v1 - LBL_H / 512
  const uv = g.attributes.uv as THREE.BufferAttribute
  for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) > 0.5 ? u1 : u0, uv.getY(k) > 0.5 ? v1 : v0)
  return g
}

// ---------------------------------------------------------------- the chart

export async function buildChart(parent: THREE.Group, mobile: boolean) {
  const n = TUBE_CHART.length
  const radial = mobile ? 6 : 8
  const tiles: Tile[] = []

  // backers + standoffs: instanced draws for the whole chart
  const backers = new THREE.InstancedMesh(new THREE.BoxGeometry(TILE_W, TILE_H, BACKER_D), acrylicMaterial(), n)
  const postG = new THREE.CylinderGeometry(0.014, 0.014, STANDOFF, 10)
  postG.rotateX(Math.PI / 2)
  const posts = new THREE.InstancedMesh(postG, steelMaterial(), n * 4)
  const capG = new THREE.CylinderGeometry(0.028, 0.028, 0.012, 16)
  capG.rotateX(Math.PI / 2)
  const caps = new THREE.InstancedMesh(capG, steelMaterial(), n * 4)
  parent.add(backers, posts, caps)
  const m = new THREE.Matrix4()
  const inset = 0.11
  const place = (i: number, x: number, y: number) => {
    backers.setMatrixAt(i, m.makeTranslation(x, y, -BACKER_D / 2))
    let k = 0
    for (const sx of [-1, 1])
      for (const sy of [-1, 1]) {
        const px = x + sx * (TILE_W / 2 - inset)
        const py = y + sy * (TILE_H / 2 - inset)
        posts.setMatrixAt(i * 4 + k, m.makeTranslation(px, py, -BACKER_D - STANDOFF / 2))
        // the polished standoff caps on the face
        caps.setMatrixAt(i * 4 + k, m.makeTranslation(px, py, 0.006))
        k++
      }
  }

  const atlas = labelAtlas()
  const labelMat = new THREE.MeshBasicMaterial({
    map: atlas,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    // printed ink: kept below the bloom threshold
    color: new THREE.Color(0.2, 0.19, 0.2),
  })

  for (let i = 0; i < n; i++) {
    // yield between tiles so the loader keeps painting
    if (i % 3 === 2) await nextFrame()
    const color = TUBE_CHART[i]
    const hex = TUBE[color]
    const white = color === 'white'
    const hdr = white ? 2.0 : 4.2
    const group = new THREE.Group()
    parent.add(group)

    const strokes = iconStrokes(i)
    const icon = neonFromStrokes(strokes, { color, radius: 0.021, hdr, radial, smooth: true })
    group.add(icon.group)

    // the tube's light on the acrylic behind it
    const spill = neonSpill(strokes, { color: hex, width: TILE_W, height: TILE_H, blur: 0.075, strength: white ? 0.06 : 0.3, res: 160 })
    spill.position.z = 0.002
    group.add(spill)
    icon.follow(spill)

    // the number, bent small in the plain sans (top-left of the tile).
    // Not the display face: Osmotron's 5 reads as S and its squared zero as
    // a letter O ("OS", "O1"); EMS Readability's figures read as figures.
    const numStr = String(i + 1).padStart(2, '0')
    const nt = textStrokes(numStr, { font: 'sans', size: NUM_SIZE, align: 'center', tracking: 0.12 })
    const num = neonFromStrokes(nt.strokes, { color, radius: NUM_SIZE / 17, hdr: hdr * 0.85, radial: 6, depth: 0.05 })
    num.group.position.set(-TILE_W / 2 + 0.17 + nt.width / 2, TILE_H / 2 - 0.2 - NUM_SIZE / 2, TUBE_Z * 0.5)
    group.add(num.group)

    const label = new THREE.Mesh(labelGeometry(i), labelMat)
    label.position.set(-TILE_W / 2 + 0.13 + LABEL_W / 2, -TILE_H / 2 + 0.19, 0.003)
    label.renderOrder = 2
    group.add(label)

    tiles.push({ index: i, color, hex, group, icon, num, pos: new THREE.Vector2() })
  }

  let hang: boolean | null = null
  /** hang the chart as a row (landscape) or a grid (portrait); no-op when unchanged */
  const relayout = (portrait: boolean) => {
    if (hang === portrait) return false
    hang = portrait
    for (const t of tiles) {
      tilePos(t.index, portrait, t.pos)
      t.group.position.set(t.pos.x, t.pos.y, 0)
      place(t.index, t.pos.x, t.pos.y)
    }
    backers.instanceMatrix.needsUpdate = true
    posts.instanceMatrix.needsUpdate = true
    caps.instanceMatrix.needsUpdate = true
    backers.computeBoundingSphere()
    posts.computeBoundingSphere()
    caps.computeBoundingSphere()
    return true
  }
  relayout(false)
  return { tiles, relayout }
}
