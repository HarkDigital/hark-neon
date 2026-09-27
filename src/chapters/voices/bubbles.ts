import * as THREE from 'three'
import type { Stroke } from '../../kit/type'

/*
 * VOICES geometry: speech-bubble outlines and hand-bent quotation marks as
 * tube centerlines (kit Stroke, XY plane, origin = the bubble body's centre).
 *
 *   bubbleStrokes(spec)   the outline, with its tail spliced into the same
 *                         closed tube (or thought-bubble puffs for a cloud)
 *   commaStrokes(open)    a pair of "6"/"9" commas: “ or ”
 *
 * Every bubble keeps a text-safe rectangle (TEXT_W x TEXT_H) round its
 * centre, flanked by the quotation marks at ±markX: on desktop the DOM quote
 * sits in there, so the words read as the bubble's own.
 */

export type BubbleShape = 'ellipse' | 'rounded' | 'cloud' | 'squircle'

export interface BubbleSpec {
  shape: BubbleShape
  /** half width / half height of the body */
  a: number
  b: number
  /** tail side: -1 lower-left, 1 lower-right */
  side: -1 | 1
}

/** the DOM text box inside every bubble, world units */
export const TEXT_W = 2.6
export const TEXT_H = 1.24

const V2 = THREE.Vector2

/** resample a closed polyline to roughly uniform spacing */
function resample(pts: THREE.Vector2[], step: number): THREE.Vector2[] {
  const n = pts.length
  const seg: number[] = []
  let total = 0
  for (let i = 0; i < n; i++) {
    const l = pts[i].distanceTo(pts[(i + 1) % n])
    seg.push(l)
    total += l
  }
  const count = Math.max(12, Math.round(total / step))
  const out: THREE.Vector2[] = []
  let i = 0
  let acc = 0
  for (let k = 0; k < count; k++) {
    const want = (k / count) * total
    while (acc + seg[i] < want && i < n - 1) acc += seg[i++]
    const t = seg[i] > 0 ? (want - acc) / seg[i] : 0
    out.push(pts[i].clone().lerp(pts[(i + 1) % n], t))
  }
  return out
}

/** the body outline, counter-clockwise, dense */
function body(spec: BubbleSpec): THREE.Vector2[] {
  const { a, b } = spec
  const pts: THREE.Vector2[] = []
  const N = 360
  if (spec.shape === 'ellipse' || spec.shape === 'cloud') {
    for (let i = 0; i < N; i++) {
      const t = (i / N) * Math.PI * 2
      pts.push(new V2(a * Math.cos(t), b * Math.sin(t)))
    }
  } else if (spec.shape === 'squircle') {
    const e = 2 / 3.2
    for (let i = 0; i < N; i++) {
      const t = (i / N) * Math.PI * 2
      const c = Math.cos(t)
      const s = Math.sin(t)
      pts.push(new V2(a * Math.sign(c) * Math.pow(Math.abs(c), e), b * Math.sign(s) * Math.pow(Math.abs(s), e)))
    }
  } else {
    // rounded rectangle
    const r = Math.min(a, b) * 0.46
    const corners: [number, number, number][] = [
      [a - r, b - r, 0],
      [-a + r, b - r, Math.PI / 2],
      [-a + r, -b + r, Math.PI],
      [a - r, -b + r, (3 * Math.PI) / 2],
    ]
    for (const [cx, cy, a0] of corners) {
      for (let i = 0; i <= 24; i++) {
        const t = a0 + (i / 24) * (Math.PI / 2)
        pts.push(new V2(cx + r * Math.cos(t), cy + r * Math.sin(t)))
      }
    }
  }
  let out = resample(pts, 0.03)
  if (spec.shape === 'cloud') {
    // scallops: push each point out along its normal by |sin| of arc length
    const K = 11
    const n = out.length
    out = out.map((p, i) => {
      const prev = out[(i - 1 + n) % n]
      const next = out[(i + 1) % n]
      const tan = next.clone().sub(prev).normalize()
      const nrm = new V2(tan.y, -tan.x)
      const u = i / n
      return p.clone().addScaledVector(nrm, 0.17 * Math.abs(Math.sin(Math.PI * K * u + 0.35)))
    })
  }
  return out
}

/** the point of `pts` closest to direction `ang` from the centre */
function indexAt(pts: THREE.Vector2[], ang: number) {
  let best = 0
  let bd = Infinity
  for (let i = 0; i < pts.length; i++) {
    let d = Math.abs(Math.atan2(pts[i].y, pts[i].x) - ang)
    d = Math.min(d, Math.PI * 2 - d)
    if (d < bd) {
      bd = d
      best = i
    }
  }
  return best
}

const v3 = (p: THREE.Vector2, z = 0) => new THREE.Vector3(p.x, p.y, z)

export interface BubbleGeo {
  strokes: Stroke[]
  /** where the tail points (the speaker) */
  tip: THREE.Vector2
  /** top attachment points for the chains */
  hang: THREE.Vector2[]
  /** half-width at the middle (for the quotation marks) */
  markX: number
  /** lowest point of the outline incl. tail */
  bottom: number
  top: number
}

/**
 * The bubble outline as tube strokes. The tail is spliced into the outline so
 * the whole bubble is one bent tube; a cloud gets two thought puffs instead.
 */
export function bubbleStrokes(spec: BubbleSpec): BubbleGeo {
  const pts = body(spec)
  const s = spec.side
  const tailAng = s < 0 ? (-120 * Math.PI) / 180 : (-60 * Math.PI) / 180
  const strokes: Stroke[] = []
  let tip: THREE.Vector2
  let loop = pts
  if (spec.shape === 'cloud') {
    const base = pts[indexAt(pts, tailAng)]
    const dir = new V2(s * 0.8, -0.8).normalize()
    const c1 = base.clone().addScaledVector(dir, 0.26)
    const c2 = base.clone().addScaledVector(dir, 0.5)
    const circle = (c: THREE.Vector2, r: number): Stroke => {
      const out: THREE.Vector3[] = []
      for (let i = 0; i < 20; i++) {
        const t = Math.PI / 2 + (i / 20) * Math.PI * 2
        out.push(new THREE.Vector3(c.x + r * Math.cos(t), c.y + r * Math.sin(t), 0))
      }
      return { pts: out, closed: true }
    }
    tip = c2.clone().addScaledVector(dir, 0.14)
    // start the loop at the puffs' side so the jumpers behind stay short
    const k = indexAt(pts, tailAng)
    loop = pts.slice(k).concat(pts.slice(0, k))
    strokes.push({ pts: loop.map(p => v3(p)), closed: true })
    strokes.push(circle(c1, 0.13))
    strokes.push(circle(c2, 0.075))
  } else {
    const c = indexAt(pts, tailAng)
    const n = pts.length
    const hw = Math.round(0.2 / 0.03)
    const i0 = (c - hw + n) % n
    const i1 = (c + hw) % n
    const b0 = pts[i0]
    const b1 = pts[i1]
    // the tail: a slightly curved wedge, tip down and outward
    const mid = b0.clone().add(b1).multiplyScalar(0.5)
    tip = new V2(mid.x + s * 0.36, -1.34)
    const bend = s * 0.05
    const t0 = b0.clone().lerp(tip, 0.5).add(new V2(bend, 0.02))
    const t1 = b1.clone().lerp(tip, 0.5).add(new V2(bend, 0.02))
    // walk from the top (the electrodes hide behind the chains) round to the tail and back
    const top = indexAt(pts, Math.PI / 2)
    const out: THREE.Vector2[] = []
    for (let k = 0; k < n; k++) {
      const i = (top + k) % n
      // skip the points inside the tail's base
      const inside = i0 < i1 ? i > i0 && i < i1 : i > i0 || i < i1
      if (inside) continue
      out.push(pts[i])
      if (i === i0) out.push(t0, tip, t1)
    }
    loop = out
    strokes.push({ pts: loop.map(p => v3(p)), closed: true })
  }
  let top = -Infinity
  let bottom = Infinity
  for (const p of loop) {
    top = Math.max(top, p.y)
    bottom = Math.min(bottom, p.y)
  }
  bottom = Math.min(bottom, tip.y)
  // chains hook onto the outline at ±55% of the half width
  const hang = [-1, 1].map(sx => {
    const ang = Math.atan2(spec.b, sx * spec.a * 0.62)
    const p = pts[indexAt(pts, ang)]
    return p.clone()
  })
  const markX = spec.a - (spec.shape === 'cloud' ? 0.42 : spec.shape === 'rounded' ? 0.3 : 0.36)
  return { strokes, tip, hang, markX, bottom, top }
}

/**
 * A pair of hand-bent quotation marks: open = “, close = ”. Each comma is
 * bent as its OUTLINE (round head, tail sweeping off to a point) — an open
 * loop-and-tail reads as the digits 6 and 9. Height ≈ 3.9·r, centred.
 */
export function commaStrokes(open: boolean, r = 0.066): Stroke[] {
  // the closing comma: head round (0,0), tail sweeping down and to the left
  const nine: [number, number][] = [
    [-0.62, -2.9],
    [0.28, -2.42],
    [0.92, -1.66],
    [1.17, -0.78],
    [1.04, 0.2],
    [0.7, 0.73],
    [0, 1.02],
    [-0.7, 0.73],
    [-1.02, 0],
    [-0.74, -0.7],
    [-0.08, -1.04],
    [0.16, -1.62],
    [-0.08, -2.34],
  ]
  const gap = r * 2.75
  const out: Stroke[] = []
  // a small ring inside the head: through the bloom the head reads solid,
  // like a printed quote mark, not an open loop
  const ring: [number, number][] = []
  for (let i = 0; i < 10; i++) {
    const t = (i / 10) * Math.PI * 2
    ring.push([0.05 + 0.42 * Math.cos(t), -0.02 + 0.42 * Math.sin(t)])
  }
  const map = (pts: [number, number][], dx: number) =>
    pts.map(([x, y]) => {
      // centre the glyph on its head+tail box, then turn it over for the “
      const px = x * r
      const py = (y + 0.94) * r
      return new THREE.Vector3(open ? -px + dx : px + dx, open ? -py : py, 0)
    })
  for (const dx of [-gap / 2, gap / 2]) {
    out.push({ pts: map(nine, dx), closed: true })
    out.push({ pts: map(ring, dx), closed: true })
  }
  return out
}
