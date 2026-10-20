import type { Transform } from '../core/math/transform.ts'
import { transformPoint } from '../core/math/transform.ts'
import type { Vec2 } from '../core/math/vec2.ts'
import type { SceneBody } from '../scene/document.ts'

/**
 * Rotate / scale handles of the single selected body. Pure geometry shared by the renderer
 * (drawing) and the runtime (hit-testing), so both always agree on where a handle is.
 */
export type HandleKind = 'rotate' | 'scale'

export type HandleLayout = {
  bodyId: string
  center: Vec2
  rotate: Vec2
  scale: Vec2
  /** Handle radius in metres (constant on screen). */
  radius: number
}

const HANDLE_PX = 7
const ROTATE_GAP_PX = 26
/** Allowed scale factor per gesture, and the smallest feature a scaled shape may keep. */
export const MIN_SCALE = 0.1
export const MAX_SCALE = 10
const MIN_FEATURE = 0.04

/** Farthest distance of the shape from its local origin. */
export function shapeExtent(shape: SceneBody['shape']): number {
  switch (shape.kind) {
    case 'circle':
      return shape.radius
    case 'box':
      return Math.hypot(shape.hx, shape.hy)
    case 'capsule':
      return shape.halfHeight + shape.radius
    case 'convex':
    case 'polyline':
      return shape.vertices.reduce((m, p) => Math.max(m, Math.hypot(p.x, p.y)), 0)
    case 'segment':
      return Math.max(Math.hypot(shape.a.x, shape.a.y), Math.hypot(shape.b.x, shape.b.y))
    case 'compound':
      return shape.parts.reduce((m, part) => Math.max(m, shapeExtent(part)), 0)
  }
}

export function handleLayout(
  bodyId: string,
  shape: SceneBody['shape'],
  pose: Transform,
  pixelsPerMeter: number,
): HandleLayout {
  const extent = Math.max(shapeExtent(shape), 0.05)
  const gap = ROTATE_GAP_PX / pixelsPerMeter
  const d = extent * Math.SQRT1_2
  return {
    bodyId,
    center: { x: pose.x, y: pose.y },
    rotate: transformPoint({ x: 0, y: 0 }, { x: 0, y: extent + gap }, pose),
    scale: transformPoint({ x: 0, y: 0 }, { x: d, y: -d }, pose),
    radius: HANDLE_PX / pixelsPerMeter,
  }
}

/** Generous hit area (touch): 1.8× the drawn radius. */
export function handleAt(layout: HandleLayout, p: Vec2): HandleKind | null {
  const r = layout.radius * 1.8
  if (Math.hypot(p.x - layout.rotate.x, p.y - layout.rotate.y) <= r) return 'rotate'
  if (Math.hypot(p.x - layout.scale.x, p.y - layout.scale.y) <= r) return 'scale'
  return null
}

/** Vertex handle radius in metres for a fluid-region polygon (constant on screen). */
export function vertexHandleRadius(pixelsPerMeter: number): number {
  return HANDLE_PX / pixelsPerMeter
}

/** Index of the polygon vertex under `p`, or -1. */
export function vertexAt(polygon: readonly Vec2[], p: Vec2, pixelsPerMeter: number): number {
  const r = vertexHandleRadius(pixelsPerMeter) * 1.8
  let best = -1
  let bestD = r
  for (let i = 0; i < polygon.length; i++) {
    const d = Math.hypot(polygon[i]!.x - p.x, polygon[i]!.y - p.y)
    if (d <= bestD) {
      best = i
      bestD = d
    }
  }
  return best
}

/** Polygon with vertex `index` moved to `to`. */
export function moveVertex(polygon: readonly Vec2[], index: number, to: Vec2): Vec2[] {
  return polygon.map((p, i) => (i === index ? { x: to.x, y: to.y } : { x: p.x, y: p.y }))
}

/** Pointer angle around the body origin. */
export function pointerAngle(center: Vec2, p: Vec2): number {
  return Math.atan2(p.y - center.y, p.x - center.x)
}

/** Uniform scale factor from the pointer distance, clamped so no feature collapses. */
export function scaleFactor(
  shape: SceneBody['shape'],
  center: Vec2,
  start: Vec2,
  current: Vec2,
): number {
  const d0 = Math.hypot(start.x - center.x, start.y - center.y)
  if (d0 < 1e-6) return 1
  const raw = Math.hypot(current.x - center.x, current.y - center.y) / d0
  const smallest = smallestFeature(shape)
  const lo = Math.max(MIN_SCALE, smallest > 0 ? MIN_FEATURE / smallest : MIN_SCALE)
  return Math.min(MAX_SCALE, Math.max(lo, raw))
}

function smallestFeature(shape: SceneBody['shape']): number {
  switch (shape.kind) {
    case 'circle':
      return shape.radius
    case 'box':
      return Math.min(shape.hx, shape.hy)
    case 'capsule':
      return shape.radius
    default:
      return shapeExtent(shape)
  }
}

export function scaleShape(shape: SceneBody['shape'], s: number): SceneBody['shape'] {
  const sv = (p: Vec2) => ({ x: p.x * s, y: p.y * s })
  switch (shape.kind) {
    case 'circle':
      return { kind: 'circle', radius: shape.radius * s }
    case 'box':
      return { kind: 'box', hx: shape.hx * s, hy: shape.hy * s }
    case 'capsule':
      return { kind: 'capsule', halfHeight: shape.halfHeight * s, radius: shape.radius * s }
    case 'convex':
      return { kind: 'convex', vertices: shape.vertices.map(sv) }
    case 'polyline':
      return { kind: 'polyline', vertices: shape.vertices.map(sv) }
    case 'segment':
      return { kind: 'segment', a: sv(shape.a), b: sv(shape.b) }
    case 'compound':
      return { kind: 'compound', parts: shape.parts.map((part) => scaleShape(part, s)) }
  }
}
