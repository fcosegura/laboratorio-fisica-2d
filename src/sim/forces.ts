import { PHYSICS_DT } from '../core/constants.ts'
import type { Vec2 } from '../core/math/vec2.ts'
import type { BodySnapshot, PhysicsShape } from '../physics/ports.ts'
import type { SceneThruster, SceneWind } from '../scene/document.ts'

/** Drag coefficient for every shape (blunt 2D body, between a cylinder and a flat plate). */
export const AIR_DRAG_COEFF = 1.2

/** Thruster force and application point in world space for a body at `pose`. */
export function thrusterWorld(
  t: SceneThruster,
  pose: { x: number; y: number; angle: number },
): { x: number; y: number; fx: number; fy: number } {
  const c = Math.cos(pose.angle)
  const s = Math.sin(pose.angle)
  const dir = t.followsBody ? t.angle + pose.angle : t.angle
  return {
    x: pose.x + t.anchor.x * c - t.anchor.y * s,
    y: pose.y + t.anchor.x * s + t.anchor.y * c,
    fx: t.force * Math.cos(dir),
    fy: t.force * Math.sin(dir),
  }
}

/**
 * Gust factor in [1 − gust, 1 + gust]: three incommensurate sines, so the pattern does not
 * visibly repeat. `phase` is (position · wind direction) / speed: gusts travel with the wind.
 */
export function gustFactor(gust: number, t: number, phase = 0): number {
  if (gust <= 0) return 1
  const u = t - phase
  const g = 0.5 * Math.sin(0.7 * u) + 0.3 * Math.sin(1.9 * u + 1) + 0.2 * Math.sin(4.3 * u + 2)
  return 1 + gust * g
}

/** Mean wind velocity vector, m/s. */
export function windVelocity(wind: SceneWind): Vec2 {
  return { x: wind.speed * Math.cos(wind.direction), y: wind.speed * Math.sin(wind.direction) }
}

/** Wind velocity at a point and time (uniform field modulated by travelling gusts). */
export function windAt(wind: SceneWind, t: number, x: number, y: number): Vec2 {
  if (wind.speed < 1e-9) return { x: 0, y: 0 }
  const { x: wx, y: wy } = windVelocity(wind)
  const k = gustFactor(wind.gust, t, (x * wx + y * wy) / (wind.speed * wind.speed))
  return { x: wx * k, y: wy * k }
}

/**
 * Width of the shape seen by a flow along (dx, dy) (unit vector, world frame): its extent
 * across the flow. 2D frontal "area" per metre of thickness.
 */
export function projectedWidth(shape: PhysicsShape, angle: number, dx: number, dy: number): number {
  // Normal to the flow, in the body frame.
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const nx = -dy * c + dx * s
  const ny = dy * s + dx * c
  const span = (pts: readonly Vec2[], pad = 0) => {
    let lo = Infinity
    let hi = -Infinity
    for (const p of pts) {
      const d = p.x * nx + p.y * ny
      if (d < lo) lo = d
      if (d > hi) hi = d
    }
    return hi - lo + 2 * pad
  }
  switch (shape.kind) {
    case 'circle':
      return 2 * shape.radius
    case 'box':
      return 2 * (shape.hx * Math.abs(nx) + shape.hy * Math.abs(ny))
    case 'capsule':
      return span(
        [
          { x: 0, y: -shape.halfHeight },
          { x: 0, y: shape.halfHeight },
        ],
        shape.radius,
      )
    case 'convex':
    case 'polyline':
      return span(shape.vertices)
    case 'segment':
      return span([shape.a, shape.b])
    case 'compound':
      // Parts carry no offset: the widest one is the frontal width.
      return Math.max(0, ...shape.parts.map((p) => projectedWidth(p, angle, dx, dy)))
  }
}

/**
 * Quadratic air drag F = ½ ρ C_d A |u| u with u = wind − v (velocity of the COM), applied at
 * the COM. Capped so one step never takes more than the relative velocity away: the body
 * tends to the wind speed, it never overshoots it.
 */
export function windForce(
  wind: SceneWind,
  shape: PhysicsShape,
  snap: BodySnapshot,
  t: number,
  dt = PHYSICS_DT,
): Vec2 {
  const w = windAt(wind, t, snap.comX, snap.comY)
  const ux = w.x - snap.vx
  const uy = w.y - snap.vy
  const u = Math.hypot(ux, uy)
  if (u < 1e-6 || !(snap.mass > 0)) return { x: 0, y: 0 }
  const area = projectedWidth(shape, snap.angle, ux / u, uy / u)
  const c = Math.min(0.5 * wind.airDensity * AIR_DRAG_COEFF * area * u, snap.mass / dt)
  return { x: c * ux, y: c * uy }
}
