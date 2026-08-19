import type { Vec2 } from './vec2.ts'
import { cross, vec2 } from './vec2.ts'

const EPS = 1e-10

export function signedArea(poly: readonly Vec2[]): number {
  let a = 0
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const p = poly[i]!
    const q = poly[(i + 1) % n]!
    a += p.x * q.y - q.x * p.y
  }
  return a * 0.5
}

export function polygonArea(poly: readonly Vec2[]): number {
  return Math.abs(signedArea(poly))
}

export function isCCW(poly: readonly Vec2[]): boolean {
  return signedArea(poly) > 0
}

export function ensureCCW(poly: readonly Vec2[]): Vec2[] {
  const copy = poly.map((p) => vec2(p.x, p.y))
  if (signedArea(copy) < 0) copy.reverse()
  return copy
}

export function polygonCentroid(poly: readonly Vec2[]): Vec2 {
  const n = poly.length
  if (n === 0) return vec2()
  if (n === 1) return vec2(poly[0]!.x, poly[0]!.y)
  let a = 0
  let cx = 0
  let cy = 0
  for (let i = 0; i < n; i++) {
    const p = poly[i]!
    const q = poly[(i + 1) % n]!
    const cross = p.x * q.y - q.x * p.y
    a += cross
    cx += (p.x + q.x) * cross
    cy += (p.y + q.y) * cross
  }
  if (Math.abs(a) < EPS) {
    let sx = 0
    let sy = 0
    for (const p of poly) {
      sx += p.x
      sy += p.y
    }
    return vec2(sx / n, sy / n)
  }
  a *= 0.5
  return vec2(cx / (6 * a), cy / (6 * a))
}

export function isConvex(poly: readonly Vec2[]): boolean {
  const n = poly.length
  if (n < 3) return false
  let sign = 0
  for (let i = 0; i < n; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % n]!
    const c = poly[(i + 2) % n]!
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    if (Math.abs(cr) < EPS) continue
    const s = cr > 0 ? 1 : -1
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}

export function removeDuplicateVertices(poly: readonly Vec2[], eps = 1e-8): Vec2[] {
  const out: Vec2[] = []
  for (const p of poly) {
    const prev = out[out.length - 1]
    if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > eps) {
      out.push(vec2(p.x, p.y))
    }
  }
  if (out.length > 1) {
    const first = out[0]!
    const last = out[out.length - 1]!
    if (Math.hypot(first.x - last.x, first.y - last.y) <= eps) out.pop()
  }
  return out
}

/**
 * Keep the side nx*x + ny*y <= d (inside the half-plane).
 */
export function clipHalfPlane(poly: readonly Vec2[], nx: number, ny: number, d: number): Vec2[] {
  const n = poly.length
  if (n === 0) return []
  const out: Vec2[] = []
  const inside = (p: Vec2) => nx * p.x + ny * p.y <= d + EPS
  for (let i = 0; i < n; i++) {
    const cur = poly[i]!
    const prev = poly[(i + n - 1) % n]!
    const curIn = inside(cur)
    const prevIn = inside(prev)
    if (curIn) {
      if (!prevIn) out.push(intersect(prev, cur, nx, ny, d))
      out.push(vec2(cur.x, cur.y))
    } else if (prevIn) {
      out.push(intersect(prev, cur, nx, ny, d))
    }
  }
  return out
}

function intersect(a: Vec2, b: Vec2, nx: number, ny: number, d: number): Vec2 {
  const da = nx * a.x + ny * a.y - d
  const db = nx * b.x + ny * b.y - d
  const t = da / (da - db)
  return vec2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
}

/** Clip subject against a convex CCW clipper using Sutherland–Hodgman. */
export function clipPolygon(subject: readonly Vec2[], clipper: readonly Vec2[]): Vec2[] {
  let output = subject.map((p) => vec2(p.x, p.y))
  const m = clipper.length
  if (m === 0) return []
  for (let i = 0; i < m; i++) {
    const a = clipper[i]!
    const b = clipper[(i + 1) % m]!
    const edge = { x: b.x - a.x, y: b.y - a.y }
    // Outward normal of a CCW clipper; clipHalfPlane keeps nx*x + ny*y <= d.
    const nx = edge.y
    const ny = -edge.x
    const d = nx * a.x + ny * a.y
    output = clipHalfPlane(output, nx, ny, d)
    if (output.length === 0) return []
  }
  return output
}

/** Stadium (capsule along local Y): two caps + rectangle, then rotated. */
export function capsuleToPolygon(
  cx: number,
  cy: number,
  halfHeight: number,
  radius: number,
  angle = 0,
  capSegments = 12,
): Vec2[] {
  const pts: Vec2[] = []
  for (let i = 0; i <= capSegments; i++) {
    const t = Math.PI - (i / capSegments) * Math.PI
    pts.push(vec2(Math.cos(t) * radius, halfHeight + Math.sin(t) * radius))
  }
  for (let i = 0; i <= capSegments; i++) {
    const t = -(i / capSegments) * Math.PI
    pts.push(vec2(Math.cos(t) * radius, -halfHeight + Math.sin(t) * radius))
  }
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return pts.map((p) => vec2(cx + p.x * c - p.y * s, cy + p.x * s + p.y * c))
}

export function circleToPolygon(cx: number, cy: number, r: number, segments = 24): Vec2[] {
  const pts: Vec2[] = []
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2
    pts.push(vec2(cx + Math.cos(t) * r, cy + Math.sin(t) * r))
  }
  return pts
}

export function boxToPolygon(
  cx: number,
  cy: number,
  hx: number,
  hy: number,
  angle: number,
): Vec2[] {
  const local = [vec2(-hx, -hy), vec2(hx, -hy), vec2(hx, hy), vec2(-hx, hy)]
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return local.map((p) => vec2(cx + p.x * c - p.y * s, cy + p.x * s + p.y * c))
}

export function pointInPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false
  const n = poly.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = poly[i]!
    const b = poly[j]!
    const intersect =
      a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y + 0.0) + a.x
    if (intersect) inside = !inside
  }
  return inside
}

export function closestPointOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / (abx * abx + aby * aby || 1)),
  )
  return vec2(a.x + abx * t, a.y + aby * t)
}

export function distanceToPolygon(p: Vec2, poly: readonly Vec2[]): number {
  let min = Infinity
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % n]!
    const q = closestPointOnSegment(p, a, b)
    const d = Math.hypot(p.x - q.x, p.y - q.y)
    if (d < min) min = d
  }
  return pointInPolygon(p, poly) ? -min : min
}

export { cross }
