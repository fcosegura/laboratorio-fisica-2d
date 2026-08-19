import { PHYSICS_DT } from '../core/constants.ts'
import { getSolid } from '../materials/catalog.ts'
import type { BodyDesc } from '../physics/ports.ts'
import type { PhysicsWorld } from '../physics/ports.ts'
import type { SceneBody, SceneDocument } from './document.ts'
import { jointToDesc } from './joints.ts'

export function bodyToDesc(body: SceneBody): BodyDesc {
  const mat = getSolid(body.materialId)
  const collider = {
    shape: body.shape,
    friction: body.friction,
    restitution: body.restitution,
    ...(body.massMode === 'explicit' && body.mass
      ? { mass: body.mass }
      : { density: body.density || mat.density }),
  }
  return {
    id: body.id,
    type: body.type,
    translation: { x: body.x, y: body.y },
    rotation: body.angle,
    linvel: { x: body.vx, y: body.vy },
    angvel: body.omega,
    gravityScale: body.gravityScale,
    linearDamping: body.linearDamping,
    angularDamping: body.angularDamping,
    ccd: body.ccd,
    lockTranslation: body.locked && body.type !== 'fixed',
    lockRotation: body.lockRotation,
    colliders: [collider],
  }
}

export function buildWorld(world: PhysicsWorld, doc: SceneDocument): void {
  world.setGravity(doc.world.gravity)
  world.setDt(PHYSICS_DT)
  for (const body of doc.bodies) {
    world.addBody(bodyToDesc(body))
  }
  for (const joint of doc.joints) {
    world.addJoint(jointToDesc(joint))
  }
}
