export type Vec2 = { x: number; y: number }

export function vec2(x = 0, y = 0): Vec2 {
  return { x, y }
}

export function set(out: Vec2, x: number, y: number): Vec2 {
  out.x = x
  out.y = y
  return out
}

export function copy(out: Vec2, v: Vec2): Vec2 {
  out.x = v.x
  out.y = v.y
  return out
}

export function clone(v: Vec2): Vec2 {
  return { x: v.x, y: v.y }
}

export function add(out: Vec2, a: Vec2, b: Vec2): Vec2 {
  out.x = a.x + b.x
  out.y = a.y + b.y
  return out
}

export function sub(out: Vec2, a: Vec2, b: Vec2): Vec2 {
  out.x = a.x - b.x
  out.y = a.y - b.y
  return out
}

export function scale(out: Vec2, a: Vec2, s: number): Vec2 {
  out.x = a.x * s
  out.y = a.y * s
  return out
}

export function madd(out: Vec2, a: Vec2, b: Vec2, s: number): Vec2 {
  out.x = a.x + b.x * s
  out.y = a.y + b.y * s
  return out
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y
}

export function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x
}

export function len2(a: Vec2): number {
  return a.x * a.x + a.y * a.y
}

export function len(a: Vec2): number {
  return Math.hypot(a.x, a.y)
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function dist2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy
}

export function normalize(out: Vec2, a: Vec2): Vec2 {
  const l = Math.hypot(a.x, a.y)
  if (l < 1e-12) {
    out.x = 0
    out.y = 0
    return out
  }
  out.x = a.x / l
  out.y = a.y / l
  return out
}

export function rotate(out: Vec2, a: Vec2, angle: number): Vec2 {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const x = a.x * c - a.y * s
  const y = a.x * s + a.y * c
  out.x = x
  out.y = y
  return out
}

export function perp(out: Vec2, a: Vec2): Vec2 {
  const x = -a.y
  const y = a.x
  out.x = x
  out.y = y
  return out
}

export function lerp(out: Vec2, a: Vec2, b: Vec2, t: number): Vec2 {
  out.x = a.x + (b.x - a.x) * t
  out.y = a.y + (b.y - a.y) * t
  return out
}

export function eq(a: Vec2, b: Vec2, eps = 1e-9): boolean {
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps
}

/** Shortest distance from point `p` to segment `ab`. */
export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t))
}

