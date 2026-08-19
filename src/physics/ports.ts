import type { Vec2 } from '../core/math/vec2.ts'
import type { BodyId, ColliderId, JointId } from '../core/ids.ts'

export const BodyType = {
  dynamic: 'dynamic',
  fixed: 'fixed',
  kinematic: 'kinematic',
} as const
export type BodyType = (typeof BodyType)[keyof typeof BodyType]

export const MassMode = {
  density: 'density',
  explicit: 'explicit',
} as const
export type MassMode = (typeof MassMode)[keyof typeof MassMode]

export const ShapeKind = {
  circle: 'circle',
  box: 'box',
  capsule: 'capsule',
  convex: 'convex',
  compound: 'compound',
  polyline: 'polyline',
  segment: 'segment',
} as const
export type ShapeKind = (typeof ShapeKind)[keyof typeof ShapeKind]

export type PhysicsShape =
  | { kind: 'circle'; radius: number }
  | { kind: 'box'; hx: number; hy: number }
  | { kind: 'capsule'; halfHeight: number; radius: number }
  | { kind: 'convex'; vertices: Vec2[] }
  | { kind: 'compound'; parts: PhysicsShape[] }
  | { kind: 'polyline'; vertices: Vec2[] }
  | { kind: 'segment'; a: Vec2; b: Vec2 }

export type ColliderDesc = {
  shape: PhysicsShape
  density?: number
  mass?: number
  friction: number
  restitution: number
  isSensor?: boolean
  offset?: Vec2
  angle?: number
}

export type BodyDesc = {
  id: BodyId
  type: BodyType
  translation: Vec2
  rotation: number
  linvel?: Vec2
  angvel?: number
  gravityScale?: number
  linearDamping?: number
  angularDamping?: number
  ccd?: boolean
  lockTranslation?: boolean
  lockRotation?: boolean
  colliders: ColliderDesc[]
  userData?: unknown
}

export type JointKind = 'fixed' | 'revolute' | 'prismatic' | 'distance' | 'spring' | 'rope'

export type JointDesc = {
  id: JointId
  kind: JointKind
  bodyA: BodyId
  bodyB: BodyId
  anchorA: Vec2
  anchorB: Vec2
  axis?: Vec2
  restLength?: number
  stiffness?: number
  damping?: number
  /** Local rotation frames for a fixed (weld) joint, radians. Rapier 2D: angleA + frameA = angleB + frameB. */
  frameA?: number
  frameB?: number
  limits?: [number, number]
  motor?: {
    mode: 'position' | 'velocity'
    target: number
    stiffness: number
    damping: number
    maxImpulse?: number
  }
}

export type PhysicsContact = {
  bodyA: BodyId
  bodyB: BodyId
  colliderA: ColliderId
  colliderB: ColliderId
  x: number
  y: number
  nx: number
  ny: number
  depth: number
  impulseN: number
  impulseT: number
}

export type BodySnapshot = {
  id: BodyId
  x: number
  y: number
  angle: number
  vx: number
  vy: number
  omega: number
  mass: number
  inertia: number
  type: BodyType
}

export type QueryHit = {
  bodyId: BodyId
  colliderId: ColliderId
  x: number
  y: number
  nx: number
  ny: number
  toi?: number
  isInside?: boolean
}

export type QueryFilter = {
  excludeBody?: BodyId
  predicate?: (bodyId: BodyId) => boolean
}

export interface PhysicsWorld {
  gravity: Vec2
  readonly dt: number
  setGravity(g: Vec2): void
  setDt(dt: number): void
  addBody(desc: BodyDesc): BodyId
  removeBody(id: BodyId): void
  hasBody(id: BodyId): boolean
  getBody(id: BodyId): BodySnapshot | null
  setTransform(id: BodyId, x: number, y: number, angle: number): void
  setVelocity(id: BodyId, vx: number, vy: number, omega: number): void
  setBodyType(id: BodyId, type: BodyType): void
  setGravityScale(id: BodyId, scale: number): void
  setCcd(id: BodyId, enabled: boolean): void
  applyForce(id: BodyId, fx: number, fy: number, point?: Vec2): void
  applyTorque(id: BodyId, torque: number): void
  applyImpulse(id: BodyId, jx: number, jy: number, point?: Vec2): void
  wake(id: BodyId): void
  step(dt?: number): void
  writeBodies(out: BodySnapshot[]): BodySnapshot[]
  writeContacts(out: PhysicsContact[]): PhysicsContact[]
  pointHit(x: number, y: number, filter?: QueryFilter): QueryHit | null
  projectPoint(x: number, y: number, filter?: QueryFilter): QueryHit | null
  forEachBody(fn: (body: BodySnapshot) => void): void
  getColliders(id: BodyId): ColliderDesc[]
  addJoint(desc: JointDesc): void
  removeJoint(id: JointId): void
  clearForces(): void
  destroy(): void
}
