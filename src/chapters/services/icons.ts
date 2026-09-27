/*
 * SERVICES · the eleven tube icons, bent the way a sign shop bends glass.
 *
 * Plain 2D centerlines (no three.js here, so the shapes can be proofed from
 * node): each icon is ~1 unit tall, centered on the origin, y up. Corners are
 * filleted (glass can't take a sharp bend), junctions never overlap (a real
 * tube can't branch: separate runs stop a hair short and the black jumpers
 * behind the glass join them), and the strokes are ordered so the jumpers
 * stay short.
 *
 *   01 </>   02 browser   03 cart   04 magnifier   05 bolt   06 sparkle
 *   07 drone 08 wrench    09 lock   10 access      11 W in a circle
 */

export type P2 = [number, number]
export interface IconStroke {
  pts: P2[]
  closed?: boolean
}

const TAU = Math.PI * 2

/** a circle as a closed run (n points) */
export function circle(cx: number, cy: number, r: number, n = 0, start = Math.PI / 2): IconStroke {
  const k = n || Math.max(14, Math.round(r * 90))
  const pts: P2[] = []
  for (let i = 0; i < k; i++) {
    const a = start + (i / k) * TAU
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r])
  }
  return { pts, closed: true }
}

/** an open arc from a0 to a1 (radians, CCW when a1 > a0) */
export function arc(cx: number, cy: number, r: number, a0: number, a1: number, n = 0): P2[] {
  const k = n || Math.max(6, Math.round(Math.abs(a1 - a0) * r * 40))
  const pts: P2[] = []
  for (let i = 0; i <= k; i++) {
    const a = a0 + ((a1 - a0) * i) / k
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r])
  }
  return pts
}

/**
 * Fillet every corner of a polyline with a small arc (radius r, clamped to
 * a third of the shorter neighbouring segment) — the bend radius of the glass.
 */
export function fillet(pts: P2[], r: number, closed = false, seg = 5): P2[] {
  const n = pts.length
  if (n < 3) return pts.slice()
  const out: P2[] = []
  for (let i = 0; i < n; i++) {
    const p = pts[i]
    const hasPrev = closed || i > 0
    const hasNext = closed || i < n - 1
    if (!hasPrev || !hasNext) {
      out.push(p)
      continue
    }
    const a = pts[(i - 1 + n) % n]
    const b = pts[(i + 1) % n]
    const ax = a[0] - p[0]
    const ay = a[1] - p[1]
    const bx = b[0] - p[0]
    const by = b[1] - p[1]
    const la = Math.hypot(ax, ay)
    const lb = Math.hypot(bx, by)
    const ux = ax / la
    const uy = ay / la
    const vx = bx / lb
    const vy = by / lb
    const cos = Math.max(-1, Math.min(1, ux * vx + uy * vy))
    const theta = Math.acos(cos) // interior angle
    if (theta > Math.PI - 0.05) {
      out.push(p)
      continue
    }
    // distance from the corner to the tangent points
    let d = r / Math.tan(theta / 2)
    d = Math.min(d, la / 3, lb / 3)
    const rr = d * Math.tan(theta / 2)
    const t1: P2 = [p[0] + ux * d, p[1] + uy * d]
    const t2: P2 = [p[0] + vx * d, p[1] + vy * d]
    // arc centre along the bisector
    const bxs = ux + vx
    const bys = uy + vy
    const bl = Math.hypot(bxs, bys) || 1
    const cd = Math.hypot(d, rr)
    const c: P2 = [p[0] + (bxs / bl) * cd, p[1] + (bys / bl) * cd]
    const a0 = Math.atan2(t1[1] - c[1], t1[0] - c[0])
    const a1 = Math.atan2(t2[1] - c[1], t2[0] - c[0])
    let da = a1 - a0
    while (da > Math.PI) da -= TAU
    while (da < -Math.PI) da += TAU
    for (let k = 0; k <= seg; k++) {
      const aa = a0 + (da * k) / seg
      out.push([c[0] + Math.cos(aa) * rr, c[1] + Math.sin(aa) * rr])
    }
  }
  return out
}

/** a rounded rectangle as a closed run */
export function rrect(cx: number, cy: number, w: number, h: number, r: number): IconStroke {
  const x0 = cx - w / 2
  const x1 = cx + w / 2
  const y0 = cy - h / 2
  const y1 = cy + h / 2
  // start mid-top so the electrode/jumper lands on a straight
  return { pts: fillet([[cx, y1], [x1, y1], [x1, y0], [x0, y0], [x0, y1]], r, true, 6), closed: true }
}

/** quadratic Bézier samples (excluding the start point) */
function quad(a: P2, c: P2, b: P2, n = 10): P2[] {
  const out: P2[] = []
  for (let i = 1; i <= n; i++) {
    const t = i / n
    const u = 1 - t
    out.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]])
  }
  return out
}

/** a four-point sparkle (concave sides) centred on (cx, cy) */
function sparkle(cx: number, cy: number, h: number, w: number, pinch = 0.16): IconStroke {
  const T: P2 = [cx, cy + h]
  const R: P2 = [cx + w, cy]
  const B: P2 = [cx, cy - h]
  const L: P2 = [cx - w, cy]
  const c = (a: P2, b: P2): P2 => [cx + (a[0] + b[0] - 2 * cx) * pinch, cy + (a[1] + b[1] - 2 * cy) * pinch]
  const pts: P2[] = [T, ...quad(T, c(T, R), R), ...quad(R, c(R, B), B), ...quad(B, c(B, L), L), ...quad(L, c(L, T), T).slice(0, -1)]
  return { pts: fillet(pts, 0.035, true, 4), closed: true }
}

const rot = (p: P2, a: number): P2 => [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a)]

function wrench(): IconStroke[] {
  // built along +u (the handle's axis), then turned 45° so the jaw points up-right
  const hc = 0.36 // head centre on the axis
  const R = 0.25 // head radius
  const jaw = 0.085 // half-width of the jaw slot
  const hw = 0.085 // half-width of the handle
  const end = -0.62 // handle end (rounded)
  const aJaw = Math.asin(jaw / R)
  const aHandle = Math.PI - Math.asin(hw / R)
  const pts: P2[] = []
  // head: from the jaw's upper lip, CCW round to the handle's top edge
  pts.push(...arc(hc, 0, R, aJaw, aHandle, 18))
  // handle top edge → rounded end → bottom edge
  pts.push(...arc(end, 0, hw, Math.PI / 2, (3 * Math.PI) / 2, 8))
  // head again: from the handle's bottom edge round to the jaw's lower lip
  pts.push(...arc(hc, 0, R, TAU - aHandle, TAU - aJaw, 18))
  // the slot
  const depth = hc + 0.02
  const slot = fillet(
    [
      [hc + R * Math.cos(aJaw), -jaw],
      [depth, -jaw],
      [depth, jaw],
      [hc + R * Math.cos(aJaw), jaw],
    ],
    0.03,
    false,
    4,
  )
  pts.push(...slot.slice(1, -1))
  const a = Math.PI / 4
  return [{ pts: pts.map(p => rot([p[0] - 0.02, p[1]], a)), closed: true }]
}

/** The icons, in SERVICES order. */
export const ICONS: IconStroke[][] = [
  // 01 Software Development — </>
  [
    { pts: fillet([[-0.3, 0.36], [-0.64, 0], [-0.3, -0.36]], 0.05) },
    { pts: [[0.15, 0.5], [-0.15, -0.5]] },
    { pts: fillet([[0.3, 0.36], [0.64, 0], [0.3, -0.36]], 0.05) },
  ],
  // 02 Web Design — a browser window
  [
    rrect(0, 0, 1.34, 1.0, 0.1),
    { pts: [[-0.58, 0.24], [0.58, 0.24]] },
    circle(-0.5, 0.37, 0.045, 12),
    circle(-0.35, 0.37, 0.045, 12),
    circle(-0.2, 0.37, 0.045, 12),
    { pts: [[-0.46, 0.0], [0.2, 0.0]] },
    { pts: [[-0.46, -0.2], [0.02, -0.2]] },
  ],
  // 03 Ecommerce — a shopping cart
  [
    {
      pts: fillet(
        [
          [-0.7, 0.42],
          [-0.5, 0.42],
          [-0.31, -0.16],
          [0.44, -0.16],
          [0.6, 0.26],
          [-0.36, 0.26],
        ],
        0.05,
      ),
    },
    circle(-0.19, -0.36, 0.075),
    circle(0.35, -0.36, 0.075),
  ],
  // 04 SEO / GEO — a magnifier
  [
    { pts: arc(-0.1, 0.1, 0.2, 2.0, 2.9, 8) },
    circle(-0.1, 0.1, 0.35, 0, -Math.PI / 4),
    { pts: [[0.19, -0.19], [0.5, -0.5]] },
  ],
  // 05 Page Speed — a lightning bolt
  [
    {
      pts: fillet(
        [
          [0.2, 0.52],
          [-0.36, -0.05],
          [-0.02, -0.05],
          [-0.2, -0.52],
          [0.36, 0.07],
          [0.02, 0.07],
        ],
        0.035,
        true,
        4,
      ),
      closed: true,
    },
  ],
  // 06 AI Consulting — a four-point sparkle (and a small one)
  [sparkle(-0.1, -0.06, 0.46, 0.36), sparkle(0.42, 0.34, 0.17, 0.13)],
  // 07 Aerial Photography & Video — a quadcopter from above
  [
    circle(-0.4, 0.4, 0.16),
    { pts: [[-0.287, 0.287], [-0.11, 0.11]] },
    { pts: fillet([[-0.11, 0.11], [0.11, 0.11], [0.11, -0.11], [-0.11, -0.11]], 0.035, true, 4), closed: true },
    { pts: [[0.11, 0.11], [0.287, 0.287]] },
    circle(0.4, 0.4, 0.16),
    circle(0.4, -0.4, 0.16),
    { pts: [[0.287, -0.287], [0.11, -0.11]] },
    { pts: [[-0.11, -0.11], [-0.287, -0.287]] },
    circle(-0.4, -0.4, 0.16),
  ],
  // 08 Hack Remediation — a wrench
  wrench(),
  // 09 Website & Data Security — a padlock
  [
    { pts: [[-0.25, 0.14], ...arc(0, 0.24, 0.25, Math.PI, 0, 16), [0.25, 0.14]] },
    rrect(0, -0.2, 0.8, 0.6, 0.08),
    circle(0, -0.14, 0.065),
    { pts: [[0, -0.25], [0, -0.36]] },
  ],
  // 10 ADA Accessibility — the figure in a circle
  [
    circle(0, 0, 0.5, 0, Math.PI / 2),
    circle(0, 0.27, 0.07),
    { pts: [[-0.3, 0.13], [0.3, 0.13]] },
    { pts: fillet([[-0.19, -0.36], [0, -0.06], [0, 0.07]], 0.03) },
    { pts: [[0.03, -0.1], [0.19, -0.36]] },
  ],
  // 11 WordPress — a W in a circle
  [
    circle(0, 0, 0.5, 0, Math.PI / 2),
    { pts: fillet([[-0.34, 0.21], [-0.17, -0.3], [0, 0.13], [0.17, -0.3], [0.34, 0.21]], 0.035) },
  ],
]
