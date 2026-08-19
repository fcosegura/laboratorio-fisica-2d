import type { Transform } from '../core/math/transform.ts'
import { transformPoint } from '../core/math/transform.ts'
import type { Vec2 } from '../core/math/vec2.ts'
import type { JointDesc } from '../physics/ports.ts'
import type { PhysicsWorld } from '../physics/ports.ts'
import type { SceneDocument, SceneJoint } from './document.ts'

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

export function jointToDesc(joint: SceneJoint): JointDesc {
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
