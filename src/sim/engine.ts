import type { BodyId } from '../core/ids.ts'
import { PHYSICS_DT } from '../core/constants.ts'
import type { Vec2 } from '../core/math/vec2.ts'
import { RapierWorld } from '../physics/adapters/rapier/RapierWorld.ts'
import { loadRapier } from '../physics/adapters/rapier/loadRapier.ts'
import type { BodySnapshot, PhysicsContact, PhysicsWorld } from '../physics/ports.ts'
import { buildWorld } from '../scene/builder.ts'
import { cloneDocument, type SceneBody, type SceneDocument } from '../scene/document.ts'
import { pickBody } from '../scene/picking.ts'
import { AnalyticFluidSolver } from '../fluids/analytic/AnalyticFluid.ts'
import { PbfFluidSolver } from '../fluids/pbf/PbfFluid.ts'
import { Clock } from './clock.ts'
import { DataRecorder } from './recorder.ts'

export type AppliedForce = {
  bodyId: BodyId
  x: number
  y: number
  fx: number
  fy: number
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
  /** Forces re-applied every physics step (sustained force tool / grab). */
  persistentForces: AppliedForce[] = []
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
    this.particles.rebuild(this.doc.fluidVolumes, this.world)
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
    const t0 = performance.now()
    this.fluids.step(this.world, this.doc.fluidRegions, this.doc.bodies, this.curr)
    this.particles.step(this.world, PHYSICS_DT)
    const t1 = performance.now()
    this.world.step(PHYSICS_DT)
    const t2 = performance.now()
    this.world.writeBodies(this.curr)
    this.syncCurrMap()

    this.world.writeContacts(this.contacts)
    this.recorder.sample(stepTime, PHYSICS_DT, this.doc.world.gravity, this.curr)
    this.timings.fluids = t1 - t0
    this.timings.physics = t2 - t1
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
