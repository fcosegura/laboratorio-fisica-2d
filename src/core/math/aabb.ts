import type { Vec2 } from './vec2.ts'
import type { Transform } from './transform.ts'

export type AABB = {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function aabb(minX = 0, minY = 0, maxX = 0, maxY = 0): AABB {
  return { minX, minY, maxX, maxY }
}

export function emptyAABB(): AABB {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
}

export function includePoint(box: AABB, p: Vec2): void {
  if (p.x < box.minX) box.minX = p.x
  if (p.y < box.minY) box.minY = p.y
  if (p.x > box.maxX) box.maxX = p.x
  if (p.y > box.maxY) box.maxY = p.y
}

export function includeAABB(box: AABB, other: AABB): void {
  if (other.minX < box.minX) box.minX = other.minX
  if (other.minY < box.minY) box.minY = other.minY
  if (other.maxX > box.maxX) box.maxX = other.maxX
  if (other.maxY > box.maxY) box.maxY = other.maxY
}

export function aabbWidth(box: AABB): number {
  return box.maxX - box.minX
}

export function aabbHeight(box: AABB): number {
  return box.maxY - box.minY
}

export function aabbCenter(box: AABB): Vec2 {
  return { x: (box.minX + box.maxX) * 0.5, y: (box.minY + box.maxY) * 0.5 }
}

export function aabbContains(box: AABB, p: Vec2): boolean {
  return p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY
}

export function aabbFromPoints(points: readonly Vec2[]): AABB {
  const box = emptyAABB()
  for (const p of points) includePoint(box, p)
  return box
}

export function aabbFromCircle(cx: number, cy: number, r: number): AABB {
  return { minX: cx - r, minY: cy - r, maxX: cx + r, maxY: cy + r }
}

export function aabbFromBox(t: Transform, hx: number, hy: number): AABB {
  const c = Math.cos(t.angle)
  const s = Math.sin(t.angle)
  const corners = [
    { x: -hx, y: -hy },
    { x: hx, y: -hy },
    { x: hx, y: hy },
    { x: -hx, y: hy },
  ]
  const box = emptyAABB()
  for (const p of corners) {
    includePoint(box, { x: t.x + p.x * c - p.y * s, y: t.y + p.x * s + p.y * c })
  }
  return box
}

export function expandAABB(box: AABB, margin: number): AABB {
  return {
    minX: box.minX - margin,
    minY: box.minY - margin,
    maxX: box.maxX + margin,
    maxY: box.maxY + margin,
  }
}

export function isFiniteAABB(box: AABB): boolean {
  return Number.isFinite(box.minX) && Number.isFinite(box.maxX)
}
