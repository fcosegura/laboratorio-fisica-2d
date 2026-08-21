import type { BodyId, FluidRegionId, MaterialId } from '../core/ids.ts'
import type { Vec2 } from '../core/math/vec2.ts'
import type { BodyType, MassMode, PhysicsShape } from '../physics/ports.ts'

export type { BodyType, MassMode } from '../physics/ports.ts'

export const SCHEMA_VERSION = 2

export type GravityPreset = 'earth' | 'moon' | 'mars' | 'zero' | 'custom'

export const GRAVITY_PRESETS: Record<Exclude<GravityPreset, 'custom'>, Vec2> = {
  earth: { x: 0, y: -9.81 },
  moon: { x: 0, y: -1.62 },
  mars: { x: 0, y: -3.72 },
  zero: { x: 0, y: 0 },
}

export type SceneBody = {
  id: BodyId
  name: string
  type: BodyType
  x: number
  y: number
  angle: number
  vx: number
  vy: number
  omega: number
  massMode: MassMode
  density: number
  mass?: number
  friction: number
  restitution: number
  materialId: MaterialId
  gravityScale: number
  linearDamping: number
  angularDamping: number
  ccd: boolean
  locked: boolean
  lockRotation: boolean
  shape: PhysicsShape
  color?: number
}

/** Analytic hydrostatic tank (Archimedes + drag). Flat free surface; does not spill. */
export type SceneFluidRegion = {
  id: FluidRegionId
  name: string
  polygon: Vec2[]
  restSurfaceY: number
  materialId: MaterialId
}

/**
 * Seed volume for particle (PBF) fluid. Particles are regenerated on reset/reload from
 * this polygon; runtime particle state is not persisted in the document.
 */
export type SceneFluidVolume = {
  id: FluidRegionId
  name: string
  polygon: Vec2[]
  materialId: MaterialId
  /** Particle spacing in meters. Smaller → more particles (capped by the solver). */
  spacing: number
}

export const JointKindUi = {
  fixed: 'fixed',
  revolute: 'revolute',
  spring: 'spring',
  rope: 'rope',
} as const
export type JointKindUi = (typeof JointKindUi)[keyof typeof JointKindUi]

export type SceneJointKind = JointKindUi | 'distance'

export const JOINT_KIND_META: { id: JointKindUi; label: string; hint: string; chip: string }[] = [
  { id: 'fixed', label: 'Soldar', hint: 'Unión rígida', chip: 'So' },
  { id: 'revolute', label: 'Bisagra', hint: 'Pivote', chip: 'Bi' },
  { id: 'spring', label: 'Resorte', hint: 'Muelle', chip: 'Re' },
  { id: 'rope', label: 'Cuerda', hint: 'Distancia máxima', chip: 'Cu' },
]

export type SceneJoint = {
  id: string
  kind: SceneJointKind
  bodyA: BodyId
  bodyB: BodyId
  anchorA: Vec2
  anchorB: Vec2
  restLength?: number
  stiffness?: number
  damping?: number
  /** Local rotation frames for a weld, radians. Rapier 2D: angleA + frameA = angleB + frameB. */
  frameA?: number
  frameB?: number
}

export type CameraState = {
  x: number
  y: number
  pixelsPerMeter: number
}

export type VizLayers = {
  velocity: boolean
  force: boolean
  gravity: boolean
  contacts: boolean
  colliders: boolean
  com: boolean
  trajectories: boolean
  fluidParticles: boolean
}

export type SceneDocument = {
  schemaVersion: number
  meta: {
    name: string
    description: string
  }
  world: {
    gravity: Vec2
    gravityPreset: GravityPreset
    timeScale: number
  }
  bodies: SceneBody[]
  joints: SceneJoint[]
  fluidRegions: SceneFluidRegion[]
  fluidVolumes: SceneFluidVolume[]
  camera: CameraState
  visualization: VizLayers
}

export const DEFAULT_VIZ: VizLayers = {
  velocity: false,
  force: false,
  gravity: false,
  contacts: true,
  colliders: false,
  com: false,
  trajectories: false,
  fluidParticles: false,
}

export function emptyScene(name = 'Escena vacía'): SceneDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    meta: { name, description: '' },
    world: {
      gravity: { ...GRAVITY_PRESETS.earth },
      gravityPreset: 'earth',
      timeScale: 1,
    },
    bodies: [
      {
        id: 'body:ground',
        name: 'Suelo',
        type: 'fixed',
        x: 0,
        y: -0.25,
        angle: 0,
        vx: 0,
        vy: 0,
        omega: 0,
        massMode: 'density',
        density: 2600,
        friction: 0.6,
        restitution: 0.1,
        materialId: 'stone',
        gravityScale: 1,
        linearDamping: 0,
        angularDamping: 0,
        ccd: false,
        locked: true,
        lockRotation: true,
        shape: { kind: 'box', hx: 8, hy: 0.25 },
      },
    ],
    joints: [],
    fluidRegions: [],
    fluidVolumes: [],
    camera: { x: 0, y: 2.5, pixelsPerMeter: 64 },
    visualization: { ...DEFAULT_VIZ },
  }
}

export function cloneDocument(doc: SceneDocument): SceneDocument {
  return structuredClone(doc)
}
