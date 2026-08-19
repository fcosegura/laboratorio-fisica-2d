import type { Vec2 } from '../core/math/vec2.ts'
import { transformPoint, type Transform } from '../core/math/transform.ts'

/** 1 m of drag vector → this many m/s of Δv (impulse mode), then × mass. */
export const IMPULSE_VELOCITY_PER_METER = 4

/** 1 m of drag vector → this many m/s² (sustained force), then × mass. */
export const FORCE_ACCEL_PER_METER = 12

const MIN_MASS = 0.01

export function dragToImpulse(mass: number, dx: number, dy: number): Vec2 {
  const k = Math.max(mass, MIN_MASS) * IMPULSE_VELOCITY_PER_METER
  return { x: k * dx, y: k * dy }
}

export function dragToForce(mass: number, dx: number, dy: number): Vec2 {
  const k = Math.max(mass, MIN_MASS) * FORCE_ACCEL_PER_METER
  return { x: k * dx, y: k * dy }
}

export function forceAnchorWorld(local: Vec2, pose: Transform): Vec2 {
  return transformPoint({ x: 0, y: 0 }, local, pose)
}
