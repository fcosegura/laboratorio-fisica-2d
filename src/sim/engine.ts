import type { BodyId } from '../core/ids.ts'
import { PHYSICS_DT } from '../core/constants.ts'
import type { Vec2 } from '../core/math/vec2.ts'
import { RapierWorld } from '../physics/adapters/rapier/RapierWorld.ts'
import { loadRapier } from '../physics/adapters/rapier/loadRapier.ts'
import type { BodySnapshot, PhysicsContact, PhysicsWorld } from '../physics/ports.ts'
import { bodyToDesc, buildWorld } from '../scene/builder.ts'
import { jointToDesc, reattachJoints } from '../scene/joints.ts'
import {
  cloneDocument,
  DEFAULT_AIR_DENSITY,
  DEFAULT_GRAVITY_G,
  type SceneBody,
  type SceneDocument,
  type SceneFan,
} from '../scene/document.ts'
import { fanInWorld } from '../scene/fans.ts'
import { pickBody } from '../scene/picking.ts'
import { AnalyticFluidSolver } from '../fluids/analytic/AnalyticFluid.ts'
import { PbfFluidSolver } from '../fluids/pbf/PbfFluid.ts'
import { Clock } from './clock.ts'
import {
  FAN_WATER_RATE,
  fanForce,
  fanParticlePush,
  gravityPull,
  shapeArea,
  thrusterActive,
  thrusterWorld,
  windForce,
} from './forces.ts'
import { DataRecorder } from './recorder.ts'

export type AppliedForce = {
  bodyId: BodyId
  x: number
  y: number
  fx: number
  fy: number
}

/** Grab spring natural frequency (rad/s): ~1.3 Hz, ω₀·dt ≈ 0.13 keeps explicit damping stable. */
const GRAB_OMEGA = 8
/** Cap on grab acceleration (m/s²) so a body pinned behind a wall cannot explode. */
const GRAB_MAX_ACCEL = 150
/** Trail sample every N physics steps, keeping the last TRAIL_POINTS (10 s at 60 Hz / 2). */
const TRAIL_EVERY = 2
const TRAIL_POINTS = 300

/** SceneBody fields baked into Rapier colliders / mass properties: changing one rebuilds. */
const REBUILD_KEYS: ReadonlySet<keyof SceneBody> = new Set<keyof SceneBody>([
  'density',
  'mass',
  'massMode',
  'friction',
  'restitution',
  'shape',
  'materialId',
  'linearDamping',
  'angularDamping',
  'ccd',
  'lockRotation',
  'locked',
])

/** Structural equality for plain JSON document values. */
function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

export class SimulationEngine {
  doc: SceneDocument
  world: PhysicsWorld | null = null
  readonly clock = new Clock()
  readonly recorder = new DataRecorder()
  readonly fluids = new AnalyticFluidSolver()
  readonly particles = new PbfFluidSolver()
  prev: BodySnapshot[] = []
  curr: BodySnapshot[] = []
  private prevMap = new Map<BodyId, BodySnapshot>()
  private currMap = new Map<BodyId, BodySnapshot>()
  contacts: PhysicsContact[] = []
  appliedForces: AppliedForce[] = []
  /** Forces re-applied every physics step (sustained force tool). */
  persistentForces: AppliedForce[] = []
  /** Play-mode drag: target for the body origin, spring recomputed every step. */
  grab: { bodyId: BodyId; targetX: number; targetY: number } | null = null
  /** COM trail per dynamic body, flat [x0, y0, x1, y1, …], oldest first. */
  readonly trails = new Map<BodyId, number[]>()
  private trailTick = 0
  timings = { physics: 0, fluids: 0, steps: 0 }
  private reloadQueue: Promise<void> = Promise.resolve()

  constructor(doc: SceneDocument) {
    this.doc = cloneDocument(doc)
  }

  /** Build the Rapier world. If `isCurrent` returns false after WASM load, skip rebuild
   * so a superseded mount (e.g. React Strict Mode) cannot destroy a newer session's world. */
  async init(isCurrent?: () => boolean): Promise<void> {
    const R = await loadRapier()
    if (isCurrent && !isCurrent()) return
    this.rebuild(R)
  }

  private rebuild(R?: Awaited<ReturnType<typeof loadRapier>>): void {
    this.world?.destroy()
    if (!R) {
      throw new Error('Rapier no está inicializado')
    }
    this.world = new RapierWorld(R, this.doc.world.gravity, PHYSICS_DT)
    buildWorld(this.world, this.doc)
    this.clock.reset()
    this.clock.timeScale = this.doc.world.timeScale
    this.recorder.clear()
    this.prev = []
    this.curr = []
    this.prevMap.clear()
    this.currMap.clear()
    this.world.writeBodies(this.curr)
    this.syncCurrMap()
    this.prev = this.curr.map((b) => ({ ...b }))
    for (const b of this.prev) this.prevMap.set(b.id, b)
    this.contacts = []
    this.appliedForces.length = 0
    this.grab = null
    this.clearTrails()
    this.particles.rebuild(this.doc.fluidVolumes, this.world)
  }

  /**
   * Push authored changes of one body into the live world. Pose / velocity keys are applied
   * one by one (editing x during Play must not restore y or angle); collider / mass keys
   * rebuild the Rapier body at its live pose and reattach its joints.
   */
  applyBodyChange(body: SceneBody, keys: readonly (keyof SceneBody)[]): void {
    const world = this.world
    if (!world) return
    const has = (k: keyof SceneBody) => keys.includes(k)
    const live = world.getBody(body.id)
    const x = has('x') || !live ? body.x : live.x
    const y = has('y') || !live ? body.y : live.y
    const angle = has('angle') || !live ? body.angle : live.angle
    const vx = has('vx') || !live ? body.vx : live.vx
    const vy = has('vy') || !live ? body.vy : live.vy
    const omega = has('omega') || !live ? body.omega : live.omega
    if (!live || keys.some((k) => REBUILD_KEYS.has(k))) {
      const desc = bodyToDesc(body)
      desc.translation = { x, y }
      desc.rotation = angle
      desc.linvel = { x: vx, y: vy }
      desc.angvel = omega
      world.addBody(desc) // replaces an existing id (drops its joints)
      reattachJoints(world, this.doc, body.id)
      return
    }
    if (has('x') || has('y') || has('angle')) world.setTransform(body.id, x, y, angle)
    if (has('vx') || has('vy') || has('omega')) world.setVelocity(body.id, vx, vy, omega)
    if (has('gravityScale')) world.setGravityScale(body.id, body.gravityScale)
    if (has('type')) world.setBodyType(body.id, body.type)
  }

  /**
   * Bring the live world from `prev` to `next` (undo / redo) without a full rebuild: keeps
   * simTime, recorder series, particles and the motion of every body the change did not touch.
   */
  syncWorld(prev: SceneDocument, next: SceneDocument): void {
    const world = this.world
    if (!world) {
      void this.reload(next)
      return
    }
    if (!sameValue(prev.world.gravity, next.world.gravity)) world.setGravity(next.world.gravity)
    if (prev.world.timeScale !== next.world.timeScale) {
      this.clock.timeScale = next.world.timeScale
    }

    const prevBodies = new Map(prev.bodies.map((b) => [b.id, b]))
    const nextIds = new Set(next.bodies.map((b) => b.id))
    for (const b of prev.bodies) {
      if (nextIds.has(b.id)) continue
      world.removeBody(b.id)
      this.trails.delete(b.id)
      if (this.grab?.bodyId === b.id) this.grab = null
      this.persistentForces = this.persistentForces.filter((f) => f.bodyId !== b.id)
    }
    for (const b of next.bodies) {
      const before = prevBodies.get(b.id)
      if (!before) {
        world.addBody(bodyToDesc(b))
        continue
      }
      const keys = (Object.keys(b) as (keyof SceneBody)[]).filter(
        (k) => !sameValue(before[k], b[k]),
      )
      if (keys.length) this.applyBodyChange(b, keys)
    }

    const prevJoints = new Map(prev.joints.map((j) => [j.id, j]))
    const nextJointIds = new Set(next.joints.map((j) => j.id))
    for (const j of prev.joints) {
      if (!nextJointIds.has(j.id)) world.removeJoint(j.id)
    }
    for (const j of next.joints) {
      const before = prevJoints.get(j.id)
      if (before && !sameValue(before, j)) world.removeJoint(j.id)
      // No-op when the joint is already live; recreates joints dropped by a body rebuild.
      world.addJoint(jointToDesc(j))
    }

    const volumeIds = new Set(next.fluidVolumes.map((v) => v.id))
    if (prev.fluidVolumes.some((v) => !volumeIds.has(v.id))) {
      this.particles.retainVolumes(volumeIds)
    }
    const prevVolumeIds = new Set(prev.fluidVolumes.map((v) => v.id))
    for (const v of next.fluidVolumes) {
      if (!prevVolumeIds.has(v.id)) this.particles.addVolume(v, world)
    }
    // Analytic tanks are read from the document every step; drop stale fill samples.
    this.fluids.samples.length = 0
    this.fluids.debug.length = 0

    this.syncBodies()
  }

  clearTrails(): void {
    this.trails.clear()
    this.trailTick = 0
  }

  private recordTrails(): void {
    if (++this.trailTick % TRAIL_EVERY !== 0) return
    for (const b of this.curr) {
      if (b.type !== 'dynamic') continue
      let trail = this.trails.get(b.id)
      if (!trail) {
        trail = []
        this.trails.set(b.id, trail)
      }
      trail.push(b.comX, b.comY)
      if (trail.length > TRAIL_POINTS * 2) trail.splice(0, trail.length - TRAIL_POINTS * 2)
    }
  }

  private syncCurrMap(): void {
    this.currMap.clear()
    for (const b of this.curr) this.currMap.set(b.id, b)
  }

  syncBodies(): void {
    this.world?.writeBodies(this.curr)
    this.syncCurrMap()
  }

  async reset(): Promise<void> {
    this.reloadQueue = this.reloadQueue
      .catch(() => {})
      .then(async () => {
        const R = await loadRapier()
        this.rebuild(R)
      })
    return this.reloadQueue
  }

  async reload(doc: SceneDocument): Promise<void> {
    this.reloadQueue = this.reloadQueue
      .catch(() => {})
      .then(async () => {
        this.doc = cloneDocument(doc)
        const R = await loadRapier()
        this.rebuild(R)
      })
    return this.reloadQueue
  }

  play(): void {
    this.clock.playing = true
  }

  pause(): void {
    this.clock.playing = false
  }

  setTimeScale(s: number): void {
    this.clock.timeScale = s
  }

  setGravity(g: Vec2): void {
    this.world?.setGravity(g)
  }

  private physicsStep(stepTime = this.clock.simTime): void {
    if (!this.world) return
    this.appliedForces.length = 0
    this.prev = this.curr.map((b) => ({ ...b }))
    this.prevMap.clear()
    for (const b of this.prev) this.prevMap.set(b.id, b)

    for (const f of this.persistentForces) {
      this.world.applyForce(f.bodyId, f.fx, f.fy, { x: f.x, y: f.y })
    }
    this.applyAuthoredForces(this.world, stepTime - PHYSICS_DT)
    if (this.grab) this.applyGrab(this.world, this.grab)
    const t0 = performance.now()
    // Analytic tanks, then PBF particles (distinct models).
    this.fluids.step(this.world, this.doc.fluidRegions, this.doc.bodies, this.curr)
    this.particles.step(this.world, PHYSICS_DT, this.doc.bodies)
    const t1 = performance.now()
    this.world.step(PHYSICS_DT)
    this.applyMutualGravity(this.world, 'post')
    const t2 = performance.now()
    this.world.writeBodies(this.curr)
    this.syncCurrMap()
    this.recordTrails()

    this.world.writeContacts(this.contacts)
    this.recorder.sample(stepTime, PHYSICS_DT, this.doc.world.gravity, this.curr)
    this.timings.fluids = t1 - t0
    this.timings.physics = t2 - t1
  }

  /**
   * Authored constant forces, read from the document every step from the live pose at the
   * start of the step: thrusters (constant in the body or world frame), air drag / wind and
   * fan jets. All go to `appliedForces` so the force layer shows them. Fans also push the
   * particle water (one-sided, see `fanParticlePush`).
   */
  private applyAuthoredForces(world: PhysicsWorld, t: number): void {
    const wind = this.doc.world.wind
    const airDensity = wind?.airDensity ?? DEFAULT_AIR_DENSITY
    // Fans in world space this step; a mounted fan follows its body (skipped if it is gone).
    const fans: SceneFan[] = []
    for (const fan of this.doc.fans ?? []) {
      const placed = fanInWorld(fan, fan.bodyId ? this.currMap.get(fan.bodyId) : null)
      if (placed) fans.push(placed)
    }
    if (fans.length && this.particles.particleCount) {
      const fixed = fans.filter((f) => !f.bodyId)
      if (fixed.length) {
        this.particles.applyVelocityChange((x, y, vx, vy, out) =>
          fanParticlePush(fixed, t, PHYSICS_DT, FAN_WATER_RATE, x, y, vx, vy, out),
        )
      }
      // A propeller: the momentum it gives the water pushes its body the other way.
      for (const fan of fans) {
        if (!fan.bodyId) continue
        const one = [fan]
        const p = this.particles.applyVelocityChange((x, y, vx, vy, out) =>
          fanParticlePush(one, t, PHYSICS_DT, FAN_WATER_RATE, x, y, vx, vy, out),
        )
        if (p.x === 0 && p.y === 0) continue
        const fx = -p.x / PHYSICS_DT
        const fy = -p.y / PHYSICS_DT
        world.applyForce(fan.bodyId, fx, fy, { x: fan.x, y: fan.y })
        this.appliedForces.push({ bodyId: fan.bodyId, x: fan.x, y: fan.y, fx, fy })
      }
    }
    this.applyMutualGravity(world, 'pre')
    for (const body of this.doc.bodies) {
      if (body.type !== 'dynamic') continue
      if (!body.thruster && !wind && !fans.length) continue
      const snap = this.currMap.get(body.id)
      if (!snap) continue
      if (body.thruster && body.thruster.force > 0 && thrusterActive(body.thruster, t)) {
        const f = thrusterWorld(body.thruster, snap)
        world.applyForce(body.id, f.fx, f.fy, { x: f.x, y: f.y })
        this.appliedForces.push({ bodyId: body.id, ...f })
      }
      const airForces = fans
        .filter((fan) => fan.bodyId !== body.id)
        .map((fan) => fanForce(fan, body.shape, snap, t, airDensity))
      if (wind) airForces.push(windForce(wind, body.shape, snap, t))
      for (const f of airForces) {
        if (f.x === 0 && f.y === 0) continue
        const at = { x: snap.comX, y: snap.comY }
        world.applyForce(body.id, f.x, f.y, at)
        this.appliedForces.push({ bodyId: body.id, x: at.x, y: at.y, fx: f.x, fy: f.y })
      }
    }
  }

  /**
   * Mutual gravity between bodies marked `attracts`, integrated as leapfrog (kick–drift–
   * kick): half an impulse from the positions before the step ('pre'), Rapier drifts, half
   * from the positions after it ('post'). A force held over the step gains energy in
   * Rapier's integration (orbits spiralled out ~4 % per orbit); leapfrog is symplectic.
   * A fixed or kinematic body attracts with its authored mass (Rapier gives it none) and
   * does not move. Pairs are summed once (Newton's third law by construction).
   */
  private applyMutualGravity(world: PhysicsWorld, half: 'pre' | 'post'): void {
    const G = this.doc.world.gravityG ?? DEFAULT_GRAVITY_G
    if (!(G > 0)) return
    const list: { id: BodyId; m: number; x: number; y: number; moves: boolean }[] = []
    for (const body of this.doc.bodies) {
      if (!body.attracts) continue
      const snap = half === 'pre' ? this.currMap.get(body.id) : world.getBody(body.id)
      if (!snap) continue
      const moves = body.type === 'dynamic'
      const m =
        moves && snap.mass > 0
          ? snap.mass
          : body.massMode === 'explicit' && body.mass
            ? body.mass
            : body.density * shapeArea(body.shape)
      if (m > 0) list.push({ id: body.id, m, x: snap.comX, y: snap.comY, moves })
    }
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const A = list[a]!
        const B = list[b]!
        if (!A.moves && !B.moves) continue
        const f = gravityPull(G, A.m, A.x, A.y, B.m, B.x, B.y)
        const j = PHYSICS_DT / 2
        if (A.moves) {
          world.applyImpulse(A.id, f.x * j, f.y * j, { x: A.x, y: A.y })
          if (half === 'pre') {
            this.appliedForces.push({ bodyId: A.id, x: A.x, y: A.y, fx: f.x, fy: f.y })
          }
        }
        if (B.moves) {
          world.applyImpulse(B.id, -f.x * j, -f.y * j, { x: B.x, y: B.y })
          if (half === 'pre') {
            this.appliedForces.push({ bodyId: B.id, x: B.x, y: B.y, fx: -f.x, fy: -f.y })
          }
        }
      }
    }
  }

  /**
   * Critically damped spring (ω₀ = GRAB_OMEGA) from the body origin to the cursor, plus
   * gravity compensation so the body does not sag g/ω₀² below it. Applied at the COM
   * (no spurious torque) with mild angular damping. Recomputed per step from live
   * velocity; a force frozen at pointer-move time would lose its damping term.
   */
  private applyGrab(world: PhysicsWorld, grab: NonNullable<SimulationEngine['grab']>): void {
    const snap = this.currMap.get(grab.bodyId)
    if (!snap || snap.type !== 'dynamic' || !(snap.mass > 0)) return
    const m = snap.mass
    const w = GRAB_OMEGA
    const gs = this.doc.bodies.find((b) => b.id === grab.bodyId)?.gravityScale ?? 1
    const g = world.gravity
    let fx = m * (w * w * (grab.targetX - snap.x) - 2 * w * snap.vx - g.x * gs)
    let fy = m * (w * w * (grab.targetY - snap.y) - 2 * w * snap.vy - g.y * gs)
    const fmax = m * GRAB_MAX_ACCEL
    const fmag = Math.hypot(fx, fy)
    if (fmag > fmax) {
      fx *= fmax / fmag
      fy *= fmax / fmag
    }
    const at = { x: snap.comX, y: snap.comY }
    world.applyForce(grab.bodyId, fx, fy, at)
    world.applyTorque(grab.bodyId, -snap.inertia * w * snap.omega)
    this.appliedForces.push({ bodyId: grab.bodyId, x: at.x, y: at.y, fx, fy })
  }

  advance(frameDt: number): void {
    const n = this.clock.advance(frameDt)
    this.timings.steps = n
    const startSimTime = this.clock.simTime - n * PHYSICS_DT
    for (let i = 0; i < n; i++) {
      this.physicsStep(startSimTime + (i + 1) * PHYSICS_DT)
    }
  }

  stepOnce(): void {
    this.clock.playing = false
    this.clock.stepOnce()
    this.physicsStep(this.clock.simTime)
  }

  interpolated(id: BodyId): BodySnapshot | null {
    const b = this.currMap.get(id) ?? this.curr.find((c) => c.id === id)
    if (!b) return null
    const a = this.prevMap.get(id) ?? this.prev.find((p) => p.id === id)
    if (!a || this.clock.alpha >= 1 || !this.clock.playing) return b
    const t = this.clock.alpha
    let dAngle = b.angle - a.angle
    while (dAngle > Math.PI) dAngle -= Math.PI * 2
    while (dAngle < -Math.PI) dAngle += Math.PI * 2
    return {
      ...b,
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      comX: a.comX + (b.comX - a.comX) * t,
      comY: a.comY + (b.comY - a.comY) * t,
      angle: a.angle + dAngle * t,
    }
  }

  bodyAt(
    x: number,
    y: number,
    predicate?: (id: BodyId, body?: SceneBody) => boolean,
  ): BodyId | null {
    const hit =
      this.world?.pointHit(x, y, predicate ? { predicate: (id) => predicate(id) } : undefined)
        ?.bodyId ?? null
    if (hit) return hit
    return pickBody(
      this.doc.bodies,
      x,
      y,
      (id) => {
        const live = this.world?.getBody(id)
        return live ? { x: live.x, y: live.y, angle: live.angle } : undefined
      },
      (body) => (predicate ? predicate(body.id, body) : true),
    )
  }

  applyImpulse(id: BodyId, jx: number, jy: number, point: Vec2): void {
    this.world?.applyImpulse(id, jx, jy, point)
    this.appliedForces.push({
      bodyId: id,
      x: point.x,
      y: point.y,
      fx: jx / PHYSICS_DT,
      fy: jy / PHYSICS_DT,
    })
    this.syncBodies()
  }
}
