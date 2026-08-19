import type { Vec2 } from './vec2.ts'
import { rotate, vec2 } from './vec2.ts'

export type Transform = {
  x: number
  y: number
  angle: number
}

export function transform(x = 0, y = 0, angle = 0): Transform {
  return { x, y, angle }
}

export function identityTransform(): Transform {
  return { x: 0, y: 0, angle: 0 }
}

export function cloneTransform(t: Transform): Transform {
  return { x: t.x, y: t.y, angle: t.angle }
}

export function lerpTransform(out: Transform, a: Transform, b: Transform, alpha: number): Transform {
  out.x = a.x + (b.x - a.x) * alpha
  out.y = a.y + (b.y - a.y) * alpha
  let d = b.angle - a.angle
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  out.angle = a.angle + d * alpha
  return out
}

/** Local point → world. */
export function transformPoint(out: Vec2, local: Vec2, t: Transform): Vec2 {
  rotate(out, local, t.angle)
  out.x += t.x
  out.y += t.y
  return out
}

/** World point → local. */
export function inverseTransformPoint(out: Vec2, world: Vec2, t: Transform): Vec2 {
  out.x = world.x - t.x
  out.y = world.y - t.y
  rotate(out, out, -t.angle)
  return out
}

export function originOf(t: Transform): Vec2 {
  return vec2(t.x, t.y)
}
