import { PHYSICS_DT } from '../core/constants.ts'
import { polygonArea } from '../core/math/polygon.ts'
import type { Vec2 } from '../core/math/vec2.ts'
import type { BodySnapshot, PhysicsShape } from '../physics/ports.ts'
import type { SceneFan, SceneThruster, SceneWind } from '../scene/document.ts'

/** Drag coefficient for every shape (blunt 2D body, between a cylinder and a flat plate). */
export const AIR_DRAG_COEFF = 1.2

/** Plummer softening (m): keeps the pull finite when two bodies touch or overlap. */
export const GRAVITY_SOFTENING = 0.25

/** Area of a shape (m², 1 m thick); zero for lines. */
export function shapeArea(shape: PhysicsShape): number {
  switch (shape.kind) {
    case 'circle':
      return Math.PI * shape.radius * shape.radius
    case 'box':
      return 4 * shape.hx * shape.hy
    case 'capsule':
      return 4 * shape.radius * shape.halfHeight + Math.PI * shape.radius * shape.radius
    case 'convex':
      return Math.abs(polygonArea(shape.vertices))
    case 'compound':
      return shape.parts.reduce((a, p) => a + shapeArea(p), 0)
    case 'polyline':
    case 'segment':
      return 0
  }
}

/**
 * Newtonian pull on `a` from `b`, softened: F = G·ma·mb·r / (r² + ε²)^{3/2} (Plummer), so
 * it is exact far away and bounded at contact.
 */
export function gravityPull(
  G: number,
  ma: number,
  ax: number,
  ay: number,
  mb: number,
  bx: number,
  by: number,
): Vec2 {
  const dx = bx - ax
  const dy = by - ay
  const d2 = dx * dx + dy * dy + GRAVITY_SOFTENING * GRAVITY_SOFTENING
  const k = (G * ma * mb) / (d2 * Math.sqrt(d2))
  return { x: k * dx, y: k * dy }
}

/** Burning at sim time t: after `start`, and for `duration` s when one is set. */
export function thrusterActive(t: SceneThruster, time: number): boolean {
  const start = t.start ?? 0
  if (time < start) return false
  return !t.duration || time < start + t.duration
}

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

/**
 * Rate (1/s) at which a jet brings water to its speed: a propeller, not air on water. 6/s
 * takes the water in the jet core to ~90 % of the jet speed in 0.4 s.
 */
export const FAN_WATER_RATE = 6

/** Fraction of the jet half-width with full speed; the rest tapers (cosine) to zero. */
const FAN_CORE = 0.7

/** Pulse factor in [0, 1]: 0 → 1 → 0 once per period (smooth start). Steady when period = 0. */
export function fanPulse(fan: SceneFan, t: number): number {
  return fan.period > 0 ? 0.5 * (1 - Math.cos((2 * Math.PI * t) / fan.period)) : 1
}

/**
 * Jet speed profile at a point given in the fan frame (`s` along the axis, `n` across):
 * full in the core, cosine taper to the edges, and 1 − (s/range)² along the reach.
 * 0 outside the jet rectangle.
 */
export function fanProfile(fan: SceneFan, s: number, n: number): number {
  if (s < 0 || s > fan.range) return 0
  const half = fan.width / 2
  const a = Math.abs(n)
  if (a >= half) return 0
  const core = half * FAN_CORE
  const across = a <= core ? 1 : 0.5 * (1 + Math.cos((Math.PI * (a - core)) / (half - core)))
  const r = s / fan.range
  return across * (1 - r * r)
}

/** World point → fan frame (s along the blow direction, n across). */
export function toFanFrame(fan: SceneFan, x: number, y: number): { s: number; n: number } {
  const c = Math.cos(fan.angle)
  const sn = Math.sin(fan.angle)
  const dx = x - fan.x
  const dy = y - fan.y
  return { s: dx * c + dy * sn, n: -dx * sn + dy * c }
}

/**
 * Air jet on a body: drag ½ ρ C_d A |u| u against the jet velocity, where A is only the part
 * of the body's width (across the jet) that lies inside the jet. Speed is read at the COM's
 * reach and at the centre of that overlap. Same `c ≤ m/dt` cap as the wind.
 */
export function fanForce(
  fan: SceneFan,
  shape: PhysicsShape,
  snap: BodySnapshot,
  t: number,
  airDensity: number,
  dt = PHYSICS_DT,
): Vec2 {
  const speed = fan.speed * fanPulse(fan, t)
  if (speed < 1e-6 || !(snap.mass > 0)) return { x: 0, y: 0 }
  const jx = Math.cos(fan.angle)
  const jy = Math.sin(fan.angle)
  const { s, n } = toFanFrame(fan, snap.comX, snap.comY)
  // Extent of the body along the axis (seen by a flow across it) and across it.
  const along = projectedWidth(shape, snap.angle, -jy, jx)
  if (s + along / 2 < 0 || s - along / 2 > fan.range) return { x: 0, y: 0 }
  const across = projectedWidth(shape, snap.angle, jx, jy)
  const lo = Math.max(n - across / 2, -fan.width / 2)
  const hi = Math.min(n + across / 2, fan.width / 2)
  if (hi <= lo) return { x: 0, y: 0 }
  const k = fanProfile(fan, Math.min(Math.max(s, 0), fan.range * 0.999), (lo + hi) / 2)
  const ux = speed * k * jx - snap.vx
  const uy = speed * k * jy - snap.vy
  const u = Math.hypot(ux, uy)
  if (u < 1e-6) return { x: 0, y: 0 }
  const c = Math.min(0.5 * airDensity * AIR_DRAG_COEFF * (hi - lo) * u, snap.mass / dt)
  return { x: c * ux, y: c * uy }
}

/**
 * Velocity change of a fluid particle at (x, y) moving at (vx, vy), written to `out`: each
 * jet relaxes the velocity component along its axis towards speed · profile at `rate` (1/s),
 * one-sided (it only accelerates; it never brakes faster water nor touches the cross
 * component, so the waves it makes are not damped). Returns false outside every jet.
 */
export function fanParticlePush(
  fans: readonly SceneFan[],
  t: number,
  dt: number,
  rate: number,
  x: number,
  y: number,
  vx: number,
  vy: number,
  out: Vec2,
): boolean {
  out.x = 0
  out.y = 0
  let hit = false
  const k = 1 - Math.exp(-rate * dt)
  for (const fan of fans) {
    const { s, n } = toFanFrame(fan, x, y)
    const target = fan.speed * fanPulse(fan, t) * fanProfile(fan, s, n)
    if (target <= 0) continue
    const jx = Math.cos(fan.angle)
    const jy = Math.sin(fan.angle)
    const vj = vx * jx + vy * jy
    if (vj >= target) continue
    const dv = (target - vj) * k
    out.x += dv * jx
    out.y += dv * jy
    hit = true
  }
  return hit
}
