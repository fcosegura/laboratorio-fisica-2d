import type { Transform } from '../core/math/transform.ts'
import { transformPoint } from '../core/math/transform.ts'
import type { Vec2 } from '../core/math/vec2.ts'
import type { JointDesc } from '../physics/ports.ts'
import type { PhysicsWorld } from '../physics/ports.ts'
import {
  DEFAULT_FLEX_DAMPING,
  DEFAULT_FLEX_STIFFNESS,
  type SceneDocument,
  type SceneJoint,
} from './document.ts'

/** ω² for mass-scaled springs (period ≈ 2π/√400 ≈ 0.31 s). Also the Rapier/inspector fallback. */
export const DEFAULT_SPRING_STIFFNESS = 400
export const DEFAULT_SPRING_DAMPING = 2

function finiteMass(mass: number): number | null {
  return Number.isFinite(mass) && mass > 0 ? mass : null
}

export function reducedMass(massA: number, massB: number): number {
  const a = finiteMass(massA)
  const b = finiteMass(massB)
  if (a === null && b === null) return 1
  if (a === null) return b!
  if (b === null) return a
  return (a * b) / (a + b)
}

/** Stiffness and damping sized so gravity does not stretch the spring without bound. */
export function springParamsForMasses(massA: number, massB: number): { stiffness: number; damping: number } {
  const mu = reducedMass(massA, massB)
  const stiffness = DEFAULT_SPRING_STIFFNESS * mu
  const damping = 2 * Math.sqrt(stiffness * mu)
  return { stiffness, damping }
}

/** Flexible joint natural frequency (rad/s) and damping ratio (under-damped: it wobbles). */
const FLEX_OMEGA = 30
const FLEX_ZETA = 0.3

/**
 * Torsion spring for a flexible joint: k = ω²·ΣI, I about the anchor (I_com + m·d²) of each
 * movable body. Sized on the two bodies only; a long beam carrying a load sags more, and
 * the stiffness is editable.
 */
export function flexParamsFor(
  bodies: readonly { mass: number; inertia: number; anchorDist: number }[],
): { stiffness: number; damping: number } {
  let I = 0
  for (const b of bodies) {
    if (b.mass > 0 && Number.isFinite(b.mass)) I += b.inertia + b.mass * b.anchorDist ** 2
  }
  if (!(I > 0)) return { stiffness: DEFAULT_FLEX_STIFFNESS, damping: DEFAULT_FLEX_DAMPING }
  const stiffness = FLEX_OMEGA * FLEX_OMEGA * I
  return { stiffness, damping: 2 * FLEX_ZETA * Math.sqrt(stiffness * I) }
}

export function jointToDesc(joint: SceneJoint): JointDesc {
  if (joint.kind === 'flex') {
    // Rest angle = relative angle at creation, stored like a weld's frames.
    return {
      id: joint.id,
      kind: 'flex',
      bodyA: joint.bodyA,
      bodyB: joint.bodyB,
      anchorA: joint.anchorA,
      anchorB: joint.anchorB,
      motor: {
        mode: 'position',
        target: (joint.frameA ?? 0) - (joint.frameB ?? 0),
        stiffness: joint.stiffness ?? DEFAULT_FLEX_STIFFNESS,
        damping: joint.damping ?? DEFAULT_FLEX_DAMPING,
      },
    }
  }
  return {
    id: joint.id,
    kind: joint.kind === 'distance' ? 'rope' : joint.kind,
    bodyA: joint.bodyA,
    bodyB: joint.bodyB,
    anchorA: joint.anchorA,
    anchorB: joint.anchorB,
    restLength: joint.restLength,
    stiffness: joint.stiffness,
    damping: joint.damping,
    frameA: joint.frameA,
    frameB: joint.frameB,
  }
}

export function jointsTouching(doc: SceneDocument, bodyId: string): SceneJoint[] {
  return doc.joints.filter((j) => j.bodyA === bodyId || j.bodyB === bodyId)
}

export function reattachJoints(world: PhysicsWorld, doc: SceneDocument, bodyId: string): void {
  for (const joint of jointsTouching(doc, bodyId)) {
    world.addJoint(jointToDesc(joint))
  }
}

export function jointAnchorWorld(anchor: Vec2, pose: Transform): Vec2 {
  return transformPoint({ x: 0, y: 0 }, anchor, pose)
}
