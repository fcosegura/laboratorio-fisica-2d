import { inverseTransformPoint, type Transform } from '../core/math/transform.ts'
import { pointInPolygon } from '../core/math/polygon.ts'
import type { Vec2 } from '../core/math/vec2.ts'
import type { PhysicsShape } from '../physics/ports.ts'
import type { SceneBody } from './document.ts'

export type BodyPose = Pick<Transform, 'x' | 'y' | 'angle'> & { id: string }

const SEGMENT_HIT = 0.12

export function pickBody(
  bodies: readonly SceneBody[],
  x: number,
  y: number,
  poses?: readonly BodyPose[],
  predicate?: (body: SceneBody) => boolean,
): string | null {
  const world = { x, y }
  for (let i = bodies.length - 1; i >= 0; i--) {
    const body = bodies[i]!
    if (predicate && !predicate(body)) continue
    const snap = poses?.find((p) => p.id === body.id)
    const pose: Transform = snap ?? body
    const local = inverseTransformPoint({ x: 0, y: 0 }, world, pose)
    if (shapeContains(body.shape, local)) return body.id
  }
  return null
}

export function shapeContains(shape: PhysicsShape, local: Vec2): boolean {
  switch (shape.kind) {
    case 'circle':
      return local.x * local.x + local.y * local.y <= shape.radius * shape.radius
    case 'box':
      return Math.abs(local.x) <= shape.hx && Math.abs(local.y) <= shape.hy
    case 'capsule': {
      const y = Math.max(-shape.halfHeight, Math.min(shape.halfHeight, local.y))
      const dx = local.x
      const dy = local.y - y
      return dx * dx + dy * dy <= shape.radius * shape.radius
    }
    case 'convex':
      return pointInPolygon(local, shape.vertices)
    case 'compound':
      return shape.parts.some((part) => shapeContains(part, local))
    case 'segment':
      return distToSegment(local, shape.a, shape.b) <= SEGMENT_HIT
    case 'polyline': {
      for (let i = 1; i < shape.vertices.length; i++) {
        if (distToSegment(local, shape.vertices[i - 1]!, shape.vertices[i]!) <= SEGMENT_HIT) return true
      }
      return false
    }
    default:
      return false
  }
}

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t))
}
