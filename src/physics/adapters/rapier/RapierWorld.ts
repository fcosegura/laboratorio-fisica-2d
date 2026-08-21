import type { Collider, ImpulseJoint, RigidBody, World } from '@dimforge/rapier2d-compat'
import type { BodyId, ColliderId, JointId } from '../../../core/ids.ts'
import { decomposePolygon, toXYArray } from '../../../core/math/decompose.ts'
import { ensureCCW, isConvex, polygonArea, removeDuplicateVertices } from '../../../core/math/polygon.ts'
import type { Vec2 } from '../../../core/math/vec2.ts'
import type {
  BodyDesc,
  BodySnapshot,
  BodyType,
  ColliderDesc,
  JointDesc,
  PhysicsContact,
  PhysicsShape,
  PhysicsWorld,
  QueryFilter,
  QueryHit,
} from '../../ports.ts'
import { BodyType as BodyTypeConst } from '../../ports.ts'
import type { RapierModule } from './loadRapier.ts'

function toRapierType(R: RapierModule, type: BodyType) {
  if (type === 'fixed') return R.RigidBodyDesc.fixed()
  if (type === 'kinematic') return R.RigidBodyDesc.kinematicPositionBased()
  return R.RigidBodyDesc.dynamic()
}

function fromRapierType(t: number): BodyType {
  if (t === 1) return BodyTypeConst.fixed
  if (t === 2 || t === 3) return BodyTypeConst.kinematic
  return BodyTypeConst.dynamic
}

type ShapePart = {
  desc: InstanceType<RapierModule['ColliderDesc']>
  areaWeight: number
}

function shapeToParts(R: RapierModule, shape: PhysicsShape): ShapePart[] {
  switch (shape.kind) {
    case 'circle':
      return [{ desc: R.ColliderDesc.ball(shape.radius), areaWeight: Math.PI * shape.radius * shape.radius }]
    case 'box':
      return [{ desc: R.ColliderDesc.cuboid(shape.hx, shape.hy), areaWeight: 4 * shape.hx * shape.hy }]
    case 'capsule':
      return [
        {
          desc: R.ColliderDesc.capsule(shape.halfHeight, shape.radius),
          areaWeight: Math.PI * shape.radius * shape.radius + 4 * shape.radius * shape.halfHeight,
        },
      ]
    case 'segment':
      return [{ desc: R.ColliderDesc.segment(shape.a, shape.b), areaWeight: 1 }]
    case 'polyline': {
      const desc = R.ColliderDesc.polyline(toXYArray(shape.vertices))
      return [{ desc, areaWeight: 1 }]
    }
    case 'convex': {
      const verts = removeDuplicateVertices(shape.vertices)
      if (verts.length < 3) return []
      // Rapier requires counter-clockwise winding and rejects the shape otherwise.
      const parts = isConvex(verts) ? [ensureCCW(verts)] : decomposePolygon(verts)
      return parts.flatMap((part) => {
        const desc = R.ColliderDesc.convexHull(toXYArray(part))
        if (!desc) return []
        const area = Math.max(1e-6, polygonArea(part))
        return [{ desc, areaWeight: area }]
      })
    }
    case 'compound':
      return shape.parts.flatMap((p) => shapeToParts(R, p))
  }
}

export class RapierWorld implements PhysicsWorld {
  gravity: Vec2
  dt: number
  private readonly R: RapierModule
  private readonly world: World
  private readonly bodies = new Map<BodyId, RigidBody>()
  private readonly colliders = new Map<BodyId, Collider[]>()
  private readonly colliderToBody = new Map<number, BodyId>()
  private readonly colliderDescs = new Map<BodyId, ColliderDesc[]>()
  private readonly joints = new Map<JointId, ImpulseJoint>()
  private readonly jointEnds = new Map<JointId, { a: BodyId; b: BodyId }>()
  private readonly pendingForces: { id: BodyId; fx: number; fy: number; px?: number; py?: number }[] = []
  private readonly pendingTorques: { id: BodyId; tau: number }[] = []
  private freed = false

  constructor(R: RapierModule, gravity: Vec2, dt: number) {
    this.R = R
    this.gravity = { x: gravity.x, y: gravity.y }
    this.dt = dt
    this.world = new R.World({ x: gravity.x, y: gravity.y })
    this.world.timestep = dt
    this.world.numSolverIterations = 4
    this.world.maxCcdSubsteps = 1
    this.world.profilerEnabled = false
  }

  setGravity(g: Vec2): void {
    if (this.freed) return
    this.gravity = { x: g.x, y: g.y }
    this.world.gravity = { x: g.x, y: g.y }
  }

  setDt(dt: number): void {
    if (this.freed) return
    this.dt = dt
    this.world.timestep = dt
  }

  addBody(desc: BodyDesc): BodyId {
    if (this.freed) return desc.id
    if (this.bodies.has(desc.id)) {
      this.removeBody(desc.id)
    }

    const rbDesc = toRapierType(this.R, desc.type)
      .setTranslation(desc.translation.x, desc.translation.y)
      .setRotation(desc.rotation)
      .setGravityScale(desc.gravityScale ?? 1)
      .setLinearDamping(desc.linearDamping ?? 0)
      .setAngularDamping(desc.angularDamping ?? 0)
      .setCcdEnabled(desc.ccd ?? false)
    if (desc.linvel) rbDesc.setLinvel(desc.linvel.x, desc.linvel.y)
    if (desc.angvel) rbDesc.setAngvel(desc.angvel)
    if (desc.lockTranslation) rbDesc.lockTranslations()
    if (desc.lockRotation) rbDesc.lockRotations()

    const body = this.world.createRigidBody(rbDesc)
    body.userData = desc.id
    const created: Collider[] = []
    for (const col of desc.colliders) {
      const parts = shapeToParts(this.R, col.shape)
      const totalArea = parts.reduce((s, p) => s + p.areaWeight, 0)
      for (const part of parts) {
        if (col.mass !== undefined && col.mass > 0) {
          const ratio = totalArea > 0 ? part.areaWeight / totalArea : 1 / Math.max(1, parts.length)
          part.desc.setMass(col.mass * ratio)
        } else {
          part.desc.setDensity(col.density ?? 1)
        }
        part.desc.setFriction(col.friction)
        part.desc.setRestitution(col.restitution)
        // Lab pedagogy: ice "wins" (slides) and rubber "wins" (bounces).
        // Rapier picks the higher-precedence rule across the contact pair; setting both
        // sides to Min / Max makes μ_eff = min(μa, μb) and e_eff = max(ea, eb).
        part.desc.setFrictionCombineRule(this.R.CoefficientCombineRule.Min)
        part.desc.setRestitutionCombineRule(this.R.CoefficientCombineRule.Max)
        if (col.isSensor) part.desc.setSensor(true)
        if (col.offset) part.desc.setTranslation(col.offset.x, col.offset.y)
        if (col.angle) part.desc.setRotation(col.angle)
        const collider = this.world.createCollider(part.desc, body)
        created.push(collider)
        this.colliderToBody.set(collider.handle, desc.id)
      }
    }
    this.bodies.set(desc.id, body)
    this.colliders.set(desc.id, created)
    this.colliderDescs.set(desc.id, desc.colliders)
    return desc.id
  }

  removeBody(id: BodyId): void {
    if (this.freed) return
    const body = this.bodies.get(id)
    if (!body) return
    const drop: JointId[] = []
    for (const [jointId, ends] of this.jointEnds) {
      if (ends.a === id || ends.b === id) drop.push(jointId)
    }
    for (const jointId of drop) {
      this.joints.delete(jointId)
      this.jointEnds.delete(jointId)
    }
    for (const c of this.colliders.get(id) ?? []) this.colliderToBody.delete(c.handle)
    this.world.removeRigidBody(body)
    this.bodies.delete(id)
    this.colliders.delete(id)
    this.colliderDescs.delete(id)
  }

  hasBody(id: BodyId): boolean {
    if (this.freed) return false
    return this.bodies.has(id)
  }

  private snapshotOf(id: BodyId, body: RigidBody): BodySnapshot {
    const t = body.translation()
    const v = body.linvel()
    return {
      id,
      x: t.x,
      y: t.y,
      angle: body.rotation(),
      vx: v.x,
      vy: v.y,
      omega: body.angvel(),
      mass: body.mass(),
      inertia: body.principalInertia(),
      type: fromRapierType(body.bodyType()),
    }
  }

  getBody(id: BodyId): BodySnapshot | null {
    if (this.freed) return null
    const body = this.bodies.get(id)
    if (!body) return null
    return this.snapshotOf(id, body)
  }

  setTransform(id: BodyId, x: number, y: number, angle: number): void {
    if (this.freed) return
    const body = this.bodies.get(id)
    if (!body) return
    body.setTranslation({ x, y }, true)
    body.setRotation(angle, true)
  }

  setVelocity(id: BodyId, vx: number, vy: number, omega: number): void {
    if (this.freed) return
    const body = this.bodies.get(id)
    if (!body) return
    body.setLinvel({ x: vx, y: vy }, true)
    body.setAngvel(omega, true)
  }

  setBodyType(id: BodyId, type: BodyType): void {
    if (this.freed) return
    const body = this.bodies.get(id)
    if (!body) return
    const R = this.R
    const mapped =
      type === 'fixed'
        ? R.RigidBodyType.Fixed
        : type === 'kinematic'
          ? R.RigidBodyType.KinematicPositionBased
          : R.RigidBodyType.Dynamic
    body.setBodyType(mapped, true)
  }

  setGravityScale(id: BodyId, scale: number): void {
    if (this.freed) return
    this.bodies.get(id)?.setGravityScale(scale, true)
  }

  setCcd(id: BodyId, enabled: boolean): void {
    if (this.freed) return
    this.bodies.get(id)?.enableCcd(enabled)
  }

  applyForce(id: BodyId, fx: number, fy: number, point?: Vec2): void {
    if (this.freed) return
    this.pendingForces.push({ id, fx, fy, px: point?.x, py: point?.y })
  }

  applyTorque(id: BodyId, torque: number): void {
    if (this.freed) return
    this.pendingTorques.push({ id, tau: torque })
  }

  applyImpulse(id: BodyId, jx: number, jy: number, point?: Vec2): void {
    if (this.freed) return
    const body = this.bodies.get(id)
    if (!body) return
    if (point) body.applyImpulseAtPoint({ x: jx, y: jy }, { x: point.x, y: point.y }, true)
    else body.applyImpulse({ x: jx, y: jy }, true)
  }

  wake(id: BodyId): void {
    if (this.freed) return
    this.bodies.get(id)?.wakeUp()
  }

  clearForces(): void {
    this.pendingForces.length = 0
    this.pendingTorques.length = 0
  }

  step(dt?: number): void {
    if (this.freed) return
    if (dt !== undefined && dt !== this.dt) this.setDt(dt)
    for (const body of this.bodies.values()) {
      body.resetForces(false)
      body.resetTorques(false)
    }
    for (const f of this.pendingForces) {
      const body = this.bodies.get(f.id)
      if (!body) continue
      if (f.px !== undefined && f.py !== undefined) {
        body.addForceAtPoint({ x: f.fx, y: f.fy }, { x: f.px, y: f.py }, true)
      } else {
        body.addForce({ x: f.fx, y: f.fy }, true)
      }
    }
    for (const t of this.pendingTorques) {
      this.bodies.get(t.id)?.addTorque(t.tau, true)
    }
    this.world.step()
    this.pendingForces.length = 0
    this.pendingTorques.length = 0
  }

  writeBodies(out: BodySnapshot[]): BodySnapshot[] {
    out.length = 0
    if (this.freed) return out
    for (const [id, body] of this.bodies) out.push(this.snapshotOf(id, body))
    return out
  }

  writeContacts(out: PhysicsContact[]): PhysicsContact[] {
    out.length = 0
    if (this.freed) return out
    const seen = new Set<string>()
    for (const [id, cols] of this.colliders) {
      for (const c of cols) {
        this.world.contactPairsWith(c, (other) => {
          const otherId = this.colliderToBody.get(other.handle)
          if (!otherId) return
          const key = c.handle < other.handle ? `${c.handle}:${other.handle}` : `${other.handle}:${c.handle}`
          if (seen.has(key)) return
          seen.add(key)
          this.world.contactPair(c, other, (manifold, flipped) => {
            const n = manifold.numSolverContacts()
            if (n <= 0) return
            const normal = manifold.normal()
            const nx = flipped ? -normal.x : normal.x
            const ny = flipped ? -normal.y : normal.y
            for (let i = 0; i < n; i++) {
              const p = manifold.solverContactPoint(i)
              if (!p) continue
              out.push({
                bodyA: id,
                bodyB: otherId,
                colliderA: String(c.handle) as ColliderId,
                colliderB: String(other.handle) as ColliderId,
                x: p.x,
                y: p.y,
                nx,
                ny,
                depth: Math.max(0, -manifold.contactDist(i)),
                impulseN: manifold.contactImpulse(i),
                impulseT: manifold.contactTangentImpulse(i),
              })
            }
          })
        })
      }
    }
    return out
  }

  pointHit(x: number, y: number, filter?: QueryFilter): QueryHit | null {
    if (this.freed) return null
    let hit: QueryHit | null = null
    this.world.intersectionsWithPoint(
      { x, y },
      (collider) => {
        const bodyId = this.colliderToBody.get(collider.handle)
        if (!bodyId) return true
        if (filter?.excludeBody && bodyId === filter.excludeBody) return true
        if (filter?.predicate && !filter.predicate(bodyId)) return true
        hit = {
          bodyId,
          colliderId: String(collider.handle) as ColliderId,
          x,
          y,
          nx: 0,
          ny: 0,
          isInside: true,
        }
        return false
      },
    )
    return hit
  }

  projectPoint(x: number, y: number, filter?: QueryFilter): QueryHit | null {
    if (this.freed) return null
    const proj = this.world.projectPoint(
      { x, y },
      true,
      undefined,
      undefined,
      undefined,
      filter?.excludeBody ? this.bodies.get(filter.excludeBody) : undefined,
      (collider) => {
        const bodyId = this.colliderToBody.get(collider.handle)
        if (!bodyId) return false
        if (filter?.predicate && !filter.predicate(bodyId)) return false
        return true
      },
    )
    if (!proj) return null
    const bodyId = this.colliderToBody.get(proj.collider.handle)
    if (!bodyId) return null
    return {
      bodyId,
      colliderId: String(proj.collider.handle) as ColliderId,
      x: proj.point.x,
      y: proj.point.y,
      nx: 0,
      ny: 0,
      isInside: proj.isInside,
    }
  }

  forEachBody(fn: (body: BodySnapshot) => void): void {
    if (this.freed) return
    for (const [id, body] of this.bodies) fn(this.snapshotOf(id, body))
  }

  getColliders(id: BodyId): ColliderDesc[] {
    if (this.freed) return []
    return this.colliderDescs.get(id) ?? []
  }

  addJoint(desc: JointDesc): void {
    if (this.freed) return
    if (this.joints.has(desc.id)) return
    if (desc.bodyA === desc.bodyB) return
    const a = this.bodies.get(desc.bodyA)
    const b = this.bodies.get(desc.bodyB)
    if (!a || !b) return
    const R = this.R
    const params =
      desc.kind === 'revolute'
        ? R.JointData.revolute(desc.anchorA, desc.anchorB)
        : desc.kind === 'fixed'
          ? R.JointData.fixed(desc.anchorA, desc.frameA ?? 0, desc.anchorB, desc.frameB ?? 0)
          : desc.kind === 'spring'
            ? R.JointData.spring(
                desc.restLength ?? 1,
                desc.stiffness ?? 400,
                desc.damping ?? 2,
                desc.anchorA,
                desc.anchorB,
              )
            : desc.kind === 'prismatic'
              ? R.JointData.prismatic(desc.anchorA, desc.anchorB, desc.axis ?? { x: 1, y: 0 })
              : R.JointData.rope(desc.restLength ?? 1, desc.anchorA, desc.anchorB)
    const joint = this.world.createImpulseJoint(params, a, b, true)
    this.joints.set(desc.id, joint)
    this.jointEnds.set(desc.id, { a: desc.bodyA, b: desc.bodyB })
  }

  removeJoint(id: JointId): void {
    if (this.freed) return
    const joint = this.joints.get(id)
    if (!joint) return
    this.world.removeImpulseJoint(joint, true)
    this.joints.delete(id)
    this.jointEnds.delete(id)
  }

  destroy(): void {
    if (this.freed) return
    this.freed = true
    this.world.free()
    this.bodies.clear()
    this.colliders.clear()
    this.colliderToBody.clear()
    this.joints.clear()
    this.jointEnds.clear()
  }
}

