import type { Vec2 } from '../../core/math/vec2.ts'
import {
  clipHalfPlane,
  pointInPolygon,
  polygonArea,
  polygonCentroid,
} from '../../core/math/polygon.ts'
import type { SceneBody, SceneFluidVolume } from '../../scene/document.ts'
import { getFluid } from '../../materials/catalog.ts'
import type { BodyId } from '../../core/ids.ts'
import type { ColliderDesc, PhysicsWorld } from '../../physics/ports.ts'
import { fluidDragForce, fluidTorqueDamp } from '../analytic/AnalyticFluid.ts'
import { shapeToWorldPolygons } from '../bodyPolygon.ts'
import { collideSolidCached, cacheSolids, pushOutOfShape } from './collide.ts'
import { estimateFreeSurfaceD } from './freeSurface.ts'
import { CountingSortGrid, buildCountingSort } from './hash.ts'
import { clavetRestDensity, xsphEpsilon } from './kernels.ts'

/** Snapshot particle for render / HUD (plain data, no solver internals). */
export type FluidParticle = {
  x: number
  y: number
  vx: number
  vy: number
  volumeId: string
  color: number
  opacity: number
  /** SPH density ρ_i / ρ0 (1 ≈ rest). */
  density: number
}

export const PBF_DEFAULT_SPACING = 0.1
export const PBF_MAX_PARTICLES = 2200

const SPH_SUBSTEPS = 2
const SPH_H_FACTOR = 2.2
const SPH_COLLISION_RADIUS = 0.5
const SPH_DRAW_RADIUS = 0.65
const SPH_K = 10
const SPH_K_NEAR = 5
const CULL_Y = -40
/** Splash/impact coupling only — hydrostatic lift comes from Archimedes, not this. */
const COUPLING = 0.1
const V_MAX = 8
/** Numerical dust only — XSPH is the physical damper. */
const V_REST = 0.008
/** Cap total impulse applied to one dynamic body per step (avoids explosions). */
const MAX_BODY_IMPULSE = 1.8
/** Max solid push absorbed without becoming fake velocity (stops wall jets). */
const MAX_SOLID_CORR = 0.08
/** Below this, a floating body uses Archimedes only (no particle kicks, no Rapier wake). */
const BODY_REST_SPEED = 0.09
const BODY_REST_OMEGA = 0.12
/** Full splash coupling above this speed; quadratic fade in between. */
const BODY_IMPACT_SPEED = 0.35
const MIN_COUPLE_IMPULSE = 2e-4
/** EMA of the local free surface (low = smoother rest, high = faster splash). */
const SURFACE_BLEND = 0.1
const FORCE_BLEND = 0.12

type Seed = {
  x: number
  y: number
  volumeId: string
  color: number
  opacity: number
  density: number
  viscosity: number
}

/**
 * SPH Clavet (2D CPU, double-density), not PBF. Two internal substeps of dt/2.
 * Facade kept under the PBF path from the plan.
 *
 * Two-way coupling is hybrid on purpose:
 * - Particle→body impulses: splash / impact. Faded to zero when the rigid is slow.
 * - Hydrostatic lift: clip each collider against a local free-surface plane
 *   (same Archimedes as the analytic tank). No exterior shell.
 * SPH pressure is never applied as a force on rigid bodies.
 */
export class PbfFluidSolver {
  readonly particles: FluidParticle[] = []

  private x: Float64Array = new Float64Array(0)
  private y: Float64Array = new Float64Array(0)
  private px: Float64Array = new Float64Array(0)
  private py: Float64Array = new Float64Array(0)
  private vx: Float64Array = new Float64Array(0)
  private vy: Float64Array = new Float64Array(0)
  private volumeId: string[] = []
  private color: number[] = []
  private opacity: number[] = []
  private density: Float64Array = new Float64Array(0)
  private viscosity: Float64Array = new Float64Array(0)
  private rho: Float64Array = new Float64Array(0)
  private rhoNear: Float64Array = new Float64Array(0)
  private press: Float64Array = new Float64Array(0)
  private pressNear: Float64Array = new Float64Array(0)
  private sphDensity: Float64Array = new Float64Array(0)
  private n = 0
  private cap = 0
  private radius = PBF_DEFAULT_SPACING * SPH_COLLISION_RADIUS
  /** Seed spacing of the last volume (column width for the free-surface estimate). */
  private spacing = PBF_DEFAULT_SPACING
  private h = PBF_DEFAULT_SPACING * SPH_H_FACTOR
  private rho0 = clavetRestDensity(PBF_DEFAULT_SPACING, PBF_DEFAULT_SPACING * SPH_H_FACTOR)
  private readonly hash = new CountingSortGrid()
  /** Collision radius of a particle. */
  get particleRadius(): number {
    return this.radius
  }

  get particleSpacing(): number {
    return this.spacing
  }

  get particleDrawRadius(): number {
    return this.spacing * SPH_DRAW_RADIUS
  }

  /** Last buoyancy samples (for tests / debug HUD). */
  readonly buoyancyDebug: {
    bodyId: string
    area: number
    cx: number
    cy: number
    fx: number
    fy: number
  }[] = []
  /** Smoothed free-surface plane offset per dynamic body. */
  private readonly surfaceD = new Map<string, number>()
  private readonly forceMag = new Map<string, number>()

  get particleCount(): number {
    return this.n
  }

  clear(): void {
    this.n = 0
    this.particles.length = 0
    this.volumeId = []
    this.color = []
    this.opacity = []
    this.buoyancyDebug.length = 0
    this.surfaceD.clear()
    this.forceMag.clear()
  }

  /** Full reseeds from authored volumes (reset / reload). */
  rebuild(volumes: readonly SceneFluidVolume[], world?: PhysicsWorld | null): void {
    this.clear()
    for (const vol of volumes) this.addVolume(vol, world)
  }

  /**
   * Append particles for one volume without touching existing ones.
   * Used when the user draws a new spill region mid-simulation.
   */
  addVolume(vol: SceneFluidVolume, world?: PhysicsWorld | null): number {
    const seeds = seedVolume(vol, this.n, world)
    if (!seeds.length) return 0
    const spacing = vol.spacing > 0 ? vol.spacing : PBF_DEFAULT_SPACING
    this.spacing = spacing
    this.radius = spacing * SPH_COLLISION_RADIUS
    this.h = spacing * SPH_H_FACTOR
    this.rho0 = clavetRestDensity(spacing, this.h)
    this.ensureCap(this.n + seeds.length)
    for (const s of seeds) {
      const i = this.n
      this.x[i] = s.x
      this.y[i] = s.y
      this.vx[i] = 0
      this.vy[i] = 0
      this.px[i] = s.x
      this.py[i] = s.y
      this.volumeId[i] = s.volumeId
      this.color[i] = s.color
      this.opacity[i] = s.opacity
      this.density[i] = s.density
      this.viscosity[i] = s.viscosity
      this.sphDensity[i] = 1
      this.n++
    }
    this.syncSnapshot()
    return seeds.length
  }

  /** Drop particles whose volume id is no longer in the document. */
  retainVolumes(volumeIds: ReadonlySet<string>): void {
    let w = 0
    for (let i = 0; i < this.n; i++) {
      if (!volumeIds.has(this.volumeId[i]!)) continue
      if (w !== i) {
        this.x[w] = this.x[i]!
        this.y[w] = this.y[i]!
        this.vx[w] = this.vx[i]!
        this.vy[w] = this.vy[i]!
        this.volumeId[w] = this.volumeId[i]!
        this.color[w] = this.color[i]!
        this.opacity[w] = this.opacity[i]!
        this.density[w] = this.density[i]!
        this.viscosity[w] = this.viscosity[i]!
        this.sphDensity[w] = this.sphDensity[i]!
      }
      w++
    }
    this.n = w
    this.syncSnapshot()
  }

  step(world: PhysicsWorld, dt: number, bodies: readonly SceneBody[] = []): void {
    if (this.n === 0) return
    const g = world.gravity
    const n = this.n
    const h = this.h
    const h2 = h * h
    const rCol = this.radius
    const rho0 = this.rho0
    const k = SPH_K
    const kNear = SPH_K_NEAR
    const dtSub = dt / SPH_SUBSTEPS
    const dtSub2 = dtSub * dtSub
    const solids = cacheSolids(world, rCol)
    const bodyImpulse = new Map<BodyId, { x: number; y: number; jx: number; jy: number }>()
    const solidDx = new Float64Array(n)
    const solidDy = new Float64Array(n)
    const dvx = new Float64Array(n)
    const dvy = new Float64Array(n)
    const wsum = new Float64Array(n)

    for (let sub = 0; sub < SPH_SUBSTEPS; sub++) {
      solidDx.fill(0)
      solidDy.fill(0)

      for (let i = 0; i < n; i++) {
        this.vx[i]! += g.x * dtSub
        this.vy[i]! += g.y * dtSub
        this.px[i] = this.x[i]! + this.vx[i]! * dtSub
        this.py[i] = this.y[i]! + this.vy[i]! * dtSub
      }

      for (let i = 0; i < n; i++) {
        const bx = this.px[i]!
        const by = this.py[i]!
        collideSolidCached(this.px, this.py, i, rCol, solids, bodyImpulse, this.x[i]!, this.y[i]!)
        solidDx[i]! += this.px[i]! - bx
        solidDy[i]! += this.py[i]! - by
      }

      buildCountingSort(this.px, this.py, n, h, this.hash)

      const rho = this.rho
      const rhoNear = this.rhoNear
      const press = this.press
      const pressNear = this.pressNear
      rho.fill(1, 0, n)
      rhoNear.fill(1, 0, n)
      for (let i = 0; i < n; i++) {
        this.hash.queryNeighbors(i, (j) => {
          if (j <= i) return
          const dx = this.px[i]! - this.px[j]!
          const dy = this.py[i]! - this.py[j]!
          const d2 = dx * dx + dy * dy
          if (d2 >= h2 || d2 < 1e-14) return
          const r = Math.sqrt(d2)
          const w = 1 - r / h
          const w2 = w * w
          rho[i]! += w2
          rho[j]! += w2
          const w3 = w2 * w
          rhoNear[i]! += w3
          rhoNear[j]! += w3
        })
      }

      for (let i = 0; i < n; i++) {
        press[i] = k * (rho[i]! - rho0)
        pressNear[i] = kNear * rhoNear[i]!
        this.sphDensity[i] = rho[i]! / rho0
      }

      for (let i = 0; i < n; i++) {
        this.hash.queryNeighbors(i, (j) => {
          if (j <= i) return
          const dx = this.px[i]! - this.px[j]!
          const dy = this.py[i]! - this.py[j]!
          const d2 = dx * dx + dy * dy
          if (d2 >= h2 || d2 < 1e-14) return
          const r = Math.sqrt(d2)
          const q = r / h
          const w = 1 - q
          const mag =
            dtSub2 * ((press[i]! + press[j]!) * 0.5 + (pressNear[i]! + pressNear[j]!) * 0.5 * w) * w
          const invR = 1 / r
          const mx = mag * 0.5 * dx * invR
          const my = mag * 0.5 * dy * invR
          this.px[i]! += mx
          this.py[i]! += my
          this.px[j]! -= mx
          this.py[j]! -= my
        })
      }

      for (let i = 0; i < n; i++) {
        const bx = this.px[i]!
        const by = this.py[i]!
        collideSolidCached(this.px, this.py, i, rCol, solids, bodyImpulse, this.x[i]!, this.y[i]!)
        solidDx[i]! += this.px[i]! - bx
        solidDy[i]! += this.py[i]! - by
      }

      for (let i = 0; i < n; i++) {
        let sx = solidDx[i]!
        let sy = solidDy[i]!
        const sc = Math.hypot(sx, sy)
        if (sc > MAX_SOLID_CORR) {
          const s = MAX_SOLID_CORR / sc
          sx *= s
          sy *= s
        }
        this.vx[i] = (this.px[i]! - sx - this.x[i]!) / dtSub
        this.vy[i] = (this.py[i]! - sy - this.y[i]!) / dtSub
        if (sc > 1e-8) {
          const nx = solidDx[i]! / sc
          const ny = solidDy[i]! / sc
          const vn = this.vx[i]! * nx + this.vy[i]! * ny
          if (vn < 0) {
            this.vx[i]! -= vn * nx
            this.vy[i]! -= vn * ny
          }
          const vt = this.vx[i]! * -ny + this.vy[i]! * nx
          const vtf = vt * 0.92
          this.vx[i] = this.vx[i]! - -ny * vt + -ny * vtf
          this.vy[i] = this.vy[i]! - nx * vt + nx * vtf
        }
        this.x[i] = this.px[i]!
        this.y[i] = this.py[i]!
      }

      // Implicit XSPH: v_i ← (v_i + Σ ε w v_j) / (1 + Σ ε w), applied after
      // integrating v from positions. The plan's explicit v += ε Σ (Δv) w made
      // honey (ε=0.45) explode; if this ran before v = (p − x) / dt it would be
      // wiped. Denominator kept — do not go back to the un-normalized sum.
      dvx.fill(0)
      dvy.fill(0)
      wsum.fill(0)
      for (let i = 0; i < n; i++) {
        const epsI = xsphEpsilon(this.viscosity[i]!)
        this.hash.queryNeighbors(i, (j) => {
          if (j <= i) return
          const dx = this.x[i]! - this.x[j]!
          const dy = this.y[i]! - this.y[j]!
          const d2 = dx * dx + dy * dy
          if (d2 >= h2 || d2 < 1e-14) return
          const r = Math.sqrt(d2)
          const w = 1 - r / h
          const eps = 0.5 * (epsI + xsphEpsilon(this.viscosity[j]!))
          const dvxP = eps * (this.vx[j]! - this.vx[i]!) * w
          const dvyP = eps * (this.vy[j]! - this.vy[i]!) * w
          dvx[i]! += dvxP
          dvy[i]! += dvyP
          dvx[j]! -= dvxP
          dvy[j]! -= dvyP
          wsum[i]! += eps * w
          wsum[j]! += eps * w
        })
      }
      for (let i = 0; i < n; i++) {
        const denom = 1 + wsum[i]!
        this.vx[i]! += dvx[i]! / denom
        this.vy[i]! += dvy[i]! / denom
        const sp = Math.hypot(this.vx[i]!, this.vy[i]!)
        if (sp > V_MAX) {
          const s = V_MAX / sp
          this.vx[i]! *= s
          this.vy[i]! *= s
        }
        if (Math.hypot(this.vx[i]!, this.vy[i]!) < V_REST) {
          this.vx[i] = 0
          this.vy[i] = 0
        }
      }
    }

    const buoyant = this.applyBuoyancy(world, bodies)
    this.applySplashImpulses(world, bodyImpulse, buoyant)
    this.cullFallen()
    this.syncSnapshot()
  }

  /**
   * Particle→body impulses for splash/impact. Never applied to a nearly still
   * rigid (`applyImpulse` always wakes Rapier). A body already getting Archimedes
   * only receives kicks at impact speed, not a soft-sphere cushion.
   */
  private applySplashImpulses(
    world: PhysicsWorld,
    bodyImpulse: Map<BodyId, { x: number; y: number; jx: number; jy: number }>,
    buoyant: ReadonlySet<BodyId>,
  ): void {
    for (const [id, imp] of bodyImpulse) {
      const body = world.getBody(id)
      if (!body || body.type !== 'dynamic') continue
      const bodySp = Math.hypot(body.vx, body.vy)
      const almostStill = bodySp < BODY_REST_SPEED && Math.abs(body.omega) < BODY_REST_OMEGA
      if (almostStill) continue
      if (buoyant.has(id) && bodySp < BODY_IMPACT_SPEED) continue
      let jx = imp.jx * COUPLING
      let jy = imp.jy * COUPLING
      const mag = Math.hypot(jx, jy)
      if (mag < MIN_COUPLE_IMPULSE) continue
      if (mag > MAX_BODY_IMPULSE) {
        const s = MAX_BODY_IMPULSE / mag
        jx *= s
        jy *= s
      }
      world.applyImpulse(id, jx, jy, { x: imp.x, y: imp.y })
    }
  }

  /**
   * Archimedes: clip each collider against a local free surface estimated from
   * nearby particles (column maxes along −ĝ). The surface is taken from the
   * **flanks** of the body, never from its own column — water riding on top
   * would otherwise report the body as fully submerged and levitate it.
   * Returns ids that received lift so splash impulses can stay off at rest.
   */
  private applyBuoyancy(world: PhysicsWorld, bodies: readonly SceneBody[]): Set<BodyId> {
    this.buoyancyDebug.length = 0
    const buoyant = new Set<BodyId>()
    const g = world.gravity
    const gmag = Math.hypot(g.x, g.y)
    if (gmag < 1e-8 || this.n === 0) return buoyant
    const gx = g.x / gmag
    const gy = g.y / gmag
    const nx = -gx
    const ny = -gy
    const tx = -ny
    const ty = nx
    const colW = Math.max(this.spacing, 0.06)
    const contactR = this.radius
    const gScaleOf = new Map(bodies.map((b) => [b.id, b.gravityScale]))
    const seen = new Set<BodyId>()

    world.forEachBody((body) => {
      if (body.type !== 'dynamic') return
      const colliders = world.getColliders(body.id)
      if (!colliders.length) return

      const polys: Vec2[][] = []
      let tMin = Infinity
      let tMax = -Infinity
      let sMin = Infinity
      let sMax = -Infinity
      for (const col of colliders) {
        if (col.isSensor) continue
        const ox = body.x + (col.offset?.x ?? 0)
        const oy = body.y + (col.offset?.y ?? 0)
        const ang = body.angle + (col.angle ?? 0)
        for (const verts of shapeToWorldPolygons(col.shape, ox, oy, ang)) {
          polys.push(verts)
          for (const p of verts) {
            const t = p.x * tx + p.y * ty
            const s = p.x * nx + p.y * ny
            if (t < tMin) tMin = t
            if (t > tMax) tMax = t
            if (s < sMin) sMin = s
            if (s > sMax) sMax = s
          }
        }
      }
      if (!polys.length || !Number.isFinite(tMin)) return

      // Sample flanks well past the body; surface height must not come from the
      // body's own column (under-body water + film riding on the top face).
      const bodyPadT = Math.max(colW * 1.5, contactR * 2, (tMax - tMin) * 0.1)
      const padT = Math.max(colW * 6, (tMax - tMin) * 0.5, bodyPadT + colW * 3, 0.35)
      const bandT0 = tMin - padT
      const bandT1 = tMax + padT
      const colT0 = tMin - bodyPadT
      const colT1 = tMax + bodyPadT
      const surfaceArgs = {
        x: this.x,
        y: this.y,
        n: this.n,
        nx,
        ny,
        tMin: bandT0,
        tMax: bandT1,
        sMin: sMin - 1.5,
        sMax: sMax + colW * 3,
        columnWidth: colW,
      }
      // Prefer flanks. Fallback for tight cups with no usable side water: still
      // reject the contact shell and any film above the body's top face.
      let clipDRaw = estimateFreeSurfaceD({
        ...surfaceArgs,
        skip: (_i, _s, t) => t >= colT0 && t <= colT1,
      })
      if (clipDRaw === null) {
        clipDRaw = estimateFreeSurfaceD({
          ...surfaceArgs,
          skip: (i, s, t) => {
            if (particleInBodyShell(this.x[i]!, this.y[i]!, contactR, body, colliders)) {
              return true
            }
            // Riding film: above the body, within its tangent span.
            return s > sMax + contactR && t >= colT0 && t <= colT1
          },
        })
      }
      if (clipDRaw === null) return
      // Body entirely above the live surface: drop lagged clip so a collapsing
      // column cannot keep applying full Archimedes after the pool has fallen.
      if (clipDRaw < sMin - colW * 0.5) {
        this.surfaceD.delete(body.id)
        this.forceMag.delete(body.id)
        return
      }
      const prevD = this.surfaceD.get(body.id)
      const blend =
        prevD === undefined ? 1 : Math.abs(clipDRaw - prevD) > 0.3 ? 0.45 : SURFACE_BLEND
      // Snap down with the pool (collapsed column); lag only on the way up so splash
      // does not yank Archimedes.
      const clipD =
        prevD === undefined || clipDRaw < prevD ? clipDRaw : prevD + (clipDRaw - prevD) * blend
      this.surfaceD.set(body.id, clipD)

      let densSum = 0
      let viscSum = 0
      let densN = 0
      for (let i = 0; i < this.n; i++) {
        const px = this.x[i]!
        const py = this.y[i]!
        const t = px * tx + py * ty
        if (t < bandT0 || t > bandT1) continue
        const s = px * nx + py * ny
        if (s < sMin - 1.5 || s > clipD + colW) continue
        densSum += this.density[i]!
        viscSum += this.viscosity[i]!
        densN++
      }
      if (densN < 4) return
      const ρ = densSum / densN
      const μ = viscSum / densN

      let area = 0
      let cx = 0
      let cy = 0
      let clippedForDrag: Vec2[] = []
      for (const verts of polys) {
        const clipped = clipHalfPlane(verts, nx, ny, clipD)
        const a = polygonArea(clipped)
        if (a < 1e-8) continue
        const c = polygonCentroid(clipped)
        cx += c.x * a
        cy += c.y * a
        area += a
        if (clipped.length > clippedForDrag.length) clippedForDrag = clipped
      }
      if (area < 1e-8) return
      cx /= area
      cy /= area

      const gScale = gScaleOf.get(body.id) ?? 1
      const Fraw = ρ * area * gmag * gScale
      const prevF = this.forceMag.get(body.id)
      const weight = Math.max(1e-6, body.mass * gmag)
      const fBlend =
        prevF === undefined ? 1 : Math.abs(Fraw - prevF) > 0.3 * weight ? 0.45 : FORCE_BLEND
      const F = prevF === undefined || Fraw < prevF ? Fraw : prevF + (Fraw - prevF) * fBlend
      this.forceMag.set(body.id, F)
      const fx = -gx * F
      const fy = -gy * F
      const drag = fluidDragForce(body.vx, body.vy, ρ, μ, clippedForDrag, area)
      const torqueDamp = fluidTorqueDamp(ρ, area, body.omega)
      const bodySp = Math.hypot(body.vx, body.vy)
      const almostStill = bodySp < BODY_REST_SPEED && Math.abs(body.omega) < BODY_REST_OMEGA
      const residual = Math.abs(F - weight) / weight
      const liftRatio = F / weight
      const at = almostStill ? { x: body.x, y: body.y } : { x: cx, y: cy }
      world.applyForce(body.id, fx + drag.x, fy + drag.y, at, false)
      world.applyTorque(body.id, torqueDamp, false)
      seen.add(body.id)
      buoyant.add(body.id)
      // Wake a sunk floater so Archimedes can lift it; do not wake wet walls (lift ≪ mg).
      if (liftRatio > 0.35 && residual > 0.5) {
        world.wake(body.id)
      } else if (liftRatio > 0.35 && residual < 0.35) {
        world.setVelocity(body.id, body.vx * 0.92, body.vy * 0.92, body.omega * 0.88, false)
        if (
          almostStill &&
          residual < 0.12 &&
          liftRatio < 1.35 &&
          bodySp < 0.04 &&
          Math.abs(body.omega) < 0.04
        ) {
          world.setVelocity(body.id, 0, 0, 0, false)
        }
      }
      this.buoyancyDebug.push({
        bodyId: body.id,
        area,
        cx: at.x,
        cy: at.y,
        fx: fx + drag.x,
        fy: fy + drag.y,
      })
    })
    for (const id of [...this.surfaceD.keys()]) {
      if (seen.has(id)) continue
      this.surfaceD.delete(id)
      this.forceMag.delete(id)
    }
    return buoyant
  }

  private ensureCap(need: number): void {
    if (need <= this.cap) return
    const next = Math.max(need, Math.ceil(this.cap * 1.5) || 64, 64)
    const nx = new Float64Array(next)
    const ny = new Float64Array(next)
    const npx = new Float64Array(next)
    const npy = new Float64Array(next)
    const nvx = new Float64Array(next)
    const nvy = new Float64Array(next)
    const nd = new Float64Array(next)
    const nmu = new Float64Array(next)
    const nrho = new Float64Array(next)
    const nrhoN = new Float64Array(next)
    const npress = new Float64Array(next)
    const npressN = new Float64Array(next)
    const nsph = new Float64Array(next)
    nx.set(this.x.subarray(0, this.n))
    ny.set(this.y.subarray(0, this.n))
    npx.set(this.px.subarray(0, this.n))
    npy.set(this.py.subarray(0, this.n))
    nvx.set(this.vx.subarray(0, this.n))
    nvy.set(this.vy.subarray(0, this.n))
    nd.set(this.density.subarray(0, this.n))
    nmu.set(this.viscosity.subarray(0, this.n))
    nrho.set(this.rho.subarray(0, this.n))
    nrhoN.set(this.rhoNear.subarray(0, this.n))
    npress.set(this.press.subarray(0, this.n))
    npressN.set(this.pressNear.subarray(0, this.n))
    nsph.set(this.sphDensity.subarray(0, this.n))
    this.x = nx
    this.y = ny
    this.px = npx
    this.py = npy
    this.vx = nvx
    this.vy = nvy
    this.density = nd
    this.viscosity = nmu
    this.rho = nrho
    this.rhoNear = nrhoN
    this.press = npress
    this.pressNear = npressN
    this.sphDensity = nsph
    this.volumeId.length = next
    this.color.length = next
    this.opacity.length = next
    this.cap = next
  }

  private cullFallen(): void {
    let w = 0
    for (let i = 0; i < this.n; i++) {
      if (this.y[i]! < CULL_Y) continue
      if (w !== i) {
        this.x[w] = this.x[i]!
        this.y[w] = this.y[i]!
        this.vx[w] = this.vx[i]!
        this.vy[w] = this.vy[i]!
        this.volumeId[w] = this.volumeId[i]!
        this.color[w] = this.color[i]!
        this.opacity[w] = this.opacity[i]!
        this.density[w] = this.density[i]!
        this.viscosity[w] = this.viscosity[i]!
        this.sphDensity[w] = this.sphDensity[i]!
      }
      w++
    }
    this.n = w
  }

  private syncSnapshot(): void {
    this.particles.length = this.n
    for (let i = 0; i < this.n; i++) {
      this.particles[i] = {
        x: this.x[i]!,
        y: this.y[i]!,
        vx: this.vx[i]!,
        vy: this.vy[i]!,
        volumeId: this.volumeId[i]!,
        color: this.color[i]!,
        opacity: this.opacity[i]!,
        density: this.sphDensity[i]!,
      }
    }
  }
}

function seedVolume(vol: SceneFluidVolume, already: number, world?: PhysicsWorld | null): Seed[] {
  const mat = getFluid(vol.materialId)
  let spacing = vol.spacing > 0 ? vol.spacing : PBF_DEFAULT_SPACING
  let filled = fillPolygon(vol.polygon, spacing)
  while (already + filled.length > PBF_MAX_PARTICLES && spacing < 0.5) {
    spacing *= 1.25
    filled = fillPolygon(vol.polygon, spacing)
  }
  const room = PBF_MAX_PARTICLES - already
  const margin = spacing * 0.55
  const amp = spacing * 0.12
  let rng = hashVolumeId(vol.id)
  const out: Seed[] = []
  for (let i = 0; i < filled.length && out.length < room; i++) {
    const p = filled[i]!
    rng = lcg(rng)
    const jx = (rng / 4294967296) * 2 * amp - amp
    rng = lcg(rng)
    const jy = (rng / 4294967296) * 2 * amp - amp
    const x = p.x + jx
    const y = p.y + jy
    if (world && pointOverlapsSolid(world, x, y, margin)) continue
    out.push({
      x,
      y,
      volumeId: vol.id,
      color: mat.color,
      opacity: mat.opacity,
      density: mat.density,
      viscosity: mat.viscosity,
    })
  }
  return out
}

function hashVolumeId(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function lcg(state: number): number {
  return (Math.imul(state, 1664525) + 1013904223) >>> 0
}

function pointOverlapsSolid(world: PhysicsWorld, x: number, y: number, radius: number): boolean {
  let hit = false
  world.forEachBody((body) => {
    if (hit) return
    for (const col of world.getColliders(body.id)) {
      if (col.isSensor) continue
      const ox = body.x + (col.offset?.x ?? 0)
      const oy = body.y + (col.offset?.y ?? 0)
      const ang = body.angle + (col.angle ?? 0)
      if (pushOutOfShape(x, y, radius, col.shape, ox, oy, ang)) {
        hit = true
        return
      }
    }
  })
  return hit
}

function particleInBodyShell(
  px: number,
  py: number,
  shell: number,
  body: { x: number; y: number; angle: number },
  colliders: ColliderDesc[],
): boolean {
  for (const col of colliders) {
    if (col.isSensor) continue
    const ox = body.x + (col.offset?.x ?? 0)
    const oy = body.y + (col.offset?.y ?? 0)
    const ang = body.angle + (col.angle ?? 0)
    if (pushOutOfShape(px, py, shell, col.shape, ox, oy, ang)) return true
  }
  return false
}

function fillPolygon(poly: readonly Vec2[], spacing: number): Vec2[] {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of poly) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  const out: Vec2[] = []
  const pad = spacing * 0.5
  const rowH = spacing * 0.8660254037844386
  let row = 0
  for (let y = minY + pad; y <= maxY - pad; y += rowH) {
    const x0 = minX + pad + (row % 2 === 1 ? spacing * 0.5 : 0)
    for (let x = x0; x <= maxX - pad; x += spacing) {
      const p = { x, y }
      if (pointInPolygon(p, poly)) out.push(p)
    }
    row++
  }
  return out
}
