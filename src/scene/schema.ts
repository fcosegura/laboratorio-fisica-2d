import { z } from 'zod'
import { SCHEMA_VERSION, type SceneDocument } from './document.ts'

const vec2 = z.object({ x: z.number(), y: z.number() })

const shape = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('circle'), radius: z.number().positive() }),
  z.object({ kind: z.literal('box'), hx: z.number().positive(), hy: z.number().positive() }),
  z.object({
    kind: z.literal('capsule'),
    halfHeight: z.number().nonnegative(),
    radius: z.number().positive(),
  }),
  z.object({
    kind: z.literal('convex'),
    vertices: z.array(vec2).min(3),
  }),
  z.object({ kind: z.literal('polyline'), vertices: z.array(vec2).min(2) }),
  z.object({ kind: z.literal('segment'), a: vec2, b: vec2 }),
])

export const sceneDocumentSchema: z.ZodType<SceneDocument> = z.object({
  schemaVersion: z.number().int().positive(),
  meta: z.object({
    name: z.string(),
    description: z.string(),
  }),
  world: z.object({
    gravity: vec2,
    gravityPreset: z.enum(['earth', 'moon', 'mars', 'zero', 'custom']),
    timeScale: z.number().positive(),
  }),
  bodies: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      type: z.enum(['dynamic', 'fixed', 'kinematic']),
      x: z.number(),
      y: z.number(),
      angle: z.number(),
      vx: z.number(),
      vy: z.number(),
      omega: z.number(),
      massMode: z.enum(['density', 'explicit']),
      density: z.number().nonnegative(),
      mass: z.number().positive().optional(),
      friction: z.number().nonnegative(),
      restitution: z.number().min(0).max(2),
      materialId: z.string(),
      gravityScale: z.number(),
      linearDamping: z.number().nonnegative(),
      angularDamping: z.number().nonnegative(),
      ccd: z.boolean(),
      locked: z.boolean(),
      lockRotation: z.boolean(),
      shape,
      color: z.number().optional(),
    }),
  ),
  joints: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['revolute', 'distance', 'spring', 'fixed', 'rope']),
      bodyA: z.string(),
      bodyB: z.string(),
      anchorA: vec2,
      anchorB: vec2,
      restLength: z.number().nonnegative().optional(),
      stiffness: z.number().nonnegative().optional(),
      damping: z.number().nonnegative().optional(),
      frameA: z.number().optional(),
      frameB: z.number().optional(),
    }),
  ),
  fluidRegions: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      polygon: z.array(vec2).min(3),
      restSurfaceY: z.number(),
      materialId: z.string(),
    }),
  ),
  camera: z.object({
    x: z.number(),
    y: z.number(),
    pixelsPerMeter: z.number().positive(),
  }),
  visualization: z.object({
    velocity: z.boolean(),
    force: z.boolean(),
    gravity: z.boolean(),
    contacts: z.boolean(),
    colliders: z.boolean(),
    com: z.boolean(),
    trajectories: z.boolean(),
    fluidParticles: z.boolean(),
  }),
})

export type Migration = (doc: Record<string, unknown>) => Record<string, unknown>

export const MIGRATIONS: Record<number, Migration> = {
  // 1 is current. Future: 1 -> 2 lives here as MIGRATIONS[1]
}

export function migrateDocument(raw: unknown): SceneDocument {
  if (!raw || typeof raw !== 'object') {
    throw new Error('El archivo de escena no es un objeto JSON')
  }
  const obj = raw as Record<string, unknown>
  let version = typeof obj.schemaVersion === 'number' ? obj.schemaVersion : 0
  let current: Record<string, unknown> = { ...obj }
  while (version < SCHEMA_VERSION) {
    const mig = MIGRATIONS[version]
    if (!mig) {
      throw new Error(`No hay migración desde schemaVersion ${version}`)
    }
    current = mig(current)
    version = typeof current.schemaVersion === 'number' ? current.schemaVersion : version + 1
  }
  const parsed = sceneDocumentSchema.parse(current)
  return parsed
}

export function serializeDocument(doc: SceneDocument): string {
  return JSON.stringify(doc, null, 2)
}

export function parseDocument(text: string): SceneDocument {
  return migrateDocument(JSON.parse(text))
}
