import type { Transform } from '../core/math/transform.ts'
import type { SceneFan } from './document.ts'

/**
 * A fan mounted on a body (`bodyId`) stores x, y and angle in that body's frame and moves
 * with it (a propeller). Unmounted fans are already in world space. `pose` is the body's
 * live pose; without one a mounted fan has no world placement (body missing).
 */
export function fanInWorld(fan: SceneFan, pose: Transform | null | undefined): SceneFan | null {
  if (!fan.bodyId) return fan
  if (!pose) return null
  const c = Math.cos(pose.angle)
  const s = Math.sin(pose.angle)
  return {
    ...fan,
    x: pose.x + fan.x * c - fan.y * s,
    y: pose.y + fan.x * s + fan.y * c,
    angle: fan.angle + pose.angle,
  }
}

/** World-space fields of a fan edit back into the fan's own frame (body-local if mounted). */
export function fanPatchToLocal(
  fan: SceneFan,
  patch: Partial<SceneFan>,
  pose: Transform | null | undefined,
): Partial<SceneFan> {
  if (!fan.bodyId || !pose) return patch
  const out = { ...patch }
  const c = Math.cos(pose.angle)
  const s = Math.sin(pose.angle)
  if (patch.x !== undefined && patch.y !== undefined) {
    const dx = patch.x - pose.x
    const dy = patch.y - pose.y
    out.x = dx * c + dy * s
    out.y = -dx * s + dy * c
  }
  if (patch.angle !== undefined) out.angle = patch.angle - pose.angle
  return out
}
