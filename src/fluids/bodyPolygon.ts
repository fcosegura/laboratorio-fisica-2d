import type { Vec2 } from '../core/math/vec2.ts'
import { boxToPolygon, capsuleToPolygon, circleToPolygon } from '../core/math/polygon.ts'
import type { PhysicsShape } from '../physics/ports.ts'

/** World-space outline of a collider for hydrostatic clipping. Empty if the shape has no area. */
export function shapeToWorldPolygon(
  shape: PhysicsShape,
  x: number,
  y: number,
  angle: number,
): Vec2[] {
  if (shape.kind === 'circle') return circleToPolygon(x, y, shape.radius, 28)
  if (shape.kind === 'box') return boxToPolygon(x, y, shape.hx, shape.hy, angle)
  if (shape.kind === 'capsule') {
    return capsuleToPolygon(x, y, shape.halfHeight, shape.radius, angle, 12)
  }
  if (shape.kind === 'convex') {
    const c = Math.cos(angle)
    const si = Math.sin(angle)
    return shape.vertices.map((p) => ({
      x: x + p.x * c - p.y * si,
      y: y + p.x * si + p.y * c,
    }))
  }
  return []
}

/** One polygon per filled piece (compound parts are flattened). */
export function shapeToWorldPolygons(
  shape: PhysicsShape,
  x: number,
  y: number,
  angle: number,
): Vec2[][] {
  if (shape.kind === 'compound') {
    return shape.parts.flatMap((part) => shapeToWorldPolygons(part, x, y, angle))
  }
  const poly = shapeToWorldPolygon(shape, x, y, angle)
  return poly.length >= 3 ? [poly] : []
}
