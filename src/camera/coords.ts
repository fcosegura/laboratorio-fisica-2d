import {
  DEFAULT_PIXELS_PER_METER,
  MAX_PIXELS_PER_METER,
  MIN_PIXELS_PER_METER,
} from '../core/constants.ts'
import type { AABB } from '../core/math/aabb.ts'
import { aabbCenter, aabbHeight, aabbWidth, isFiniteAABB } from '../core/math/aabb.ts'
import type { Vec2 } from '../core/math/vec2.ts'

export type Camera = {
  x: number
  y: number
  pixelsPerMeter: number
}

export function createCamera(x = 0, y = 2, ppm = DEFAULT_PIXELS_PER_METER): Camera {
  return { x, y, pixelsPerMeter: ppm }
}

export function clampPpm(ppm: number): number {
  return Math.min(MAX_PIXELS_PER_METER, Math.max(MIN_PIXELS_PER_METER, ppm))
}

export type ViewSize = { width: number; height: number; dpr: number }

/** World (Y up, meters) → CSS screen pixels (Y down). */
export function worldToScreen(world: Vec2, cam: Camera, view: ViewSize): Vec2 {
  return {
    x: (world.x - cam.x) * cam.pixelsPerMeter + view.width * 0.5,
    y: -(world.y - cam.y) * cam.pixelsPerMeter + view.height * 0.5,
  }
}

/** CSS screen pixels → world meters. */
export function screenToWorld(screen: Vec2, cam: Camera, view: ViewSize): Vec2 {
  return {
    x: (screen.x - view.width * 0.5) / cam.pixelsPerMeter + cam.x,
    y: -(screen.y - view.height * 0.5) / cam.pixelsPerMeter + cam.y,
  }
}

/** Zoom keeping the world point under `screen` fixed. */
export function zoomAt(cam: Camera, screen: Vec2, view: ViewSize, factor: number): Camera {
  const before = screenToWorld(screen, cam, view)
  const pixelsPerMeter = clampPpm(cam.pixelsPerMeter * factor)
  const next = { x: cam.x, y: cam.y, pixelsPerMeter }
  const after = screenToWorld(screen, next, view)
  next.x += before.x - after.x
  next.y += before.y - after.y
  return next
}

export function panCamera(cam: Camera, dxScreen: number, dyScreen: number): Camera {
  return {
    x: cam.x - dxScreen / cam.pixelsPerMeter,
    y: cam.y + dyScreen / cam.pixelsPerMeter,
    pixelsPerMeter: cam.pixelsPerMeter,
  }
}

export function zoomToFit(cam: Camera, box: AABB, view: ViewSize, margin = 1.2): Camera {
  if (!isFiniteAABB(box) || aabbWidth(box) < 1e-6 || aabbHeight(box) < 1e-6) return cam
  const c = aabbCenter(box)
  const ppm = clampPpm(
    Math.min(view.width / (aabbWidth(box) * margin), view.height / (aabbHeight(box) * margin)),
  )
  return { x: c.x, y: c.y, pixelsPerMeter: ppm }
}

export function resetCamera(x = 0, y = 2.5): Camera {
  return createCamera(x, y, DEFAULT_PIXELS_PER_METER)
}
