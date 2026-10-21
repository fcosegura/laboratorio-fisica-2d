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
  /** Constant force applied every physics step while the body is dynamic. */
  thruster?: SceneThruster
  /** Takes part in mutual gravity: attracts every other marked body and is attracted. */
  attracts?: boolean
}

/** Propulsor: fuerza constante sobre un cuerpo, en su propio marco o en el del mundo. */
export type SceneThruster = {
  /** Newtons. */
  force: number
  /** Direction of the force, radians: body frame if `followsBody`, else world frame. */
  angle: number
  /** Application point in body-local coordinates (m). Off the COM it also gives torque. */
  anchor: Vec2
  followsBody: boolean
  /** Sim time (s) at which it ignites. Absent = 0. */
  start?: number
  /** Burn time (s); absent or 0 = burns forever. */
  duration?: number
}

/**
 * Air around the bodies. Absent = vacuum (no air drag at all). Present with zero speed =
 * still air: quadratic drag only. The wind velocity is uniform; gusts modulate its speed.
 */
export type SceneWind = {
  /** Mean wind speed, m/s. */
  speed: number
  /** Direction the wind blows towards, radians (0 = +x, π/2 = up). */
  direction: number
  /** kg/m³ (with the 1 m thickness of the 2D world). */
  airDensity: number
  /** Gust amplitude as a fraction of the mean speed (0 = steady wind). */
  gust: number
}

export const DEFAULT_AIR_DENSITY = 1.2

/**
 * Laboratory G (N·m²/kg²), ~1.5·10⁸ times the real 6.67·10⁻¹¹: at lab scale (metres,
 * hundreds of kg) the real one would move nothing.
 */
export const DEFAULT_GRAVITY_G = 0.01

/**
 * Ventilador: chorro rectangular de anchura `width` que sale de (x, y) hacia `angle` y llega a
 * `range`. Sopla aire sobre los cuerpos y empuja el agua de partículas que cae dentro (bajo el
 * agua hace de hélice; pulsando, de generador de olas). No es un cuerpo: nada choca con él.
 */
export type SceneFan = {
  id: string
  name: string
  x: number
  y: number
  /** Blow direction, radians (0 = +x). */
  angle: number
  /** Jet width across the axis, m. */
  width: number
  /** Jet reach along the axis, m. */
  range: number
  /** Outlet speed, m/s. */
  speed: number
  /** Pulse period, s: the speed goes 0 → speed → 0 each period. 0 = steady. */
  period: number
  /**
   * Mounted on this body (a propeller): x, y and angle are in its frame, the fan moves with
   * it and the water it pushes pushes the body back. Absent = fixed in the world.
   */
  bodyId?: string
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
 * Seed volume for the particle fluid (spill / pools). Regenerated on reset/reload
 * from this polygon; runtime particle state is not persisted in the document.
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
  flex: 'flex',
  spring: 'spring',
  rope: 'rope',
} as const
export type JointKindUi = (typeof JointKindUi)[keyof typeof JointKindUi]

export type SceneJointKind = JointKindUi | 'distance'

/** What the joint tool makes: a joint kind, or a chain (links joined by hinges). */
export type JointToolKind = JointKindUi | 'chain'

export const JOINT_KIND_META: { id: JointToolKind; label: string; hint: string; chip: string }[] = [
  { id: 'fixed', label: 'Soldar', hint: 'Unión rígida', chip: 'So' },
  { id: 'revolute', label: 'Bisagra', hint: 'Pivote', chip: 'Bi' },
  {
    id: 'flex',
    label: 'Flexible',
    hint: 'Bisagra con muelle: se dobla y recupera su ángulo',
    chip: 'Fl',
  },
  { id: 'spring', label: 'Resorte', hint: 'Muelle', chip: 'Re' },
  { id: 'rope', label: 'Cuerda', hint: 'Distancia máxima', chip: 'Cu' },
  {
    id: 'chain',
    label: 'Cadena',
    hint: 'Eslabones articulados; suelta en vacío para dejar el extremo libre',
    chip: 'Ca',
  },
]

/**
 * Flexible joint fallback (N·m/rad, N·m·s/rad) for documents that omit them; the joint tool
 * sizes them from the bodies instead (`flexParamsFor`).
 */
export const DEFAULT_FLEX_STIFFNESS = 2000
export const DEFAULT_FLEX_DAMPING = 60

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
    wind?: SceneWind
    /** G of the mutual gravity between marked bodies (absent = DEFAULT_GRAVITY_G). */
    gravityG?: number
  }
  bodies: SceneBody[]
  joints: SceneJoint[]
  fluidRegions: SceneFluidRegion[]
  fluidVolumes: SceneFluidVolume[]
  /** Optional: documents without fans omit it. */
  fans?: SceneFan[]
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
