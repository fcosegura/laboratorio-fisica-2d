import { describe, expect, it } from 'vitest'
import { emptyScene } from '../src/scene/document.ts'
import { History } from '../src/scene/history.ts'
import { AddBodyCommand, RemoveBodyCommand, UpdateBodyCommand } from '../src/scene/commands.ts'
import { getSolid } from '../src/materials/catalog.ts'
import { parseDocument, serializeDocument } from '../src/scene/schema.ts'
import type { SceneBody, SceneDocument } from '../src/scene/document.ts'

function woodBall(id: string): SceneBody {
  const mat = getSolid('wood')
  return {
    id,
    name: 'Bola',
    type: 'dynamic',
    x: 0,
    y: 2,
    angle: 0,
    vx: 0,
    vy: 0,
    omega: 0,
    massMode: 'density',
    density: mat.density,
    friction: mat.friction,
    restitution: mat.restitution,
    materialId: 'wood',
    gravityScale: 1,
    linearDamping: 0,
    angularDamping: 0,
    ccd: false,
    locked: false,
    lockRotation: false,
    shape: { kind: 'circle', radius: 0.3 },
  }
}

describe('serialization', () => {
  it('loads the v1 fixture', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const text = readFileSync(join(import.meta.dirname, 'fixtures', 'scene-v1.json'), 'utf8')
    const doc = parseDocument(text)
    expect(doc.schemaVersion).toBe(1)
    expect(doc.meta.name).toBe('Fixture v1')
  })

  it('round-trips an empty scene', () => {
    const doc = emptyScene('Prueba')
    const again = parseDocument(serializeDocument(doc))
    expect(again.meta.name).toBe('Prueba')
    expect(again.bodies.length).toBe(doc.bodies.length)
    expect(again.world.gravity.y).toBeCloseTo(-9.81)
  })

  it('rejects invalid documents', () => {
    expect(() => parseDocument('{"schemaVersion":1}')).toThrow()
  })
})

describe('history', () => {
  it('undoes a random stream of add/remove/update commands', () => {
    let doc: SceneDocument = emptyScene()
    const history = new History(
      () => doc,
      (d) => {
        doc = d
      },
    )
    const initial = serializeDocument(doc)
    for (let i = 0; i < 80; i++) {
      const roll = i % 3
      if (roll === 0) history.apply(new AddBodyCommand(woodBall(`body:extra:${i}`)))
      else if (roll === 1 && doc.bodies.length > 1) {
        history.apply(new RemoveBodyCommand(doc.bodies[doc.bodies.length - 1]!.id))
      } else if (doc.bodies.length) {
        history.apply(new UpdateBodyCommand(doc.bodies[0]!.id, { x: i * 0.01 }))
      }
    }
    while (history.canUndo()) history.undo()
    expect(serializeDocument(doc)).toBe(initial)
  })
})
