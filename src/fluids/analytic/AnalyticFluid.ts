import type { Vec2 } from '../../core/math/vec2.ts'
import {
  clipHalfPlane,
  clipPolygon,
  polygonArea,
  polygonCentroid,
} from '../../core/math/polygon.ts'
import type { SceneBody, SceneFluidRegion } from '../../scene/document.ts'
import { getFluid } from '../../materials/catalog.ts'
import type { PhysicsWorld } from '../../physics/ports.ts'
import type { BodySnapshot } from '../../physics/ports.ts'
import { shapeToWorldPolygon } from '../bodyPolygon.ts'

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

/** Default quadratic drag coefficient (bluff body in 2D). */
export const DEFAULT_DRAG_CD = 1.0

/**
 * Linear (Stokes-like) drag: b = k μ L, L = √A.
 * k ~ 4π keeps water lab-scale quadratic-dominated (μ≈0.001) while honey (μ≈10) is clear.
 */
export const STOKES_DRAG_K = 4 * Math.PI

/** Angular drag: τ = −c ρ A R² ω with R² := A (submerged). Dimensionally kg·m²/s in 2D. */
export const TORQUE_DRAG_C = 0.15

function bodyPolygon(body: SceneBody, snap: BodySnapshot): Vec2[] {
  return shapeToWorldPolygon(body.shape, snap.x, snap.y, snap.angle)
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

/** Projected width of a polygon onto unit axis (ux, uy). Used as A_proj in 2D. */
export function projectedSpan(poly: readonly Vec2[], ux: number, uy: number): number {
  if (poly.length === 0) return 0
  let min = poly[0]!.x * ux + poly[0]!.y * uy
  let max = min
  for (let i = 1; i < poly.length; i++) {
    const s = poly[i]!.x * ux + poly[i]!.y * uy
    if (s < min) min = s
    if (s > max) max = s
  }
  return Math.max(0, max - min)
}

/**
 * Rest free-surface plane offset d for half-plane n·p ≤ d.
 * Maps authored `restSurfaceY` (world-Y fill when g∥−Y) to a fill fraction along n̂
 * so tilted gravity keeps a coherent semiplane anchored to the tank polygon.
 */
export function restPlaneD(
  tank: readonly Vec2[],
  nx: number,
  ny: number,
  restSurfaceY: number,
): number {
  if (tank.length === 0) return ny * restSurfaceY
  let yMin = tank[0]!.y
  let yMax = yMin
  let sMin = nx * tank[0]!.x + ny * tank[0]!.y
  let sMax = sMin
  for (let i = 1; i < tank.length; i++) {
    const p = tank[i]!
    if (p.y < yMin) yMin = p.y
    if (p.y > yMax) yMax = p.y
    const s = nx * p.x + ny * p.y
    if (s < sMin) sMin = s
    if (s > sMax) sMax = s
  }
  const ySpan = yMax - yMin
  const fillFrac = ySpan > 1e-9 ? Math.min(1, Math.max(0, (restSurfaceY - yMin) / ySpan)) : 1
  return sMin + fillFrac * (sMax - sMin)
}

/** Quadratic + linear drag: F_d = −½ Cd ρ A_proj |v| v − b(μ,L) v. */
export function fluidDragForce(
  vx: number,
  vy: number,
  density: number,
  viscosity: number,
  submerged: readonly Vec2[],
  area: number,
  cd = DEFAULT_DRAG_CD,
): Vec2 {
  const speed = Math.hypot(vx, vy)
  const L = Math.sqrt(Math.max(area, 0))
  const b = STOKES_DRAG_K * viscosity * L
  let aProj = L
  if (speed > 1e-8 && submerged.length >= 2) {
    // Width facing the flow: span ⊥ v̂.
    aProj = projectedSpan(submerged, -vy / speed, vx / speed)
    if (aProj < 1e-8) aProj = L
  }
  const scale = 0.5 * cd * density * aProj * speed + b
  return { x: -scale * vx, y: -scale * vy }
}

/** Viscous/angular fluid torque: τ = −c ρ A R² ω, R² := A. */
export function fluidTorqueDamp(density: number, area: number, omega: number): number {
  const r2 = Math.max(area, 0)
  return -TORQUE_DRAG_C * density * area * r2 * omega
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
    // Surface normal follows −g. At zero-g the free surface is undefined; fall back to +Y
    // (document restSurfaceY) so overlap + drag still work while buoyancy → 0.
    const gx = gmag < 1e-8 ? 0 : g.x / gmag
    const gy = gmag < 1e-8 ? -1 : g.y / gmag
    const nx = -gx
    const ny = -gy

    const snapMap = new Map(snaps.map((s) => [s.id, s]))

    for (const region of regions) {
      const mat = getFluid(region.materialId)
      const dRest = restPlaneD(region.polygon, nx, ny, region.restSurfaceY)
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
      const surfaceY = Math.abs(ny) > 1e-8 ? clipD / ny : region.restSurfaceY
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
        // Archimedes: F = ρ A |g| · gravityScale. Vanishes in zero-g or gravityScale 0.
        // Drag / torque damping below stay independent of gravityScale (viscous, not weight).
        const F = mat.density * area * gmag * item.body.gravityScale
        const fx = -gx * F
        const fy = -gy * F
        const drag = fluidDragForce(
          item.snap.vx,
          item.snap.vy,
          mat.density,
          mat.viscosity,
          clipped,
          area,
        )
        const torqueDamp = fluidTorqueDamp(mat.density, area, item.snap.omega)
        world.applyForce(item.body.id, fx + drag.x, fy + drag.y, c)
        world.applyTorque(item.body.id, torqueDamp)
        this.debug.push({
          bodyId: item.body.id,
          area,
          cx: c.x,
          cy: c.y,
          fx: fx + drag.x,
          fy: fy + drag.y,
        })
      }
    }
  }
}
