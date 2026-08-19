import type { Vec2 } from '../../core/math/vec2.ts'
import {
  boxToPolygon,
  capsuleToPolygon,
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
  clipNx: number
  clipNy: number
  clipD: number
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
    return capsuleToPolygon(snap.x, snap.y, s.halfHeight, s.radius, snap.angle, 12)
  }
  return []
}

/** Span of the polygon along the plane nx x + ny y = d, measured on the tangent. */
export function planeSpan(poly: Vec2[], nx: number, ny: number, d: number): number {
  const pts: number[] = []
  const n = poly.length
  const tx = -ny
  const ty = nx
  for (let i = 0; i < n; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % n]!
    const da = nx * a.x + ny * a.y - d
    const db = nx * b.x + ny * b.y - d
    if (da * db <= 0 && Math.abs(da - db) > 1e-9) {
      const t = da / (da - db)
      const x = a.x + (b.x - a.x) * t
      const y = a.y + (b.y - a.y) * t
      pts.push(x * tx + y * ty)
    }
  }
  if (pts.length < 2) return 0
  let min = pts[0]!
  let max = pts[0]!
  for (const s of pts) {
    if (s < min) min = s
    if (s > max) max = s
  }
  return max - min
}

export class AnalyticFluidSolver {
  readonly samples: FluidSample[] = []
  readonly debug: BuoyancyDebug[] = []

  step(
    world: PhysicsWorld,
    regions: SceneFluidRegion[],
    bodies: SceneBody[],
    snaps: BodySnapshot[],
  ): void {
    this.samples.length = 0
    this.debug.length = 0
    const g = world.gravity
    const gmag = Math.hypot(g.x, g.y)
    if (gmag < 1e-8) return
    const gx = g.x / gmag
    const gy = g.y / gmag
    const nx = -gx
    const ny = -gy

    const snapMap = new Map(snaps.map((s) => [s.id, s]))

    for (const region of regions) {
      const mat = getFluid(region.materialId)
      const dRest = ny * region.restSurfaceY
      let displaced = 0
      const contributions: { body: SceneBody; snap: BodySnapshot; originalPoly: Vec2[] }[] = []

      for (const body of bodies) {
        if (body.type !== 'dynamic') continue
        const snap = snapMap.get(body.id)
        if (!snap) continue
        const poly = bodyPolygon(body, snap)
        if (poly.length < 3) continue
        let clipped = clipPolygon(poly, region.polygon)
        clipped = clipHalfPlane(clipped, nx, ny, dRest)
        const area = polygonArea(clipped)
        if (area < 1e-8) continue
        displaced += area
        contributions.push({ body, snap, originalPoly: poly })
      }

      const width = Math.max(0.05, planeSpan(region.polygon, nx, ny, dRest))
      const clipD = dRest + displaced / width
      const surfaceY = ny !== 0 ? clipD / ny : region.restSurfaceY
      this.samples.push({
        regionId: region.id,
        surfaceY,
        clipNx: nx,
        clipNy: ny,
        clipD,
        submergedArea: displaced,
        surfaceWidth: width,
      })

      for (const item of contributions) {
        let clipped = clipPolygon(item.originalPoly, region.polygon)
        clipped = clipHalfPlane(clipped, nx, ny, clipD)
        const area = polygonArea(clipped)
        if (area < 1e-8) continue
        const c = polygonCentroid(clipped)
        const F = mat.density * area * gmag
        const fx = -gx * F
        const fy = -gy * F
        const v = { x: item.snap.vx, y: item.snap.vy }
        const speed = Math.hypot(v.x, v.y)
        const charLen = Math.sqrt(area)
        const quad = 0.5 * mat.density * charLen * speed
        const stokes = 4 * Math.PI * mat.viscosity
        const dfx = -(quad + stokes) * v.x
        const dfy = -(quad + stokes) * v.y
        const torqueDamp = -item.snap.omega * mat.density * area * 0.15
        world.applyForce(item.body.id, fx + dfx, fy + dfy, c)
        world.applyTorque(item.body.id, torqueDamp)
        this.debug.push({
          bodyId: item.body.id,
          area,
          cx: c.x,
          cy: c.y,
          fx: fx + dfx,
          fy: fy + dfy,
        })
      }
    }
  }
}
