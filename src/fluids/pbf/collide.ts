import { closestPointOnPolygon } from '../../core/math/polygon.ts'
import { aabbFromShape, expandAABB } from '../../core/math/aabb.ts'
import type { BodyId } from '../../core/ids.ts'
import type { PhysicsShape, PhysicsWorld } from '../../physics/ports.ts'

export type PushOutHit = { x: number; y: number; cx: number; cy: number }

export type BodyImpulse = { x: number; y: number; jx: number; jy: number }

/**
 * If the disc (x, y, radius) overlaps `shape`, return the pushed-out center and
 * a contact point on the solid. Handles box, circle, capsule, convex, compound,
 * segment and polyline. `fromX`/`fromY` help boxes and thin walls pick the entry
 * face so they do not eject water to the far side.
 */
export function pushOutOfShape(
  x: number,
  y: number,
  radius: number,
  shape: PhysicsShape,
  ox: number,
  oy: number,
  ang: number,
  fromX?: number,
  fromY?: number,
): PushOutHit | null {
  if (shape.kind === 'compound') {
    let wx = x
    let wy = y
    let best: PushOutHit | null = null
    for (const part of shape.parts) {
      const hit = pushOutOfShape(wx, wy, radius, part, ox, oy, ang, fromX, fromY)
      if (!hit) continue
      wx = hit.x
      wy = hit.y
      best = hit
    }
    return best
  }

  const c = Math.cos(ang)
  const s = Math.sin(ang)
  const lx = (x - ox) * c + (y - oy) * s
  const ly = -(x - ox) * s + (y - oy) * c
  const flx = fromX === undefined || fromY === undefined ? lx : (fromX - ox) * c + (fromY - oy) * s
  const fly = fromX === undefined || fromY === undefined ? ly : -(fromX - ox) * s + (fromY - oy) * c

  if (shape.kind === 'circle') {
    const r = shape.radius + radius
    const d = Math.hypot(lx, ly)
    if (d >= r) return null
    if (d < 1e-12) {
      return { x: ox - s * r, y: oy + c * r, cx: ox, cy: oy }
    }
    const nlx = (lx / d) * r
    const nly = (ly / d) * r
    return {
      x: ox + nlx * c - nly * s,
      y: oy + nlx * s + nly * c,
      cx: ox,
      cy: oy,
    }
  }

  if (shape.kind === 'box') {
    const hx = shape.hx
    const hy = shape.hy
    const ehx = hx + radius
    const ehy = hy + radius

    const outside = Math.abs(lx) >= ehx || Math.abs(ly) >= ehy
    if (outside) {
      const qx = Math.max(-hx, Math.min(hx, lx))
      const qy = Math.max(-hy, Math.min(hy, ly))
      const dx = lx - qx
      const dy = ly - qy
      const d = Math.hypot(dx, dy)
      if (d >= radius || d < 1e-12) return null
      const nx = dx / d
      const ny = dy / d
      const nlx = qx + nx * radius
      const nly = qy + ny * radius
      return {
        x: ox + nlx * c - nly * s,
        y: oy + nlx * s + nly * c,
        cx: ox + qx * c - qy * s,
        cy: oy + qx * s + qy * c,
      }
    }

    // Inside expanded box. Prefer the face the particle came from so thin sticks
    // do not eject overlapping water to the far side of the container.
    let nlx = lx
    let nly = ly
    const fromLeftRight = Math.abs(flx) >= ehx
    const fromTopBottom = Math.abs(fly) >= ehy
    if (fromLeftRight && (!fromTopBottom || Math.abs(flx) >= Math.abs(fly))) {
      nlx = (flx >= 0 ? 1 : -1) * ehx
    } else if (fromTopBottom) {
      nly = (fly >= 0 ? 1 : -1) * ehy
    } else if (hx <= hy) {
      const sx = Math.abs(flx) > 1e-8 ? Math.sign(flx) : lx >= 0 ? 1 : -1
      nlx = sx * ehx
    } else {
      const sy = Math.abs(fly) > 1e-8 ? Math.sign(fly) : ly >= 0 ? 1 : -1
      nly = sy * ehy
    }
    const cx = Math.max(-hx, Math.min(hx, lx))
    const cy = Math.max(-hy, Math.min(hy, ly))
    return {
      x: ox + nlx * c - nly * s,
      y: oy + nlx * s + nly * c,
      cx: ox + cx * c - cy * s,
      cy: oy + cx * s + cy * c,
    }
  }

  if (shape.kind === 'capsule') {
    const hh = shape.halfHeight
    const r = shape.radius + radius
    const clamped = Math.max(-hh, Math.min(hh, ly))
    const dx = lx
    const dy = ly - clamped
    const d = Math.hypot(dx, dy)
    if (d >= r) return null
    if (d < 1e-12) {
      return { x: ox - s * r, y: oy + c * r, cx: ox, cy: oy }
    }
    const nlx = (dx / d) * r
    const nly = clamped + (dy / d) * r
    return {
      x: ox + nlx * c - nly * s,
      y: oy + nlx * s + nly * c,
      cx: ox,
      cy: oy,
    }
  }

  if (shape.kind === 'convex') {
    if (shape.vertices.length < 3) return null
    const hit = closestPointOnPolygon({ x: lx, y: ly }, shape.vertices)
    if (!hit || hit.signedDistance >= radius) return null
    const nlx = hit.point.x + hit.nx * radius
    const nly = hit.point.y + hit.ny * radius
    return {
      x: ox + nlx * c - nly * s,
      y: oy + nlx * s + nly * c,
      cx: ox + hit.point.x * c - hit.point.y * s,
      cy: oy + hit.point.x * s + hit.point.y * c,
    }
  }

  if (shape.kind === 'segment') {
    return pushOutOfChain(lx, ly, [shape.a, shape.b], radius, flx, fly, ox, oy, c, s)
  }

  if (shape.kind === 'polyline') {
    return pushOutOfChain(lx, ly, shape.vertices, radius, flx, fly, ox, oy, c, s)
  }

  return null
}

/** Closest point on an open vertex chain, then push the disc out to `radius`. */
function pushOutOfChain(
  lx: number,
  ly: number,
  verts: readonly { x: number; y: number }[],
  radius: number,
  flx: number,
  fly: number,
  ox: number,
  oy: number,
  c: number,
  s: number,
): PushOutHit | null {
  const n = verts.length
  if (n < 2) return null
  let bestD2 = Infinity
  let qx = 0
  let qy = 0
  let tax = 1
  let tay = 0
  for (let i = 0; i < n - 1; i++) {
    const a = verts[i]!
    const b = verts[i + 1]!
    const abx = b.x - a.x
    const aby = b.y - a.y
    const ab2 = abx * abx + aby * aby || 1
    const t = Math.max(0, Math.min(1, ((lx - a.x) * abx + (ly - a.y) * aby) / ab2))
    const px = a.x + abx * t
    const py = a.y + aby * t
    const dx = lx - px
    const dy = ly - py
    const d2 = dx * dx + dy * dy
    if (d2 >= bestD2) continue
    bestD2 = d2
    qx = px
    qy = py
    tax = abx
    tay = aby
  }
  const d = Math.sqrt(bestD2)
  if (d >= radius) return null

  let nx: number
  let ny: number
  const fdx = flx - qx
  const fdy = fly - qy
  const fd2 = fdx * fdx + fdy * fdy
  if (d < 1e-12) {
    if (fd2 > 1e-16) {
      const fd = Math.sqrt(fd2)
      nx = fdx / fd
      ny = fdy / fd
    } else {
      const el = Math.hypot(tax, tay) || 1
      nx = -tay / el
      ny = tax / el
    }
  } else if (fd2 > 1e-16 && (lx - qx) * fdx + (ly - qy) * fdy < 0) {
    // Tunneled through a thin wall: push back to the side the particle came from.
    const fd = Math.sqrt(fd2)
    nx = fdx / fd
    ny = fdy / fd
  } else {
    nx = (lx - qx) / d
    ny = (ly - qy) / d
  }

  const nlx = qx + nx * radius
  const nly = qy + ny * radius
  return {
    x: ox + nlx * c - nly * s,
    y: oy + nlx * s + nly * c,
    cx: ox + qx * c - qy * s,
    cy: oy + qx * s + qy * c,
  }
}

export function accumulateImpulse(
  map: Map<BodyId, BodyImpulse>,
  id: BodyId,
  x: number,
  y: number,
  jx: number,
  jy: number,
): void {
  const prev = map.get(id)
  if (!prev) {
    map.set(id, { x, y, jx, jy })
    return
  }
  prev.jx += jx
  prev.jy += jy
  prev.x = (prev.x + x) * 0.5
  prev.y = (prev.y + y) * 0.5
}

export type CachedCollider = {
  shape: PhysicsShape
  ox: number
  oy: number
  ang: number
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export type CachedSolid = {
  id: BodyId
  colliders: CachedCollider[]
}

/** Snapshot non-sensor colliders with AABBs expanded by `radius`. */
export function cacheSolids(world: PhysicsWorld, radius: number): CachedSolid[] {
  const out: CachedSolid[] = []
  world.forEachBody((body) => {
    const colliders: CachedCollider[] = []
    for (const col of world.getColliders(body.id)) {
      if (col.isSensor) continue
      const ox = body.x + (col.offset?.x ?? 0)
      const oy = body.y + (col.offset?.y ?? 0)
      const ang = body.angle + (col.angle ?? 0)
      const box = expandAABB(aabbFromShape(col.shape, { x: ox, y: oy, angle: ang }), radius)
      colliders.push({
        shape: col.shape,
        ox,
        oy,
        ang,
        minX: box.minX,
        minY: box.minY,
        maxX: box.maxX,
        maxY: box.maxY,
      })
    }
    if (colliders.length) out.push({ id: body.id, colliders })
  })
  return out
}

/** Push particle `i` out of cached non-sensor colliders (AABB skip, then `pushOutOfShape`). */
export function collideSolidCached(
  px: Float64Array,
  py: Float64Array,
  i: number,
  radius: number,
  solids: readonly CachedSolid[],
  bodyImpulse: Map<BodyId, BodyImpulse>,
  fromX: number,
  fromY: number,
): void {
  let x = px[i]!
  let y = py[i]!

  for (const solid of solids) {
    for (const col of solid.colliders) {
      if (x < col.minX || x > col.maxX || y < col.minY || y > col.maxY) continue
      const hit = pushOutOfShape(x, y, radius, col.shape, col.ox, col.oy, col.ang, fromX, fromY)
      if (!hit) continue
      const jx = x - hit.x
      const jy = y - hit.y
      x = hit.x
      y = hit.y
      accumulateImpulse(bodyImpulse, solid.id, hit.cx, hit.cy, jx, jy)
    }
  }

  px[i] = x
  py[i] = y
}
