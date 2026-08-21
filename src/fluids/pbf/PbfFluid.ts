import type { Vec2 } from '../../core/math/vec2.ts'
import { pointInPolygon } from '../../core/math/polygon.ts'
import type { SceneFluidVolume } from '../../scene/document.ts'
import { getFluid } from '../../materials/catalog.ts'
import type { BodyId } from '../../core/ids.ts'
import type { ColliderDesc, PhysicsShape, PhysicsWorld } from '../../physics/ports.ts'

/** Snapshot particle for render / HUD (plain data, no solver internals). */
export type FluidParticle = {
  x: number
  y: number
  vx: number
  vy: number
  volumeId: string
  color: number
  opacity: number
}

export const PBF_DEFAULT_SPACING = 0.1
export const PBF_MAX_PARTICLES = 2200

const SOLVER_ITERS = 2
const OVERLAP_PASSES = 2
const CULL_Y = -40
const COUPLING = 0.1
const V_MAX = 8
/** Cap total impulse applied to one dynamic body per step (avoids explosions). */
const MAX_BODY_IMPULSE = 1.8
/** Max center-distance correction per overlap pair (keeps confined piles stable). */
const MAX_PAIR_PUSH = 0.22
/** Max solid push absorbed without becoming fake velocity (stops wall jets). */
const MAX_SOLID_CORR = 0.08
const VISC_BLEND = 0.12

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
 * Soft-sphere particle fluid: unilateral overlap (push apart only) + viscosity.
 * Particles can separate freely so gravity collapses blobs into pools that spread
 * inside containers. Named under the PBF path from the feasibility plan.
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
  private n = 0
  private cap = 0
  /** Minimum center distance when overlapping — smaller than seed spacing so gravity can pack. */
  private diameter = PBF_DEFAULT_SPACING * 0.52
  private radius = PBF_DEFAULT_SPACING * 0.32
  /** Area represented by one particle (spacing²) for Archimedes. */
  private particleArea = PBF_DEFAULT_SPACING * PBF_DEFAULT_SPACING

  /** Last buoyancy samples (for tests / debug HUD). */
  readonly buoyancyDebug: {
    bodyId: string
    area: number
    cx: number
    cy: number
    fx: number
    fy: number
  }[] = []

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
    this.diameter = spacing * 0.52
    this.radius = spacing * 0.32
    this.particleArea = spacing * spacing
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
      }
      w++
    }
    this.n = w
    this.syncSnapshot()
  }

  step(world: PhysicsWorld, dt: number): void {
    if (this.n === 0) return
    const g = world.gravity
    const diam = this.diameter
    const diam2 = diam * diam
    const cell = diam
    const invCell = 1 / cell
    const bodyImpulse = new Map<BodyId, { x: number; y: number; jx: number; jy: number }>()
    // Solid corrections must NOT become velocity — that created the horizontal jets.
    const solidDx = new Float64Array(this.n)
    const solidDy = new Float64Array(this.n)

    for (let i = 0; i < this.n; i++) {
      this.vx[i]! += g.x * dt
      this.vy[i]! += g.y * dt
      this.vx[i]! *= 0.998
      this.vy[i]! *= 0.998
      let dx = this.vx[i]! * dt
      let dy = this.vy[i]! * dt
      // Clamp sideways more than fall — thin walls vs free-fall packing.
      const maxH = diam * 0.45
      const maxV = Math.max(diam * 0.9, 0.12)
      if (Math.abs(dx) > maxH) dx = Math.sign(dx) * maxH
      if (Math.abs(dy) > maxV) dy = Math.sign(dy) * maxV
      this.vx[i] = dx / dt
      this.vy[i] = dy / dt
      this.px[i] = this.x[i]! + dx
      this.py[i] = this.y[i]! + dy
    }

    const key = (cx: number, cy: number) => ((cx * 73856093) ^ (cy * 19349663)) | 0

    for (let iter = 0; iter < SOLVER_ITERS; iter++) {
      const buckets = new Map<number, number[]>()
      for (let i = 0; i < this.n; i++) {
        const cx = Math.floor(this.px[i]! * invCell)
        const cy = Math.floor(this.py[i]! * invCell)
        const k = key(cx, cy)
        let list = buckets.get(k)
        if (!list) {
          list = []
          buckets.set(k, list)
        }
        list.push(i)
      }

      for (let pass = 0; pass < OVERLAP_PASSES; pass++) {
        for (let i = 0; i < this.n; i++) {
          const cx = Math.floor(this.px[i]! * invCell)
          const cy = Math.floor(this.py[i]! * invCell)
          for (let ox = -1; ox <= 1; ox++) {
            for (let oy = -1; oy <= 1; oy++) {
              const list = buckets.get(key(cx + ox, cy + oy))
              if (!list) continue
              for (const j of list) {
                if (j <= i) continue
                const dx = this.px[i]! - this.px[j]!
                const dy = this.py[i]! - this.py[j]!
                const d2 = dx * dx + dy * dy
                if (d2 >= diam2 || d2 < 1e-14) continue
                const d = Math.sqrt(d2)
                let pen = (diam - d) * 0.35
                if (pen > diam * MAX_PAIR_PUSH) pen = diam * MAX_PAIR_PUSH
                const nx = dx / d
                const ny = dy / d
                this.px[i]! += nx * pen
                this.py[i]! += ny * pen
                this.px[j]! -= nx * pen
                this.py[j]! -= ny * pen
              }
            }
          }
        }
        for (let i = 0; i < this.n; i++) {
          const bx = this.px[i]!
          const by = this.py[i]!
          collideSolid(this.px, this.py, i, this.radius, world, bodyImpulse, this.x[i]!, this.y[i]!)
          solidDx[i]! += this.px[i]! - bx
          solidDy[i]! += this.py[i]! - by
        }
      }
    }

    for (let i = 0; i < this.n; i++) {
      // Exclude wall push-out from velocity — otherwise sticks launch horizontal jets.
      let sx = solidDx[i]!
      let sy = solidDy[i]!
      const sc = Math.hypot(sx, sy)
      if (sc > MAX_SOLID_CORR) {
        const s = MAX_SOLID_CORR / sc
        sx *= s
        sy *= s
      }
      this.vx[i] = (this.px[i]! - sx - this.x[i]!) / dt
      this.vy[i] = (this.py[i]! - sy - this.y[i]!) / dt
      // Friction against the contact: damp velocity along the solid normal.
      if (sc > 1e-8) {
        const nx = solidDx[i]! / sc
        const ny = solidDy[i]! / sc
        const vn = this.vx[i]! * nx + this.vy[i]! * ny
        // Remove remaining inbound component; keep most of tangential with friction.
        if (vn < 0) {
          this.vx[i]! -= vn * nx
          this.vy[i]! -= vn * ny
        }
        const vt = this.vx[i]! * -ny + this.vy[i]! * nx
        const vtf = vt * 0.92
        this.vx[i] = this.vx[i]! - (-ny) * vt + (-ny) * vtf
        this.vy[i] = this.vy[i]! - nx * vt + nx * vtf
      }
      const sp = Math.hypot(this.vx[i]!, this.vy[i]!)
      if (sp > V_MAX) {
        const s = V_MAX / sp
        this.vx[i]! *= s
        this.vy[i]! *= s
      }
      this.x[i] = this.px[i]!
      this.y[i] = this.py[i]!
    }

    // Viscosity: blend velocities with nearby particles.
    const buckets = new Map<number, number[]>()
    for (let i = 0; i < this.n; i++) {
      const cx = Math.floor(this.x[i]! * invCell)
      const cy = Math.floor(this.y[i]! * invCell)
      const k = key(cx, cy)
      let list = buckets.get(k)
      if (!list) {
        list = []
        buckets.set(k, list)
      }
      list.push(i)
    }
    const ovx = this.vx.slice()
    const ovy = this.vy.slice()
    const viscR = diam * 1.5
    for (let i = 0; i < this.n; i++) {
      let ax = 0
      let ay = 0
      let wsum = 0
      const cx = Math.floor(this.x[i]! * invCell)
      const cy = Math.floor(this.y[i]! * invCell)
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const list = buckets.get(key(cx + ox, cy + oy))
          if (!list) continue
          for (const j of list) {
            if (j === i) continue
            const dx = this.x[i]! - this.x[j]!
            const dy = this.y[i]! - this.y[j]!
            const d = Math.hypot(dx, dy)
            if (d > viscR || d < 1e-12) continue
            const w = 1 - d / viscR
            ax += (ovx[j]! - ovx[i]!) * w
            ay += (ovy[j]! - ovy[i]!) * w
            wsum += w
          }
        }
      }
      if (wsum > 0) {
        this.vx[i]! += (ax / wsum) * VISC_BLEND
        this.vy[i]! += (ay / wsum) * VISC_BLEND
      }
    }

    for (const [id, imp] of bodyImpulse) {
      const body = world.getBody(id)
      if (!body || body.type !== 'dynamic') continue
      let jx = imp.jx * COUPLING
      let jy = imp.jy * COUPLING
      const mag = Math.hypot(jx, jy)
      if (mag > MAX_BODY_IMPULSE) {
        const s = MAX_BODY_IMPULSE / mag
        jx *= s
        jy *= s
      }
      world.applyImpulse(id, jx, jy, { x: imp.x, y: imp.y })
      world.wake(id)
    }

    this.applyBuoyancy(world)
    this.cullFallen()
    this.syncSnapshot()
  }

  /**
   * Archimedes from particles in an expanded body neighbourhood (shell around the
   * collider). Free-surface clipping launched bodies when splash raised the surface;
   * overlap-only was too weak. The shell gives a stable displaced-area proxy.
   */
  private applyBuoyancy(world: PhysicsWorld): void {
    this.buoyancyDebug.length = 0
    const g = world.gravity
    const gmag = Math.hypot(g.x, g.y)
    if (gmag < 1e-8 || this.n === 0) return
    const gx = g.x / gmag
    const gy = g.y / gmag
    const shell = Math.max(this.diameter * 1.8, 0.16)
    const searchR = 2.0
    const searchR2 = searchR * searchR

    world.forEachBody((body) => {
      if (body.type !== 'dynamic') return
      const colliders = world.getColliders(body.id)
      if (!colliders.length) return

      let count = 0
      let sx = 0
      let sy = 0
      let densSum = 0
      let viscSum = 0
      for (let i = 0; i < this.n; i++) {
        const px = this.x[i]!
        const py = this.y[i]!
        const dx = px - body.x
        const dy = py - body.y
        if (dx * dx + dy * dy > searchR2) continue
        if (!particleInBodyShell(px, py, shell, body, colliders)) continue
        count++
        sx += px
        sy += py
        densSum += this.density[i]!
        viscSum += this.viscosity[i]!
      }
      if (count < 4) return

      const ρ = densSum / count
      const μ = viscSum / count
      const bodyArea = Math.max(1e-4, approxBodyArea(colliders))
      let area = count * this.particleArea
      // Shell overcounts; scale so a fully surround body ≈ bodyArea.
      area = Math.min(bodyArea, area * 0.65)

      const mass = Math.max(1e-3, body.mass)
      let F = ρ * area * gmag
      const Fmax = 1.75 * mass * gmag
      if (F > Fmax) F = Fmax

      // Kill upward force when already rising out of the fluid.
      const upVel = -gx * body.vx - gy * body.vy
      if (upVel > 0.2) F *= 1 / (1 + 2.5 * upVel)

      const cx = sx / count
      const cy = sy / count
      const fx = -gx * F
      const fy = -gy * F
      const speed = Math.hypot(body.vx, body.vy)
      const charLen = Math.sqrt(area)
      const quad = 0.8 * ρ * charLen * speed
      const stokes = 8 * Math.PI * Math.max(μ, 0.001)
      world.applyForce(
        body.id,
        fx - (quad + stokes) * body.vx,
        fy - (quad + stokes) * body.vy,
        { x: cx, y: cy },
      )
      world.applyTorque(body.id, -body.omega * ρ * area * 0.2)
      world.wake(body.id)
      this.buoyancyDebug.push({
        bodyId: body.id,
        area,
        cx,
        cy,
        fx: fx - (quad + stokes) * body.vx,
        fy: fy - (quad + stokes) * body.vy,
      })
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
    nx.set(this.x.subarray(0, this.n))
    ny.set(this.y.subarray(0, this.n))
    npx.set(this.px.subarray(0, this.n))
    npy.set(this.py.subarray(0, this.n))
    nvx.set(this.vx.subarray(0, this.n))
    nvy.set(this.vy.subarray(0, this.n))
    nd.set(this.density.subarray(0, this.n))
    nmu.set(this.viscosity.subarray(0, this.n))
    this.x = nx
    this.y = ny
    this.px = npx
    this.py = npy
    this.vx = nvx
    this.vy = nvy
    this.density = nd
    this.viscosity = nmu
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
  const out: Seed[] = []
  for (let i = 0; i < filled.length && out.length < room; i++) {
    const p = filled[i]!
    if (world && pointOverlapsSolid(world, p.x, p.y, margin)) continue
    out.push({
      x: p.x,
      y: p.y,
      volumeId: vol.id,
      color: mat.color,
      opacity: mat.opacity,
      density: mat.density,
      viscosity: mat.viscosity,
    })
  }
  return out
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

function approxBodyArea(colliders: ColliderDesc[]): number {
  let a = 0
  for (const col of colliders) {
    if (col.isSensor) continue
    const s = col.shape
    if (s.kind === 'circle') a += Math.PI * s.radius * s.radius
    else if (s.kind === 'box') a += 4 * s.hx * s.hy
    else if (s.kind === 'capsule') {
      a += 4 * s.radius * s.halfHeight + Math.PI * s.radius * s.radius
    } else if (s.kind === 'convex') {
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const p of s.vertices) {
        if (p.x < minX) minX = p.x
        if (p.y < minY) minY = p.y
        if (p.x > maxX) maxX = p.x
        if (p.y > maxY) maxY = p.y
      }
      a += Math.max(0, maxX - minX) * Math.max(0, maxY - minY)
    }
  }
  return a
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

function collideSolid(
  px: Float64Array,
  py: Float64Array,
  i: number,
  radius: number,
  world: PhysicsWorld,
  bodyImpulse: Map<BodyId, { x: number; y: number; jx: number; jy: number }>,
  fromX: number,
  fromY: number,
): void {
  let x = px[i]!
  let y = py[i]!

  world.forEachBody((body) => {
    const colliders = world.getColliders(body.id)
    for (const col of colliders) {
      if (col.isSensor) continue
      const shape = col.shape
      const ox = body.x + (col.offset?.x ?? 0)
      const oy = body.y + (col.offset?.y ?? 0)
      const ang = body.angle + (col.angle ?? 0)
      const hit = pushOutOfShape(x, y, radius, shape, ox, oy, ang, fromX, fromY)
      if (!hit) continue
      const jx = x - hit.x
      const jy = y - hit.y
      x = hit.x
      y = hit.y
      accumulateImpulse(bodyImpulse, body.id, hit.cx, hit.cy, jx, jy)
    }
  })

  px[i] = x
  py[i] = y
}

function pushOutOfShape(
  x: number,
  y: number,
  radius: number,
  shape: PhysicsShape,
  ox: number,
  oy: number,
  ang: number,
  fromX?: number,
  fromY?: number,
): { x: number; y: number; cx: number; cy: number } | null {
  const c = Math.cos(ang)
  const s = Math.sin(ang)
  const lx = (x - ox) * c + (y - oy) * s
  const ly = -(x - ox) * s + (y - oy) * c
  const flx =
    fromX === undefined || fromY === undefined ? lx : (fromX - ox) * c + (fromY - oy) * s
  const fly =
    fromX === undefined || fromY === undefined ? ly : -(fromX - ox) * s + (fromY - oy) * c

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

  return null
}

function accumulateImpulse(
  map: Map<BodyId, { x: number; y: number; jx: number; jy: number }>,
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
