import { describe, expect, it } from 'vitest'
import { emptyScene, type SceneDocument } from '../src/scene/document.ts'
import { migrateDocument, parseDocument } from '../src/scene/schema.ts'

describe('schema cross-validation & migration', () => {
  it('rejects documents with duplicate body IDs', () => {
    const doc = emptyScene()
    doc.bodies.push({
      id: 'body:dup',
      name: 'B1',
      type: 'dynamic',
      x: 0,
      y: 0,
      angle: 0,
      vx: 0,
      vy: 0,
      omega: 0,
      massMode: 'density',
      density: 1000,
      friction: 0.5,
      restitution: 0.2,
      materialId: 'wood',
      gravityScale: 1,
      linearDamping: 0,
      angularDamping: 0,
      ccd: false,
      locked: false,
      lockRotation: false,
      shape: { kind: 'circle', radius: 1 },
    })
    doc.bodies.push({
      id: 'body:dup',
      name: 'B2',
      type: 'dynamic',
      x: 1,
      y: 1,
      angle: 0,
      vx: 0,
      vy: 0,
      omega: 0,
      massMode: 'density',
      density: 1000,
      friction: 0.5,
      restitution: 0.2,
      materialId: 'wood',
      gravityScale: 1,
      linearDamping: 0,
      angularDamping: 0,
      ccd: false,
      locked: false,
      lockRotation: false,
      shape: { kind: 'circle', radius: 1 },
    })

    const json = JSON.stringify(doc)
    expect(() => parseDocument(json)).toThrow(/ID de cuerpo duplicado/)
  })

  it('rejects documents with orphan joints', () => {
    const doc = emptyScene()
    doc.joints.push({
      id: 'joint:1',
      kind: 'revolute',
      bodyA: 'body:ground',
      bodyB: 'body:nonexistent',
      anchorA: { x: 0, y: 0 },
      anchorB: { x: 0, y: 0 },
    })

    const json = JSON.stringify(doc)
    expect(() => parseDocument(json)).toThrow(/referencia un bodyB inexistente/)
  })

  it('rejects explicit massMode with non-positive mass', () => {
    const doc = emptyScene()
    doc.bodies.push({
      id: 'body:explicit-zero',
      name: 'Zero Mass',
      type: 'dynamic',
      x: 0,
      y: 0,
      angle: 0,
      vx: 0,
      vy: 0,
      omega: 0,
      massMode: 'explicit',
      mass: 0,
      density: 1000,
      friction: 0.5,
      restitution: 0.2,
      materialId: 'wood',
      gravityScale: 1,
      linearDamping: 0,
      angularDamping: 0,
      ccd: false,
      locked: false,
      lockRotation: false,
      shape: { kind: 'circle', radius: 1 },
    })

    const json = JSON.stringify(doc)
    expect(() => parseDocument(json)).toThrow(/carece de masa válida|Too small/)
  })

  it('rejects documents with unknown future schema versions', () => {
    const doc = emptyScene() as unknown as Record<string, unknown>
    doc.schemaVersion = 999
    const json = JSON.stringify(doc)
    expect(() => parseDocument(json)).toThrow(/esquema más reciente/)
  })

  it('rejects documents with invalid schemaVersion <= 0', () => {
    const doc = emptyScene() as unknown as Record<string, unknown>
    doc.schemaVersion = 0
    const json = JSON.stringify(doc)
    expect(() => parseDocument(json)).toThrow(/Versión de esquema inválida/)
  })

  it('rejects joints that connect a body to itself', () => {
    const doc = emptyScene()
    doc.joints.push({
      id: 'joint:self',
      kind: 'revolute',
      bodyA: 'body:ground',
      bodyB: 'body:ground',
      anchorA: { x: 0, y: 0 },
      anchorB: { x: 0, y: 0 },
    })

    const json = JSON.stringify(doc)
    expect(() => parseDocument(json)).toThrow(/no puede conectar un cuerpo consigo mismo/)
  })

  it('rejects zero or below-minimum density', () => {
    const doc = emptyScene()
    doc.bodies[0]!.density = 0
    const json = JSON.stringify(doc)
    expect(() => parseDocument(json)).toThrow()
  })

  it('rejects non-finite numbers (Infinity/NaN)', () => {
    const doc = emptyScene()
    doc.bodies[0]!.x = Infinity
    const json = JSON.stringify(doc)
    expect(() => parseDocument(json)).toThrow()
  })

  it('rejects non-convex fluid region polygons', () => {
    const doc = emptyScene()
    doc.fluidRegions.push({
      id: 'fluid:l-shape',
      name: 'L Fluid',
      polygon: [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 1 },
        { x: 1, y: 1 },
        { x: 1, y: 2 },
        { x: 0, y: 2 },
      ],
      restSurfaceY: 1,
      materialId: 'water',
    })
    const json = JSON.stringify(doc)
    expect(() => parseDocument(json)).toThrow(/debe ser convexo/)
  })

  it('migrates unversioned documents to schemaVersion 1', () => {
    const raw = emptyScene() as unknown as Record<string, unknown>
    delete raw.schemaVersion
    const migrated = migrateDocument(raw) as SceneDocument
    expect(migrated.schemaVersion).toBe(1)
  })
})
