import { z } from 'zod'
import { SCHEMA_VERSION, type SceneDocument } from './document.ts'
import { PROPERTY_DESCRIPTORS } from './properties.ts'
import { FLUID_MATERIALS, SOLID_MATERIALS } from '../materials/catalog.ts'

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

export const sceneDocumentSchema: z.ZodType<SceneDocument> = z
  .object({
    schemaVersion: z.number().int().positive(),
    meta: z.object({
      name: z.string(),
      description: z.string(),
    }),
    world: z.object({
      gravity: vec2,
      gravityPreset: z.enum(['earth', 'moon', 'mars', 'zero', 'custom']),
      timeScale: z.number().min(PROPERTY_DESCRIPTORS.timeScale.min!).max(PROPERTY_DESCRIPTORS.timeScale.max!),
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
        density: z.number().min(PROPERTY_DESCRIPTORS.density.min!).max(PROPERTY_DESCRIPTORS.density.max!),
        mass: z.number().min(PROPERTY_DESCRIPTORS.mass.min!).max(PROPERTY_DESCRIPTORS.mass.max!).optional(),
        friction: z.number().min(0).max(PROPERTY_DESCRIPTORS.friction.max!),
        restitution: z.number().min(0).max(PROPERTY_DESCRIPTORS.restitution.max!),
        materialId: z.string(),
        gravityScale: z.number().min(PROPERTY_DESCRIPTORS.gravityScale.min!).max(PROPERTY_DESCRIPTORS.gravityScale.max!),
        linearDamping: z.number().min(0).max(PROPERTY_DESCRIPTORS.linearDamping.max!),
        angularDamping: z.number().min(0).max(PROPERTY_DESCRIPTORS.angularDamping.max!),
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
        restLength: z.number().min(0).max(PROPERTY_DESCRIPTORS.restLength.max!).optional(),
        stiffness: z.number().min(0).max(PROPERTY_DESCRIPTORS.stiffness.max!).optional(),
        damping: z.number().min(0).max(PROPERTY_DESCRIPTORS.damping.max!).optional(),
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
  .superRefine((doc, ctx) => {
    const bodyIds = new Set<string>()
    for (let i = 0; i < doc.bodies.length; i++) {
      const b = doc.bodies[i]!
      if (bodyIds.has(b.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `ID de cuerpo duplicado: ${b.id}`,
          path: ['bodies', i, 'id'],
        })
      }
      bodyIds.add(b.id)

      if (b.massMode === 'explicit' && (b.mass === undefined || b.mass <= 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `El cuerpo '${b.name}' tiene massMode='explicit' pero carece de masa válida`,
          path: ['bodies', i, 'mass'],
        })
      }

      if (!SOLID_MATERIALS.some((m) => m.id === b.materialId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Material desconocido '${b.materialId}' en cuerpo '${b.name}'`,
          path: ['bodies', i, 'materialId'],
        })
      }
    }

    const jointIds = new Set<string>()
    for (let i = 0; i < doc.joints.length; i++) {
      const j = doc.joints[i]!
      if (jointIds.has(j.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `ID de unión duplicado: ${j.id}`,
          path: ['joints', i, 'id'],
        })
      }
      jointIds.add(j.id)

      if (j.bodyA === j.bodyB) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `La unión '${j.id}' no puede conectar un cuerpo consigo mismo ('${j.bodyA}')`,
          path: ['joints', i, 'bodyB'],
        })
      }
      if (!bodyIds.has(j.bodyA)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `La unión '${j.id}' referencia un bodyA inexistente: '${j.bodyA}'`,
          path: ['joints', i, 'bodyA'],
        })
      }
      if (!bodyIds.has(j.bodyB)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `La unión '${j.id}' referencia un bodyB inexistente: '${j.bodyB}'`,
          path: ['joints', i, 'bodyB'],
        })
      }
    }

    const fluidIds = new Set<string>()
    for (let i = 0; i < doc.fluidRegions.length; i++) {
      const f = doc.fluidRegions[i]!
      if (fluidIds.has(f.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `ID de fluido duplicado: ${f.id}`,
          path: ['fluidRegions', i, 'id'],
        })
      }
      fluidIds.add(f.id)

      if (!FLUID_MATERIALS.some((m) => m.id === f.materialId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Material de fluido desconocido '${f.materialId}' en región '${f.name}'`,
          path: ['fluidRegions', i, 'materialId'],
        })
      }
    }
  })

export type Migration = (doc: Record<string, unknown>) => Record<string, unknown>

export const MIGRATIONS: Record<number, Migration> = {
  // 1 is current. Future: 1 -> 2 lives here as MIGRATIONS[1]
}

export function migrateDocument(raw: unknown): SceneDocument {
  if (!raw || typeof raw !== 'object') {
    throw new Error('El archivo de escena no es un objeto JSON válido')
  }
  const obj = raw as Record<string, unknown>
  if (typeof obj.schemaVersion === 'number') {
    if (obj.schemaVersion < 1 || !Number.isInteger(obj.schemaVersion)) {
      throw new Error(`Versión de esquema inválida: ${obj.schemaVersion}`)
    }
    if (obj.schemaVersion > SCHEMA_VERSION) {
      throw new Error(`El archivo corresponde a una versión de esquema más reciente (versión ${obj.schemaVersion}, versión soportada actual ${SCHEMA_VERSION})`)
    }
  }
  let version = typeof obj.schemaVersion === 'number' ? obj.schemaVersion : 1
  let current: Record<string, unknown> = { ...obj }
  if (current.schemaVersion === undefined) {
    current.schemaVersion = 1
  }
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

