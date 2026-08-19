import type { BodyId } from '../core/ids.ts'
import { PHYSICS_DT } from '../core/constants.ts'
import type { Vec2 } from '../core/math/vec2.ts'
import { RapierWorld } from '../physics/adapters/rapier/RapierWorld.ts'
import { loadRapier } from '../physics/adapters/rapier/loadRapier.ts'
import type { BodySnapshot, PhysicsContact, PhysicsWorld } from '../physics/ports.ts'
import { buildWorld } from '../scene/builder.ts'
import { cloneDocument, type SceneDocument } from '../scene/document.ts'
import { pickBody } from '../scene/picking.ts'
import { AnalyticFluidSolver } from '../fluids/analytic/AnalyticFluid.ts'
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
  prev: BodySnapshot[] = []
  curr: BodySnapshot[] = []
  contacts: PhysicsContact[] = []
  appliedForces: AppliedForce[] = []
  /** Forces re-applied every physics step (sustained force tool / grab). */
  persistentForces: AppliedForce[] = []
  timings = { physics: 0, fluids: 0, steps: 0 }

  constructor(doc: SceneDocument) {
    this.doc = cloneDocument(doc)
  }

  async init(): Promise<void> {
    const R = await loadRapier()
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
    this.world.writeBodies(this.curr)
    this.prev = this.curr.map((b) => ({ ...b }))
    this.contacts = []
  }

  async reset(): Promise<void> {
    const R = await loadRapier()
    this.rebuild(R)
  }

  async reload(doc: SceneDocument): Promise<void> {
    this.doc = cloneDocument(doc)
    const R = await loadRapier()
    this.rebuild(R)
  }

  play(): void {
    this.clock.playing = true
  }

  pause(): void {
    this.clock.playing = false
  }

  setTimeScale(s: number): void {
    this.clock.timeScale = s
    this.doc.world.timeScale = s
  }

  setGravity(g: Vec2): void {
    this.doc.world.gravity = { x: g.x, y: g.y }
    this.world?.setGravity(g)
  }

  private physicsStep(): void {
    if (!this.world) return
    this.prev = this.curr.map((b) => ({ ...b }))
    for (const f of this.persistentForces) {
      this.world.applyForce(f.bodyId, f.fx, f.fy, { x: f.x, y: f.y })
    }
    const t0 = performance.now()
    this.fluids.step(this.world, this.doc.fluidRegions, this.doc.bodies, this.curr)
    const t1 = performance.now()
    this.world.step(PHYSICS_DT)
    const t2 = performance.now()
    this.world.writeBodies(this.curr)
    this.world.writeContacts(this.contacts)
    this.recorder.sample(this.clock.simTime, PHYSICS_DT, this.doc.world.gravity.y, this.curr)
    this.timings.fluids = t1 - t0
    this.timings.physics = t2 - t1
  }

  advance(frameDt: number): void {
    const n = this.clock.advance(frameDt)
    this.timings.steps = n
    for (let i = 0; i < n; i++) this.physicsStep()
  }

  stepOnce(): void {
    this.clock.playing = false
    this.clock.stepOnce()
    this.physicsStep()
  }

  interpolated(id: BodyId): BodySnapshot | null {
    const a = this.prev.find((b) => b.id === id)
    const b = this.curr.find((c) => c.id === id)
    if (!b) return null
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

  bodyAt(x: number, y: number, predicate?: (id: BodyId) => boolean): BodyId | null {
    const hit = this.world?.pointHit(x, y, predicate ? { predicate } : undefined)?.bodyId ?? null
    if (hit) return hit
    const poses = this.doc.bodies.map((b) => {
      const live = this.world?.getBody(b.id)
      return live ? { id: b.id, x: live.x, y: live.y, angle: live.angle } : b
    })
    return pickBody(this.doc.bodies, x, y, poses, (body) => (predicate ? predicate(body.id) : true))
  }

  applyImpulse(id: BodyId, jx: number, jy: number, point: Vec2): void {
    this.world?.applyImpulse(id, jx, jy, point)
    this.appliedForces.push({ bodyId: id, x: point.x, y: point.y, fx: jx / PHYSICS_DT, fy: jy / PHYSICS_DT })
    this.world?.writeBodies(this.curr)
  }
}
