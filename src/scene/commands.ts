import { DEFAULT_GRAVITY_G } from './document.ts'
import type {
  GravityPreset,
  SceneBody,
  SceneDocument,
  SceneFan,
  SceneFluidRegion,
  SceneFluidVolume,
  SceneJoint,
  SceneWind,
} from './document.ts'
import type { Vec2 } from '../core/math/vec2.ts'

export interface Command {
  apply(doc: SceneDocument): void
  invert(doc: SceneDocument): void
}

export class BatchCommand implements Command {
  commands: Command[]
  constructor(commands: Command[]) {
    this.commands = commands
  }
  apply(doc: SceneDocument): void {
    for (const cmd of this.commands) cmd.apply(doc)
  }
  invert(doc: SceneDocument): void {
    for (let i = this.commands.length - 1; i >= 0; i--) {
      this.commands[i]!.invert(doc)
    }
  }
}

export class AddBodyCommand implements Command {
  body: SceneBody
  constructor(body: SceneBody) {
    this.body = body
  }
  apply(doc: SceneDocument): void {
    doc.bodies.push(structuredClone(this.body))
  }
  invert(doc: SceneDocument): void {
    doc.bodies = doc.bodies.filter((b) => b.id !== this.body.id)
  }
}

export class RemoveBodyCommand implements Command {
  id: string
  stored: SceneBody | null = null
  storedJoints: SceneJoint[] = []
  /** Fans mounted on the body go with it, back to their array index on undo. */
  storedFans: { fan: SceneFan; index: number }[] = []
  index = -1
  constructor(id: string) {
    this.id = id
  }
  apply(doc: SceneDocument): void {
    const i = doc.bodies.findIndex((b) => b.id === this.id)
    this.index = i
    this.stored = i >= 0 ? structuredClone(doc.bodies[i]!) : null
    this.storedJoints = doc.joints
      .filter((j) => j.bodyA === this.id || j.bodyB === this.id)
      .map((j) => structuredClone(j))
    if (i >= 0) doc.bodies.splice(i, 1)
    if (this.storedJoints.length) {
      const removed = new Set(this.storedJoints.map((j) => j.id))
      doc.joints = doc.joints.filter((j) => !removed.has(j.id))
    }
    this.storedFans = (doc.fans ?? [])
      .map((fan, index) => ({ fan: structuredClone(fan), index }))
      .filter((f) => f.fan.bodyId === this.id)
    if (this.storedFans.length) doc.fans = doc.fans!.filter((f) => f.bodyId !== this.id)
  }
  invert(doc: SceneDocument): void {
    if (this.stored) {
      const insertAt =
        this.index >= 0 && this.index <= doc.bodies.length ? this.index : doc.bodies.length
      doc.bodies.splice(insertAt, 0, structuredClone(this.stored))
    }
    for (const joint of this.storedJoints) {
      if (!doc.joints.some((j) => j.id === joint.id)) doc.joints.push(structuredClone(joint))
    }
    const fans = this.storedFans.length ? (doc.fans ??= []) : []
    for (const { fan, index } of this.storedFans) {
      if (fans.some((f) => f.id === fan.id)) continue
      fans.splice(Math.min(index, fans.length), 0, structuredClone(fan))
    }
  }
}

export class UpdateBodyCommand implements Command {
  id: string
  patch: Partial<SceneBody>
  prev: Partial<SceneBody> | null = null
  constructor(id: string, patch: Partial<SceneBody>, explicitPrev?: Partial<SceneBody>) {
    this.id = id
    this.patch = patch
    if (explicitPrev) {
      this.prev = structuredClone(explicitPrev)
    }
  }
  apply(doc: SceneDocument): void {
    const body = doc.bodies.find((b) => b.id === this.id)
    if (!body) return
    if (!this.prev) {
      this.prev = structuredClone(body)
    }
    assignOptional(body, this.patch)
  }
  invert(doc: SceneDocument): void {
    const body = doc.bodies.find((b) => b.id === this.id)
    if (body && this.prev) {
      // A key the patch added (e.g. `thruster`) is absent from `prev`: undo removes it.
      for (const k of Object.keys(this.patch) as (keyof SceneBody)[]) {
        if (!(k in this.prev)) delete (body as Partial<SceneBody>)[k]
      }
      assignOptional(body, this.prev)
    }
  }
}

/** `Object.assign` where an `undefined` value removes the (optional) key instead. */
function assignOptional<T extends object>(target: T, patch: Partial<T>): void {
  for (const k of Object.keys(patch) as (keyof T)[]) {
    if (patch[k] === undefined) delete target[k]
    else target[k] = structuredClone(patch[k]) as T[keyof T]
  }
}

export class AddFluidCommand implements Command {
  region: SceneFluidRegion
  constructor(region: SceneFluidRegion) {
    this.region = region
  }
  apply(doc: SceneDocument): void {
    doc.fluidRegions.push(structuredClone(this.region))
  }
  invert(doc: SceneDocument): void {
    doc.fluidRegions = doc.fluidRegions.filter((r) => r.id !== this.region.id)
  }
}

export class RemoveFluidCommand implements Command {
  id: string
  stored: SceneFluidRegion | null = null
  index = -1
  constructor(id: string) {
    this.id = id
  }
  apply(doc: SceneDocument): void {
    const i = doc.fluidRegions.findIndex((r) => r.id === this.id)
    this.index = i
    this.stored = i >= 0 ? structuredClone(doc.fluidRegions[i]!) : null
    if (i >= 0) doc.fluidRegions.splice(i, 1)
  }
  invert(doc: SceneDocument): void {
    if (this.stored && !doc.fluidRegions.some((r) => r.id === this.stored!.id)) {
      const insertAt =
        this.index >= 0 && this.index <= doc.fluidRegions.length
          ? this.index
          : doc.fluidRegions.length
      doc.fluidRegions.splice(insertAt, 0, structuredClone(this.stored))
    }
  }
}

export class UpdateFluidRegionCommand implements Command {
  id: string
  patch: Partial<SceneFluidRegion>
  prev: Partial<SceneFluidRegion> | null = null
  constructor(
    id: string,
    patch: Partial<SceneFluidRegion>,
    explicitPrev?: Partial<SceneFluidRegion>,
  ) {
    this.id = id
    this.patch = patch
    if (explicitPrev) {
      this.prev = structuredClone(explicitPrev)
    }
  }
  apply(doc: SceneDocument): void {
    const region = doc.fluidRegions.find((r) => r.id === this.id)
    if (!region) return
    if (!this.prev) {
      this.prev = structuredClone(region)
    }
    Object.assign(region, this.patch)
  }
  invert(doc: SceneDocument): void {
    const region = doc.fluidRegions.find((r) => r.id === this.id)
    if (region && this.prev) {
      Object.assign(region, this.prev)
    }
  }
}

export class AddFluidVolumeCommand implements Command {
  volume: SceneFluidVolume
  constructor(volume: SceneFluidVolume) {
    this.volume = volume
  }
  apply(doc: SceneDocument): void {
    doc.fluidVolumes.push(structuredClone(this.volume))
  }
  invert(doc: SceneDocument): void {
    doc.fluidVolumes = doc.fluidVolumes.filter((v) => v.id !== this.volume.id)
  }
}

export class RemoveFluidVolumeCommand implements Command {
  id: string
  stored: SceneFluidVolume | null = null
  index = -1
  constructor(id: string) {
    this.id = id
  }
  apply(doc: SceneDocument): void {
    const i = doc.fluidVolumes.findIndex((v) => v.id === this.id)
    this.index = i
    this.stored = i >= 0 ? structuredClone(doc.fluidVolumes[i]!) : null
    if (i >= 0) doc.fluidVolumes.splice(i, 1)
  }
  invert(doc: SceneDocument): void {
    if (this.stored && !doc.fluidVolumes.some((v) => v.id === this.stored!.id)) {
      const insertAt =
        this.index >= 0 && this.index <= doc.fluidVolumes.length
          ? this.index
          : doc.fluidVolumes.length
      doc.fluidVolumes.splice(insertAt, 0, structuredClone(this.stored))
    }
  }
}

export class AddFanCommand implements Command {
  fan: SceneFan
  constructor(fan: SceneFan) {
    this.fan = fan
  }
  apply(doc: SceneDocument): void {
    ;(doc.fans ??= []).push(structuredClone(this.fan))
  }
  invert(doc: SceneDocument): void {
    doc.fans = (doc.fans ?? []).filter((f) => f.id !== this.fan.id)
  }
}

export class RemoveFanCommand implements Command {
  id: string
  stored: SceneFan | null = null
  index = -1
  constructor(id: string) {
    this.id = id
  }
  apply(doc: SceneDocument): void {
    const fans = doc.fans ?? []
    const i = fans.findIndex((f) => f.id === this.id)
    this.index = i
    this.stored = i >= 0 ? structuredClone(fans[i]!) : null
    if (i >= 0) fans.splice(i, 1)
  }
  invert(doc: SceneDocument): void {
    const fans = (doc.fans ??= [])
    if (this.stored && !fans.some((f) => f.id === this.stored!.id)) {
      const insertAt = this.index >= 0 && this.index <= fans.length ? this.index : fans.length
      fans.splice(insertAt, 0, structuredClone(this.stored))
    }
  }
}

export class UpdateFanCommand implements Command {
  id: string
  patch: Partial<SceneFan>
  prev: Partial<SceneFan> | null = null
  constructor(id: string, patch: Partial<SceneFan>, explicitPrev?: Partial<SceneFan>) {
    this.id = id
    this.patch = patch
    if (explicitPrev) {
      this.prev = structuredClone(explicitPrev)
    }
  }
  apply(doc: SceneDocument): void {
    const fan = doc.fans?.find((f) => f.id === this.id)
    if (!fan) return
    if (!this.prev) {
      this.prev = structuredClone(fan)
    }
    Object.assign(fan, this.patch)
  }
  invert(doc: SceneDocument): void {
    const fan = doc.fans?.find((f) => f.id === this.id)
    if (fan && this.prev) {
      Object.assign(fan, this.prev)
    }
  }
}

export class DuplicateBodyCommand implements Command {
  newBody: SceneBody
  constructor(_sourceId: string, newBody: SceneBody) {
    this.newBody = newBody
  }
  apply(doc: SceneDocument): void {
    doc.bodies.push(structuredClone(this.newBody))
  }
  invert(doc: SceneDocument): void {
    doc.bodies = doc.bodies.filter((b) => b.id !== this.newBody.id)
  }
}

export class AddJointCommand implements Command {
  joint: SceneJoint
  constructor(joint: SceneJoint) {
    this.joint = joint
  }
  apply(doc: SceneDocument): void {
    if (doc.joints.some((j) => j.id === this.joint.id)) return
    doc.joints.push(structuredClone(this.joint))
  }
  invert(doc: SceneDocument): void {
    doc.joints = doc.joints.filter((j) => j.id !== this.joint.id)
  }
}

export class RemoveJointCommand implements Command {
  id: string
  stored: SceneJoint | null = null
  index = -1
  constructor(id: string) {
    this.id = id
  }
  apply(doc: SceneDocument): void {
    const i = doc.joints.findIndex((j) => j.id === this.id)
    this.index = i
    this.stored = i >= 0 ? structuredClone(doc.joints[i]!) : null
    if (i >= 0) doc.joints.splice(i, 1)
  }
  invert(doc: SceneDocument): void {
    if (this.stored && !doc.joints.some((j) => j.id === this.stored!.id)) {
      const insertAt =
        this.index >= 0 && this.index <= doc.joints.length ? this.index : doc.joints.length
      doc.joints.splice(insertAt, 0, structuredClone(this.stored))
    }
  }
}

export class UpdateJointCommand implements Command {
  id: string
  patch: Partial<SceneJoint>
  prev: Partial<SceneJoint> | null = null
  constructor(id: string, patch: Partial<SceneJoint>, explicitPrev?: Partial<SceneJoint>) {
    this.id = id
    this.patch = patch
    if (explicitPrev) {
      this.prev = structuredClone(explicitPrev)
    }
  }
  apply(doc: SceneDocument): void {
    const joint = doc.joints.find((j) => j.id === this.id)
    if (!joint) return
    if (!this.prev) {
      this.prev = structuredClone(joint)
    }
    Object.assign(joint, this.patch)
  }
  invert(doc: SceneDocument): void {
    const joint = doc.joints.find((j) => j.id === this.id)
    if (joint && this.prev) {
      Object.assign(joint, this.prev)
    }
  }
}

export type WorldPatch = {
  gravity?: Vec2
  gravityPreset?: GravityPreset
  timeScale?: number
  /** `null` removes the air (vacuum); `undefined` leaves it untouched. */
  wind?: SceneWind | null
  gravityG?: number
}

export class SetWorldCommand implements Command {
  patch: WorldPatch
  prev: WorldPatch | null = null
  constructor(patch: WorldPatch, explicitPrev?: WorldPatch) {
    this.patch = structuredClone(patch)
    if (explicitPrev) this.prev = structuredClone(explicitPrev)
  }
  apply(doc: SceneDocument): void {
    if (!this.prev) {
      this.prev = {
        gravity: { ...doc.world.gravity },
        gravityPreset: doc.world.gravityPreset,
        timeScale: doc.world.timeScale,
        wind: doc.world.wind ? structuredClone(doc.world.wind) : null,
        gravityG: doc.world.gravityG ?? DEFAULT_GRAVITY_G,
      }
    }
    this.write(doc, this.patch)
  }
  invert(doc: SceneDocument): void {
    if (this.prev) this.write(doc, this.prev)
  }
  private write(doc: SceneDocument, patch: WorldPatch): void {
    if (patch.gravity) doc.world.gravity = { ...patch.gravity }
    if (patch.gravityPreset !== undefined) doc.world.gravityPreset = patch.gravityPreset
    if (patch.timeScale !== undefined) doc.world.timeScale = patch.timeScale
    if (patch.wind === null) delete doc.world.wind
    else if (patch.wind !== undefined) doc.world.wind = structuredClone(patch.wind)
    if (patch.gravityG !== undefined) doc.world.gravityG = patch.gravityG
  }
}
