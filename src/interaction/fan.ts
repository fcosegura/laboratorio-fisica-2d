import type { Vec2 } from '../core/math/vec2.ts'
import { PROPERTY_DESCRIPTORS } from '../scene/properties.ts'
import type { SceneFan } from '../scene/document.ts'

export type FanGrab = 'move' | 'aim'

/** Hit radius of the fan body and of its aim handle, in screen pixels. */
const FAN_HIT_PX = 14

export const DEFAULT_FAN_WIDTH = 1
export const DEFAULT_FAN_SPEED = 10
/** A click without a drag places a fan blowing right with this reach (m). */
export const DEFAULT_FAN_RANGE = 3

/** Tip of the jet: the aim handle. */
export function fanTip(fan: SceneFan): Vec2 {
  return { x: fan.x + Math.cos(fan.angle) * fan.range, y: fan.y + Math.sin(fan.angle) * fan.range }
}

/**
 * Fan under the pointer: the aim handle of the selected fan first, then any fan body (last
 * drawn on top).
 */
export function fanAt(
  fans: readonly SceneFan[],
  p: Vec2,
  pixelsPerMeter: number,
  selectedId: string | null,
): { id: string; grab: FanGrab } | null {
  const r = FAN_HIT_PX / pixelsPerMeter
  const sel = selectedId ? fans.find((f) => f.id === selectedId) : undefined
  if (sel) {
    const tip = fanTip(sel)
    if (Math.hypot(p.x - tip.x, p.y - tip.y) <= r) return { id: sel.id, grab: 'aim' }
  }
  for (let i = fans.length - 1; i >= 0; i--) {
    const f = fans[i]!
    if (Math.hypot(p.x - f.x, p.y - f.y) <= Math.max(r, 0.25)) return { id: f.id, grab: 'move' }
  }
  return null
}

/** Direction and reach from a drag start → end (fan tool and aim handle). */
export function aimFromDrag(from: Vec2, to: Vec2): { angle: number; range: number } {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const { min, max } = PROPERTY_DESCRIPTORS.fanRange
  return {
    angle: Math.atan2(dy, dx),
    range: Math.min(max, Math.max(min, Math.hypot(dx, dy))),
  }
}

/** Fields an in-progress move / aim gesture changes (preview and commit share it). */
export function fanEditPatch(
  fan: SceneFan,
  grab: FanGrab,
  offset: Vec2,
  current: Vec2,
): Partial<SceneFan> {
  if (grab === 'move') return { x: current.x - offset.x, y: current.y - offset.y }
  return aimFromDrag(fan, current)
}
