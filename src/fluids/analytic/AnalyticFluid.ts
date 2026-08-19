import type { Vec2 } from '../../core/math/vec2.ts'
import {
  boxToPolygon,
  circleToPolygon,
  clipHalfPlane,
  clipPolygon,
  polygonArea,
  polygonCentroid,
} from '../../core/math/polygon.ts'
import type { SceneBody, SceneFluidRegion } from '../../scene/document.ts'
import { getFluid } from '../../materials/catalog.ts'
import type { PhysicsWorld } from '../../physics/ports.ts'
import type { BodySnapshot } from '../../physics/ports.ts'

export type FluidSample = {
  regionId: string
  surfaceY: number
  submergedArea: number
  surfaceWidth: number
}

export type BuoyancyDebug = {
  bodyId: string
  area: number
  cx: number
  cy: number
  fx: number
  fy: number
}

function bodyPolygon(body: SceneBody, snap: BodySnapshot): Vec2[] {
  const s = body.shape
  if (s.kind === 'circle') return circleToPolygon(snap.x, snap.y, s.radius, 28)
  if (s.kind === 'box') return boxToPolygon(snap.x, snap.y, s.hx, s.hy, snap.angle)
  if (s.kind === 'convex') {
    const c = Math.cos(snap.angle)
    const si = Math.sin(snap.angle)
    return s.vertices.map((p) => ({
      x: snap.x + p.x * c - p.y * si,
      y: snap.y + p.x * si + p.y * c,
    }))
  }
  if (s.kind === 'capsule') {
    return circleToPolygon(snap.x, snap.y, Math.max(s.halfHeight, s.radius), 24)
  }
  return []
}

function surfaceWidthAt(poly: Vec2[], y: number): number {
  const xs: number[] = []
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % n]!
    if ((a.y - y) * (b.y - y) <= 0 && Math.abs(b.y - a.y) > 1e-9) {
      const t = (y - a.y) / (b.y - a.y)
      xs.push(a.x + (b.x - a.x) * t)
    }
  }
  if (xs.length < 2) return 0
  xs.sort((p, q) => p - q)
  return xs[xs.length - 1]! - xs[0]!
}

export class AnalyticFluidSolver {
  readonly samples: FluidSample[] = []
  readonly debug: BuoyancyDebug[] = []

  step(world: PhysicsWorld, regions: SceneFluidRegion[], bodies: SceneBody[], snaps: BodySnapshot[]): void {
    this.samples.length = 0
    this.debug.length = 0
    const g = world.gravity
    const gmag = Math.hypot(g.x, g.y)
    if (gmag < 1e-8) return
    const gx = g.x / gmag
    const gy = g.y / gmag

    const snapMap = new Map(snaps.map((s) => [s.id, s]))

    for (const region of regions) {
      const mat = getFluid(region.materialId)
      let displaced = 0
      const contributions: { body: SceneBody; snap: BodySnapshot; originalPoly: Vec2[]; area: number; c: Vec2 }[] = []

      for (const body of bodies) {
        if (body.type !== 'dynamic') continue
        const snap = snapMap.get(body.id)
        if (!snap) continue
        const poly = bodyPolygon(body, snap)
        if (poly.length < 3) continue
        let clipped = clipPolygon(poly, region.polygon)
        clipped = clipHalfPlane(clipped, 0, 1, region.restSurfaceY)
        const area = polygonArea(clipped)
        if (area < 1e-8) continue
        displaced += area
        contributions.push({ body, snap, originalPoly: poly, area, c: polygonCentroid(clipped) })
      }

      const width = Math.max(0.05, surfaceWidthAt(region.polygon, region.restSurfaceY))
      const surfaceY = region.restSurfaceY + displaced / width
      this.samples.push({
        regionId: region.id,
        surfaceY,
        submergedArea: displaced,
        surfaceWidth: width,
      })

      for (const item of contributions) {
        // Reclip with the raised surface for a slightly better hydrostatic estimate.
        let clipped = clipPolygon(item.originalPoly, region.polygon)
        clipped = clipHalfPlane(clipped, 0, 1, surfaceY)
        const area = polygonArea(clipped)
        if (area < 1e-8) continue
        const c = polygonCentroid(clipped)
        const F = mat.density * area * gmag
        const fx = -gx * F
        const fy = -gy * F
        // Quadratic drag in the fluid.
        const v = { x: item.snap.vx, y: item.snap.vy }
        const speed = Math.hypot(v.x, v.y)
        const charLen = Math.sqrt(area)
        const drag = 0.5 * mat.density * 1.0 * charLen * speed
        const dfx = speed > 1e-6 ? -drag * v.x : 0
        const dfy = speed > 1e-6 ? -drag * v.y : 0
        const torqueDamp = -item.snap.omega * mat.density * area * 0.15
        world.applyForce(item.body.id, fx + dfx, fy + dfy, c)
        world.applyTorque(item.body.id, torqueDamp)
        this.debug.push({ bodyId: item.body.id, area, cx: c.x, cy: c.y, fx: fx + dfx, fy: fy + dfy })
      }
    }
  }
}
