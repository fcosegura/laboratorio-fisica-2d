import type { Vec2 } from '../core/math/vec2.ts'
import {
  boxToPolygon,
  capsuleToPolygon,
  circleToPolygon,
  polygonArea,
} from '../core/math/polygon.ts'
import type { PhysicsShape } from '../physics/ports.ts'

/**
 * Scale a polygon about (cx, cy) so its area equals `exact`. An inscribed n-gon loses area
 * (−0.84 % at n = 28), which would shift the float/sink threshold below ρ_fluid.
 */
function scaleToArea(poly: Vec2[], cx: number, cy: number, exact: number): Vec2[] {
  const a = polygonArea(poly)
  if (!(a > 0) || !(exact > 0)) return poly
  const s = Math.sqrt(exact / a)
  return poly.map((p) => ({ x: cx + (p.x - cx) * s, y: cy + (p.y - cy) * s }))
}

/** World-space outline of a collider for hydrostatic clipping. Empty if the shape has no area. */
export function shapeToWorldPolygon(
  shape: PhysicsShape,
  x: number,
  y: number,
  angle: number,
): Vec2[] {
  if (shape.kind === 'circle') {
    const r = shape.radius
    return scaleToArea(circleToPolygon(x, y, r, 28), x, y, Math.PI * r * r)
  }
  if (shape.kind === 'box') return boxToPolygon(x, y, shape.hx, shape.hy, angle)
  if (shape.kind === 'capsule') {
    const { halfHeight: hh, radius: r } = shape
    const poly = capsuleToPolygon(x, y, hh, r, angle, 12)
    return scaleToArea(poly, x, y, Math.PI * r * r + 4 * r * hh)
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
