import * as THREE from 'three'
import type { Stroke } from '../../kit/type'

/*
 * Hero-only tube shapes (not lettering): the OPEN sign's frame and the amber
 * arrow. Both are closed outlines with rounded corners, built as dense
 * polylines so the tube can be bent with smooth: false (no Catmull-Rom
 * overshoot on the long straight runs).
 */

type P = [number, number]

/** Round every corner of a closed polygon with a quadratic fillet of radius r. */
function fillet(poly: P[], r: number, seg = 6): THREE.Vector3[] {
  const n = poly.length
  const out: THREE.Vector3[] = []
  for (let i = 0; i < n; i++) {
    const p0 = poly[(i - 1 + n) % n]
    const p1 = poly[i]
    const p2 = poly[(i + 1) % n]
    const l0 = Math.hypot(p0[0] - p1[0], p0[1] - p1[1])
    const l2 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1])
    const rr = Math.min(r, l0 * 0.45, l2 * 0.45)
    const a: P = [p1[0] + ((p0[0] - p1[0]) / l0) * rr, p1[1] + ((p0[1] - p1[1]) / l0) * rr]
    const b: P = [p1[0] + ((p2[0] - p1[0]) / l2) * rr, p1[1] + ((p2[1] - p1[1]) / l2) * rr]
    for (let k = 0; k <= seg; k++) {
      const t = k / seg
      const u = 1 - t
      out.push(new THREE.Vector3(u * u * a[0] + 2 * u * t * p1[0] + t * t * b[0], u * u * a[1] + 2 * u * t * p1[1] + t * t * b[1], 0))
    }
  }
  return out
}

/** A rounded rectangle frame (the classic border round an OPEN sign), starting bottom centre. */
export function roundedFrame(w: number, h: number, r: number): Stroke {
  const x = w / 2
  const y = h / 2
  // start at the bottom centre so the electrodes sit out of the way
  const poly: P[] = [
    [0.001, -y],
    [x, -y],
    [x, y],
    [-x, y],
    [-x, -y],
    [-0.001, -y],
  ]
  // fillet only the four real corners (the two bottom-centre points are collinear)
  const pts = fillet(poly, r, 8)
  return { pts: dedupe(pts), closed: true }
}

/**
 * A block arrow outline pointing LEFT (-x), centred on the origin.
 *   len    tip to tail
 *   head   head height; shaft = shaft height; headLen = tip to the head's back
 */
export function arrowOutline(len: number, head: number, shaft: number, headLen: number, r = 0.04): Stroke {
  const L = len / 2
  const poly: P[] = [
    [L, shaft / 2],
    [-L + headLen, shaft / 2],
    [-L + headLen * 0.82, head / 2],
    [-L, 0],
    [-L + headLen * 0.82, -head / 2],
    [-L + headLen, -shaft / 2],
    [L, -shaft / 2],
    // a notched tail (a chevron cut) so it reads as a bent sign, not a UI icon
    [L - shaft * 0.55, 0],
  ]
  return { pts: dedupe(fillet(poly, r, 6)), closed: true }
}

/**
 * An underline swash (the flourish under a script word): a shallow sag from
 * x0 to x1 at height y, flicking up at the right end. Bend it smooth.
 */
export function swash(x0: number, x1: number, y: number, sag = 0.08, flick = 0.22): { pts: THREE.Vector3[] } {
  const w = x1 - x0
  const pts: THREE.Vector3[] = []
  const n = 9
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const x = x0 + w * t
    const yy = y - sag * Math.sin(Math.PI * Math.min(1, t / 0.86)) + flick * Math.pow(Math.max(0, (t - 0.8) / 0.2), 2)
    pts.push(new THREE.Vector3(x, yy, 0))
  }
  return { pts }
}

function dedupe(pts: THREE.Vector3[]) {
  const out: THREE.Vector3[] = []
  for (const p of pts) if (!out.length || out[out.length - 1].distanceToSquared(p) > 1e-10) out.push(p)
  if (out.length > 2 && out[0].distanceToSquared(out[out.length - 1]) < 1e-10) out.pop()
  return out
}

/**
 * A sign's reflection smeared down the sealed concrete: an additive plane
 * lying on the floor from the wall base toward the camera. Its texture is
 * the sign's horizontal light profile (where along x the tube runs, and how
 * much of it), stretched along z with a falloff and a little streakiness —
 * seen at a grazing angle it reads as the long wet-floor streaks of a night
 * photograph. Tiny (64 x 128), built once; drive it with setLevel().
 */
export function floorStreak(
  strokes: Stroke[],
  o: { color: string; width: number; length: number; strength?: number; seed?: number; falloff?: number },
) {
  const W = 64
  const H = 128
  const { width, length, strength = 0.4, seed = 1, falloff = 3.2 } = o
  const bins = new Float32Array(W)
  for (const s of strokes) {
    const n = s.pts.length
    const segs = s.closed ? n : n - 1
    for (let i = 0; i < segs; i++) {
      const a = s.pts[i]
      const b = s.pts[(i + 1) % n]
      const bi = Math.floor((((a.x + b.x) / 2 + width / 2) / width) * W)
      if (bi >= 0 && bi < W) bins[bi] += a.distanceTo(b)
    }
  }
  // soften the profile (three box passes ≈ gaussian)
  let prof = bins
  for (let pass = 0; pass < 3; pass++) {
    const next = new Float32Array(W)
    for (let x = 0; x < W; x++) {
      let acc = 0
      let wsum = 0
      for (let k = -2; k <= 2; k++) {
        const xx = x + k
        if (xx < 0 || xx >= W) continue
        acc += prof[xx]
        wsum++
      }
      next[x] = acc / wsum
    }
    prof = next
  }
  let max = 0
  for (const v of prof) max = Math.max(max, v)
  let s = seed * 9301 + 49297
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  const raw = Array.from({ length: W }, () => rand())
  // gentle, smoothed column variation (no regular striping)
  const colNoise = raw.map((_, x) => 0.86 + 0.14 * ((raw[Math.max(0, x - 1)] + raw[x] + raw[Math.min(W - 1, x + 1)]) / 3))
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  const img = g.createImageData(W, H)
  for (let y = 0; y < H; y++) {
    const t = y / (H - 1) // 0 = the wall end, 1 = toward the camera
    const fall = Math.exp(-t * falloff) * Math.min(1, t / 0.03 + 0.35)
    const rowN = 0.95 + 0.05 * rand()
    for (let x = 0; x < W; x++) {
      // soft side edges so the plane never shows its rectangle
      const e = Math.min(1, x / 12, (W - 1 - x) / 12)
      const edge = e * e * (3 - 2 * e)
      const v = max > 0 ? (prof[x] / max) * colNoise[x] * rowN * fall * edge : 0
      const i = (y * W + x) * 4
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(Math.min(1, v) * 255)
      img.data[i + 3] = 255
    }
  }
  g.putImageData(img, 0, 0)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.NoColorSpace
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    color: new THREE.Color(o.color).multiplyScalar(strength),
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    opacity: 0,
    toneMapped: false,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, length), mat)
  mesh.rotation.x = -Math.PI / 2
  mesh.renderOrder = 1
  mesh.visible = false
  return Object.assign(mesh, {
    setLevel(v: number) {
      mat.opacity = v
      mesh.visible = v > 0.003
    },
  })
}

/** Bounds of a stroke set (xy). */
export function strokeBounds(strokes: Stroke[]) {
  const b = new THREE.Box2()
  for (const s of strokes) for (const p of s.pts) b.expandByPoint(new THREE.Vector2(p.x, p.y))
  return b
}
