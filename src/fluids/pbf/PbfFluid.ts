import type { Vec2 } from '../../core/math/vec2.ts'
import {
  clipHalfPlane,
  ensureCCW,
  pointInPolygon,
  polygonArea,
  polygonCentroid,
} from '../../core/math/polygon.ts'
import type { SceneBody, SceneFluidVolume } from '../../scene/document.ts'
import { getFluid } from '../../materials/catalog.ts'
import type { BodyId } from '../../core/ids.ts'
import type { BodySnapshot, ColliderDesc, PhysicsWorld } from '../../physics/ports.ts'
import {
  fluidDragForce,
  fluidTorqueDamp,
  planeSpan,
  waveRadiationForce,
} from '../analytic/AnalyticFluid.ts'
import { shapeToWorldPolygons } from '../bodyPolygon.ts'
import { collideSolidCached, cacheSolids, forEachNearSurface, pushOutOfShape } from './collide.ts'
import { estimateFreeSurfaceD } from './freeSurface.ts'
import { CountingSortGrid, PairList, buildCountingSort } from './hash.ts'
import {
  clavetRestDensity,
  clavetWallTables,
  wallLookup,
  xsphEpsilon,
  type WallTables,
} from './kernels.ts'

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
/**
 * Particle budget. ~3 µs/particle/step in the browser (pair-list solver): 3000 leaves room
 * for drawing inside a 60 Hz frame. Deeper pools than this allows start to churn (the
 * compressible solver squeezes ~4× at depth), so raising it needs an incompressible solver.
 */
export const PBF_MAX_PARTICLES = 3000

const SPH_SUBSTEPS = 2
const SPH_H_FACTOR = 2.2
const SPH_COLLISION_RADIUS = 0.5
const SPH_DRAW_RADIUS = 0.65
/**
 * Clavet stiffness (m/s²). Higher k compresses less but boils at this step size even with
 * dt²·k held fixed by more substeps (measured k = 20..200): the water stays compressible.
 */
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
/** Below this, a floating body uses Archimedes only (no particle kicks, no Rapier wake). */
const BODY_REST_SPEED = 0.09
const BODY_REST_OMEGA = 0.12
/** Full splash coupling above this speed; quadratic fade in between. */
const BODY_IMPACT_SPEED = 0.35
const MIN_COUPLE_IMPULSE = 2e-4
/** EMA of the local free surface (low = smoother rest, high = faster splash). */
const SURFACE_BLEND = 0.1
/** Heave damping ratio for floats in particle water (wave radiation; see waveRadiationForce). */
const SPH_HEAVE_DAMPING = 0.5
/** Roll damping ratio for floats in particle water, against the waterplane roll stiffness. */
const SPH_ROLL_DAMPING = 0.25
/** A boundary piece is wet if a particle centre is within radius + WET_REACH·spacing. */
const WET_REACH = 0.9
/** Half width of the particle column above a boundary piece, in spacings. */
const COLUMN_HALF_WIDTH = 1
/** A vertical gap larger than this (in spacings) ends the connected water column. */
const COLUMN_GAP = 2.5
/** Boundary sampling step, in spacings. */
const SAMPLE_SPACING = 0.5
/** Steps (0.5 s) a float keeps the Archimedes model after losing water on one flank. */
const FLOAT_HOLD_STEPS = 30
/** Faces whose outward normal has an up component above this take only their own column. */
const UPWARD_FACE = 0.5

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
  private wall: WallTables = clavetWallTables(
    PBF_DEFAULT_SPACING,
    PBF_DEFAULT_SPACING * SPH_H_FACTOR,
  )
  private readonly hash = new CountingSortGrid()
  private readonly pairs = new PairList()
  private xsphEps: Float64Array = new Float64Array(0)
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
  /** Steps since a body last had water on both flanks (present = Archimedes path). */
  private readonly floatHold = new Map<string, number>()
  /** Smoothed free-surface plane offset per floating body (Archimedes path). */
  private readonly surfaceD = new Map<string, number>()

  /** Seeds dropped because the budget was full (reset on rebuild / clear). */
  truncatedSeeds = 0

  get particleCount(): number {
    return this.n
  }

  clear(): void {
    this.n = 0
    this.truncatedSeeds = 0
    this.particles.length = 0
    this.volumeId = []
    this.color = []
    this.opacity = []
    this.buoyancyDebug.length = 0
    this.floatHold.clear()
    this.surfaceD.clear()
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
    // One kernel (h, ρ0) for every particle: a second volume reuses the live spacing.
    // Changing it would shift the rest density of the particles already settled.
    const fixedSpacing = this.n > 0 ? this.spacing : null
    const { seeds, spacing, truncated } = seedVolume(vol, this.n, world, fixedSpacing)
    this.truncatedSeeds += truncated
    if (!seeds.length) return 0
    this.spacing = spacing
    this.radius = spacing * SPH_COLLISION_RADIUS
    this.h = spacing * SPH_H_FACTOR
    this.rho0 = clavetRestDensity(spacing, this.h)
    this.wall = clavetWallTables(spacing, this.h)
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
    // Same solids with AABBs grown by h: the reach of the boundary density / pressure.
    const solidsH = cacheSolids(world, h)
    const wall = this.wall
    const wRho = new Float64Array(n)
    const wRhoN = new Float64Array(n)
    const wPx = new Float64Array(n)
    const wPy = new Float64Array(n)
    const wPnx = new Float64Array(n)
    const wPny = new Float64Array(n)
    const bodyImpulse = new Map<BodyId, { x: number; y: number; jx: number; jy: number }>()
    const solidDx = new Float64Array(n)
    const solidDy = new Float64Array(n)
    const contact = {
      ux: new Float64Array(n),
      uy: new Float64Array(n),
      hit: new Uint8Array(n),
    }
    const dvx = new Float64Array(n)
    const dvy = new Float64Array(n)
    const wsum = new Float64Array(n)

    for (let sub = 0; sub < SPH_SUBSTEPS; sub++) {
      solidDx.fill(0)
      solidDy.fill(0)
      contact.hit.fill(0)

      for (let i = 0; i < n; i++) {
        this.vx[i]! += g.x * dtSub
        this.vy[i]! += g.y * dtSub
        this.px[i] = this.x[i]! + this.vx[i]! * dtSub
        this.py[i] = this.y[i]! + this.vy[i]! * dtSub
      }

      for (let i = 0; i < n; i++) {
        const bx = this.px[i]!
        const by = this.py[i]!
        collideSolidCached(
          this.px,
          this.py,
          i,
          rCol,
          solids,
          bodyImpulse,
          this.x[i]!,
          this.y[i]!,
          contact,
        )
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
      // Solid boundary: ghost-lattice density and the normal weights of its pressure push.
      wRho.fill(0)
      wRhoN.fill(0)
      wPx.fill(0)
      wPy.fill(0)
      wPnx.fill(0)
      wPny.fill(0)
      if (solidsH.length) {
        for (let i = 0; i < n; i++) {
          forEachNearSurface(
            this.px[i]!,
            this.py[i]!,
            h,
            solidsH,
            this.x[i]!,
            this.y[i]!,
            (d, nx, ny) => {
              const r1 = wallLookup(wall, wall.push, d)
              const r2 = wallLookup(wall, wall.pushNear, d)
              wRho[i]! += wallLookup(wall, wall.rho, d)
              wRhoN[i]! += wallLookup(wall, wall.rhoNear, d)
              wPx[i]! += r1 * nx
              wPy[i]! += r1 * ny
              wPnx[i]! += r2 * nx
              wPny[i]! += r2 * ny
            },
          )
          rho[i]! += wRho[i]!
          rhoNear[i]! += wRhoN[i]!
        }
      }
      // One grid walk per substep; density, relaxation and XSPH iterate this list in the
      // order the old per-pass grid queries used (the relaxation is order-dependent).
      const pairs = this.pairs
      this.hash.collectPairs(this.px, this.py, h2, pairs)
      const pI = pairs.i
      const pJ = pairs.j
      const nP = pairs.n
      const px = this.px
      const py = this.py
      for (let q = 0; q < nP; q++) {
        const i = pI[q]!
        const j = pJ[q]!
        const dx = px[i]! - px[j]!
        const dy = py[i]! - py[j]!
        const w = 1 - Math.sqrt(dx * dx + dy * dy) / h
        const w2 = w * w
        rho[i]! += w2
        rho[j]! += w2
        const w3 = w2 * w
        rhoNear[i]! += w3
        rhoNear[j]! += w3
      }

      for (let i = 0; i < n; i++) {
        press[i] = k * (rho[i]! - rho0)
        pressNear[i] = kNear * rhoNear[i]!
        this.sphDensity[i] = rho[i]! / rho0
      }

      for (let q = 0; q < nP; q++) {
        const i = pI[q]!
        const j = pJ[q]!
        const dx = px[i]! - px[j]!
        const dy = py[i]! - py[j]!
        const d2 = dx * dx + dy * dy
        if (d2 >= h2 || d2 < 1e-14) continue
        const r = Math.sqrt(d2)
        const w = 1 - r / h
        const mag =
          dtSub2 * ((press[i]! + press[j]!) * 0.5 + (pressNear[i]! + pressNear[j]!) * 0.5 * w) * w
        const invR = 1 / r
        const mx = mag * 0.5 * dx * invR
        const my = mag * 0.5 * dy * invR
        px[i]! += mx
        py[i]! += my
        px[j]! -= mx
        py[j]! -= my
      }

      // Ghosts carry the particle's own pressure (mirror) and never move: the particle takes
      // the pair's half share, like any neighbor.
      if (solidsH.length) {
        for (let i = 0; i < n; i++) {
          if (wRho[i] === 0) continue
          const f = dtSub2 * 0.5
          px[i]! += f * (press[i]! * wPx[i]! + pressNear[i]! * wPnx[i]!)
          py[i]! += f * (press[i]! * wPy[i]! + pressNear[i]! * wPny[i]!)
        }
      }

      for (let i = 0; i < n; i++) {
        const bx = this.px[i]!
        const by = this.py[i]!
        collideSolidCached(
          this.px,
          this.py,
          i,
          rCol,
          solids,
          bodyImpulse,
          this.x[i]!,
          this.y[i]!,
          contact,
        )
        solidDx[i]! += this.px[i]! - bx
        solidDy[i]! += this.py[i]! - by
      }

      for (let i = 0; i < n; i++) {
        // A solid push is penetration recovery, never velocity: solids do not move inside
        // this step, and turning the push into speed shot particles out of corners (jets).
        // A moving solid still drives the water through the contact-velocity floor below.
        const sx = solidDx[i]!
        const sy = solidDy[i]!
        const sc = Math.hypot(sx, sy)
        this.vx[i] = (this.px[i]! - sx - this.x[i]!) / dtSub
        this.vy[i] = (this.py[i]! - sy - this.y[i]!) / dtSub
        if (sc > 1e-8) {
          const nx = sx / sc
          const ny = sy / sc
          // Normal velocity at least that of the solid surface it touches (0 for a static
          // wall): no flow into the solid, and a moving body pushes the water with it.
          const un = contact.hit[i] ? contact.ux[i]! * nx + contact.uy[i]! * ny : 0
          const vn = this.vx[i]! * nx + this.vy[i]! * ny
          if (vn < un) {
            this.vx[i]! += (un - vn) * nx
            this.vy[i]! += (un - vn) * ny
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
      const eps = this.xsphEps
      for (let i = 0; i < n; i++) eps[i] = xsphEpsilon(this.viscosity[i]!)
      const x = this.x
      const y = this.y
      const vx = this.vx
      const vy = this.vy
      for (let q = 0; q < nP; q++) {
        const i = pI[q]!
        const j = pJ[q]!
        const dx = x[i]! - x[j]!
        const dy = y[i]! - y[j]!
        const d2 = dx * dx + dy * dy
        if (d2 >= h2 || d2 < 1e-14) continue
        const w = 1 - Math.sqrt(d2) / h
        const e = 0.5 * (eps[i]! + eps[j]!)
        const dvxP = e * (vx[j]! - vx[i]!) * w
        const dvyP = e * (vy[j]! - vy[i]!) * w
        dvx[i]! += dvxP
        dvy[i]! += dvyP
        dvx[j]! -= dvxP
        dvy[j]! -= dvyP
        wsum[i]! += e * w
        wsum[j]! += e * w
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
   * Hydrostatic pressure p = ρ g (h − s) integrated over the **wetted** boundary of each
   * dynamic body (s = height along −ĝ, h = head of the water touching that boundary).
   *
   * - A boundary piece is wet only if particles sit next to it, so a dry body near water
   *   (or behind a wall) gets nothing.
   * - Head: the connected column of particles above the piece. Side / bottom pieces also
   *   see `dBody`, the highest head of water touching the body's non-upward faces: under a
   *   floating body there is no column, the pressure comes from the water around it.
   *   Upward faces use only their own column, so a film riding on the roof pushes down
   *   by its own (tiny) depth and cannot levitate the body.
   * - A closed wetted contour gives exactly Archimedes; water held in a cup pushes its
   *   bottom down and its walls out, so the container carries the water's weight.
   *
   * Returns ids that touched water so splash impulses can stay off at rest.
   */
  private applyBuoyancy(world: PhysicsWorld, bodies: readonly SceneBody[]): Set<BodyId> {
    this.buoyancyDebug.length = 0
    const buoyant = new Set<BodyId>()
    const g = world.gravity
    const gmag = Math.hypot(g.x, g.y)
    if (gmag < 1e-8 || this.n === 0) return buoyant
    const nx = -g.x / gmag
    const ny = -g.y / gmag
    const tx = -ny
    const ty = nx
    const sp = this.spacing
    const wetR = this.radius + sp * WET_REACH
    const colHalf = sp * COLUMN_HALF_WIDTH
    const gap = sp * COLUMN_GAP
    const segLen = sp * SAMPLE_SPACING
    const gScaleOf = new Map(bodies.map((b) => [b.id, b.gravityScale]))
    const seen = new Set<BodyId>()
    const bandS: number[] = []
    const bandT: number[] = []
    const bandI: number[] = []
    const order: number[] = []
    const near: number[] = []

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
          polys.push(ensureCCW(verts))
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

      // Band: the body's tangent span (± wet reach), any height from just below it up.
      // `near`: band particles close enough to wet some part of the boundary.
      bandS.length = 0
      bandT.length = 0
      bandI.length = 0
      near.length = 0
      for (let i = 0; i < this.n; i++) {
        const px = this.x[i]!
        const py = this.y[i]!
        const t = px * tx + py * ty
        if (t < tMin - wetR || t > tMax + wetR) continue
        const s = px * nx + py * ny
        if (s < sMin - wetR) continue
        bandI.push(i)
        bandS.push(s)
        bandT.push(t)
        if (s <= sMax + wetR) near.push(i)
      }
      if (near.length < 2) return
      order.length = bandI.length
      for (let k = 0; k < order.length; k++) order[k] = k
      order.sort((a, b) => bandS[a]! - bandS[b]!)

      const rCol = this.radius
      /** Particle i lies on the outer side of the face through (qx, qy) with normal m. */
      const outside = (i: number, qx: number, qy: number, mx: number, my: number) =>
        (this.x[i]! - qx) * mx + (this.y[i]! - qy) * my >= -rCol

      /**
       * Top of the connected particle column above a boundary piece, counting only
       * particles on the outer side of its face (a side column must not climb onto the
       * film riding on the roof), or null if none.
       */
      const columnHead = (
        s: number,
        t: number,
        qx: number,
        qy: number,
        mx: number,
        my: number,
      ): number | null => {
        let level = s
        let found = false
        for (const k of order) {
          if (Math.abs(bandT[k]! - t) > colHalf) continue
          const sk = bandS[k]!
          if (sk < s - wetR) continue
          if (!outside(bandI[k]!, qx, qy, mx, my)) continue
          if (sk - level > gap) break
          if (sk > level) level = sk
          found = true
        }
        return found ? level : null
      }

      // Head of the water around the body: the connected column just outside each flank,
      // climbed from below the body's base. Not the body's own faces: under a body there is
      // no column (and particles squeezed into the floor would read 0), and a column over
      // the roof is only the riding film.
      const flankHead = (t: number): number | null => {
        let level = sMin - wetR
        let found = false
        for (const k of order) {
          if (Math.abs(bandT[k]! - t) > colHalf) continue
          const sk = bandS[k]!
          if (sk < sMin - wetR) continue
          if (sk - level > gap) break
          if (sk > level) level = sk
          found = true
        }
        return found && level > sMin ? level : null
      }
      const leftHead = flankHead(tMin - sp)
      const rightHead = flankHead(tMax + sp)
      const dBody =
        leftHead !== null && rightHead !== null
          ? (leftHead + rightHead) / 2
          : (leftHead ?? rightHead ?? -Infinity)

      // Water on both flanks: the body floats or is submerged, so the closed-contour
      // Archimedes model (calibrated, smoothed) applies. Pressure on the wetted faces is
      // for the rest: containers, one-sided walls and dry bodies next to water.
      // Hysteresis: a float stays in this model while one flank dips dry for a moment
      // (sloshing); switching models every few steps kicks the body and pumps the water.
      const both = leftHead !== null && rightHead !== null
      const held = this.floatHold.get(body.id)
      if (both) this.floatHold.set(body.id, 0)
      else if (held !== undefined && held < FLOAT_HOLD_STEPS) this.floatHold.set(body.id, held + 1)
      else this.floatHold.delete(body.id)
      if (this.floatHold.has(body.id)) {
        this.applyArchimedes(
          world,
          body,
          colliders,
          polys,
          { tMin, tMax, sMin, sMax },
          gScaleOf.get(body.id) ?? 1,
          seen,
          buoyant,
        )
        return
      }

      type Piece = {
        qx: number
        qy: number
        s: number
        t: number
        mx: number
        my: number
        len: number
      }
      const wet: (Piece & { head: number | null; upward: boolean })[] = []
      const wetR2 = wetR * wetR
      for (const poly of polys) {
        const m = poly.length
        for (let e = 0; e < m; e++) {
          const a = poly[e]!
          const b = poly[(e + 1) % m]!
          const ex = b.x - a.x
          const ey = b.y - a.y
          const len = Math.hypot(ex, ey)
          if (len < 1e-9) continue
          // Outward normal of a CCW polygon.
          const mx = ey / len
          const my = -ex / len
          const pieces = Math.max(1, Math.ceil(len / segLen))
          const pl = len / pieces
          for (let k = 0; k < pieces; k++) {
            const f = (k + 0.5) / pieces
            const qx = a.x + ex * f
            const qy = a.y + ey * f
            let isWet = false
            for (const i of near) {
              const dx = this.x[i]! - qx
              const dy = this.y[i]! - qy
              // Outer side only: water behind a thin wall must not wet its far face.
              if (dx * dx + dy * dy < wetR2 && dx * mx + dy * my >= -rCol) {
                isWet = true
                break
              }
            }
            const s = qx * nx + qy * ny
            const t = qx * tx + qy * ty
            if (!isWet) continue
            wet.push({
              qx,
              qy,
              s,
              t,
              mx,
              my,
              len: pl,
              head: columnHead(s, t, qx, qy, mx, my),
              upward: mx * nx + my * ny > UPWARD_FACE,
            })
          }
        }
      }
      if (!wet.length) return

      let densSum = 0
      let viscSum = 0
      for (const i of near) {
        densSum += this.density[i]!
        viscSum += this.viscosity[i]!
      }
      const ρ = densSum / near.length
      const μ = viscSum / near.length
      const gEff = gmag * (gScaleOf.get(body.id) ?? 1)

      let fxP = 0
      let fyP = 0
      let tauP = 0
      let surface = -Infinity
      for (const w of wet) {
        const h = w.upward ? (w.head ?? -Infinity) : Math.max(w.head ?? -Infinity, dBody)
        if (h > surface) surface = h
        if (!(h > w.s)) continue
        const p = ρ * gEff * (h - w.s)
        const dfx = -p * w.mx * w.len
        const dfy = -p * w.my * w.len
        fxP += dfx
        fyP += dfy
        tauP += (w.qx - body.comX) * dfy - (w.qy - body.comY) * dfx
      }
      if (!Number.isFinite(surface)) return

      // Submerged part (below the highest wetting head) for drag and the debug centroid.
      let area = 0
      let cx = 0
      let cy = 0
      let clippedForDrag: Vec2[] = []
      for (const verts of polys) {
        const clipped = clipHalfPlane(verts, nx, ny, surface)
        const a = polygonArea(clipped)
        if (a < 1e-8) continue
        const c = polygonCentroid(clipped)
        cx += c.x * a
        cy += c.y * a
        area += a
        if (clipped.length > clippedForDrag.length) clippedForDrag = clipped
      }
      if (area > 1e-8) {
        cx /= area
        cy /= area
      } else {
        cx = body.comX
        cy = body.comY
      }

      const drag =
        area > 1e-8
          ? fluidDragForce(body.vx, body.vy, ρ, μ, clippedForDrag, area, {
              inertia: body.mass,
              dt: world.dt,
            })
          : { x: 0, y: 0 }
      const torqueDamp =
        area > 1e-8
          ? fluidTorqueDamp(ρ, area, body.omega, { inertia: body.inertia, dt: world.dt })
          : 0
      // Pressure resultant through the COM; its moment goes in as a torque. No lag and no
      // velocity scaling: a lagged force pumps energy, and these bodies (containers,
      // one-sided walls) are not floats to be settled.
      world.applyForce(body.id, fxP + drag.x, fyP + drag.y, { x: body.comX, y: body.comY }, false)
      world.applyTorque(body.id, tauP + torqueDamp, false)
      seen.add(body.id)
      buoyant.add(body.id)
      this.buoyancyDebug.push({
        bodyId: body.id,
        area,
        cx,
        cy,
        fx: fxP + drag.x,
        fy: fyP + drag.y,
      })
    })
    for (const id of [...this.surfaceD.keys()]) {
      if (!seen.has(id)) this.surfaceD.delete(id)
    }
    for (const id of [...this.floatHold.keys()]) {
      if (!seen.has(id)) this.floatHold.delete(id)
    }
    return buoyant
  }

  /**
   * Archimedes for a body with water on both flanks (floating or submerged): clip it at
   * a free surface estimated from the flanks, never from its own column, since water
   * riding on top would otherwise report it fully submerged and levitate it. This is the
   * calibrated model the floating tests and the rest heuristics are tuned against.
   */
  private applyArchimedes(
    world: PhysicsWorld,
    body: BodySnapshot,
    colliders: ColliderDesc[],
    polys: Vec2[][],
    bounds: { tMin: number; tMax: number; sMin: number; sMax: number },
    gScale: number,
    seen: Set<BodyId>,
    buoyant: Set<BodyId>,
  ): void {
    const { tMin, tMax, sMin, sMax } = bounds
    const g = world.gravity
    const gmag = Math.hypot(g.x, g.y)
    const gx = g.x / gmag
    const gy = g.y / gmag
    const nx = -gx
    const ny = -gy
    const tx = -ny
    const ty = nx
    const colW = Math.max(this.spacing, 0.06)
    const contactR = this.radius
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
      return
    }
    const prevD = this.surfaceD.get(body.id)
    const blend = prevD === undefined ? 1 : Math.abs(clipDRaw - prevD) > 0.3 ? 0.45 : SURFACE_BLEND
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

    // No lag on the lift: a lagged restoring force feeds energy into the bobbing (the old
    // EMA kept floats oscillating). Heave and roll damping come from wave radiation, as in
    // the analytic tank; they only see velocities, so the equilibrium draft is unchanged.
    const F = ρ * area * gmag * gScale
    const weight = Math.max(1e-6, body.mass * gmag)
    let waterline = 0
    for (const verts of polys) waterline += planeSpan(verts, nx, ny, clipD)
    const wave = waveRadiationForce(
      body.vx,
      body.vy,
      nx,
      ny,
      ρ,
      gmag * gScale,
      waterline,
      body.mass,
      world.dt,
      SPH_HEAVE_DAMPING,
    )
    const fx = -gx * F + wave.x
    const fy = -gy * F + wave.y
    const drag = fluidDragForce(body.vx, body.vy, ρ, μ, clippedForDrag, area, {
      inertia: body.mass,
      dt: world.dt,
    })
    const torqueDamp = fluidTorqueDamp(ρ, area, body.omega, {
      inertia: body.inertia,
      dt: world.dt,
    })
    // Always through the centre of buoyancy: that moment is what rights a tilted float.
    world.applyForce(body.id, fx + drag.x, fy + drag.y, { x: cx, y: cy }, false)
    // Roll radiation damping: a fraction of critical against the waterplane roll stiffness
    // k = ρ g w³ / 12 (2D), capped like `stableDamping` so it never reverses ω.
    const kRoll = (ρ * gmag * gScale * waterline ** 3) / 12
    const cRoll =
      kRoll > 0 && body.inertia > 0 ? 2 * SPH_ROLL_DAMPING * Math.sqrt(kRoll * body.inertia) : 0
    const roll = -Math.min(cRoll, body.inertia / world.dt) * body.omega
    world.applyTorque(body.id, torqueDamp + roll, false)
    seen.add(body.id)
    buoyant.add(body.id)
    // Wake a sunk floater so Archimedes can lift it; do not wake wet walls (lift ≪ mg).
    const liftRatio = F / weight
    if (liftRatio > 0.35 && Math.abs(F - weight) / weight > 0.5) world.wake(body.id)
    this.buoyancyDebug.push({
      bodyId: body.id,
      area,
      cx,
      cy,
      fx: fx + drag.x,
      fy: fy + drag.y,
    })
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
    this.xsphEps = new Float64Array(next)
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

/**
 * Returns the spacing actually used: coarsening to fit PBF_MAX_PARTICLES must also drive
 * h and ρ0, or the sparser seed reads as under-dense and collapses. With `fixedSpacing`
 * (particles already live) there is no coarsening; the seed is truncated instead.
 */
function seedVolume(
  vol: SceneFluidVolume,
  already: number,
  world: PhysicsWorld | null | undefined,
  fixedSpacing: number | null,
): { seeds: Seed[]; spacing: number; truncated: number } {
  const mat = getFluid(vol.materialId)
  let spacing = fixedSpacing ?? (vol.spacing > 0 ? vol.spacing : PBF_DEFAULT_SPACING)
  let filled = fillPolygon(vol.polygon, spacing)
  while (fixedSpacing === null && already + filled.length > PBF_MAX_PARTICLES && spacing < 0.5) {
    spacing *= 1.25
    filled = fillPolygon(vol.polygon, spacing)
  }
  const room = PBF_MAX_PARTICLES - already
  const margin = spacing * 0.55
  const amp = spacing * 0.12
  let rng = hashVolumeId(vol.id)
  const out: Seed[] = []
  let i = 0
  for (; i < filled.length && out.length < room; i++) {
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
  // Seeds that did not fit the particle budget: water the user asked for and did not get.
  return { seeds: out, spacing, truncated: filled.length - i }
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
