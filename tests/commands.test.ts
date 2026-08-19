import { describe, expect, it } from 'vitest'
import { emptyScene, type SceneBody, type SceneDocument, type SceneFluidRegion } from '../src/scene/document.ts'
import { History } from '../src/scene/history.ts'
import {
  AddBodyCommand,
  BatchCommand,
  RemoveBodyCommand,
  RemoveFluidCommand,
  UpdateBodyCommand,
} from '../src/scene/commands.ts'

function sampleBody(id: string, x = 0): SceneBody {
  return {
    id,
    name: id,
    type: 'dynamic',
    x,
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
  }
}

describe('scene commands & index preservation', () => {
  it('preserves the original array index of a removed body on undo', () => {
    let doc: SceneDocument = emptyScene()
    const history = new History(
      () => doc,
      (d) => {
        doc = d
      },
    )

    history.apply(new AddBodyCommand(sampleBody('b1', 1)))
    history.apply(new AddBodyCommand(sampleBody('b2', 2)))
    history.apply(new AddBodyCommand(sampleBody('b3', 3)))

    expect(doc.bodies.map((b) => b.id)).toEqual(['body:ground', 'b1', 'b2', 'b3'])

    // Remove the middle element b2
    history.apply(new RemoveBodyCommand('b2'))
    expect(doc.bodies.map((b) => b.id)).toEqual(['body:ground', 'b1', 'b3'])

    // Undo should restore b2 at index 2, not append at the end
    history.undo()
    expect(doc.bodies.map((b) => b.id)).toEqual(['body:ground', 'b1', 'b2', 'b3'])
  })

  it('preserves the original array index of a removed fluid on undo', () => {
    let doc: SceneDocument = emptyScene()
    const history = new History(
      () => doc,
      (d) => {
        doc = d
      },
    )

    const f1: SceneFluidRegion = { id: 'f1', name: 'F1', polygon: [], restSurfaceY: 0, materialId: 'water' }
    const f2: SceneFluidRegion = { id: 'f2', name: 'F2', polygon: [], restSurfaceY: 0, materialId: 'water' }
    const f3: SceneFluidRegion = { id: 'f3', name: 'F3', polygon: [], restSurfaceY: 0, materialId: 'water' }

    doc.fluidRegions.push(f1, f2, f3)

    history.apply(new RemoveFluidCommand('f2'))
    expect(doc.fluidRegions.map((f) => f.id)).toEqual(['f1', 'f3'])

    history.undo()
    expect(doc.fluidRegions.map((f) => f.id)).toEqual(['f1', 'f2', 'f3'])
  })

  it('UpdateBodyCommand with explicit previous state restores recorded state', () => {
    let doc: SceneDocument = emptyScene()
    const history = new History(
      () => doc,
      (d) => {
        doc = d
      },
    )

    history.apply(new AddBodyCommand(sampleBody('b1', 10)))
    expect(doc.bodies.find((b) => b.id === 'b1')!.x).toBe(10)

    // Simulate drag start at x: 10, intermediate drag, finished at x: 25
    history.apply(new UpdateBodyCommand('b1', { x: 25 }, { x: 10 }))
    expect(doc.bodies.find((b) => b.id === 'b1')!.x).toBe(25)

    history.undo()
    expect(doc.bodies.find((b) => b.id === 'b1')!.x).toBe(10)
  })

  it('BatchCommand applies and inverts multiple commands atomically', () => {
    let doc: SceneDocument = emptyScene()
    const history = new History(
      () => doc,
      (d) => {
        doc = d
      },
    )

    const batch = new BatchCommand([
      new AddBodyCommand(sampleBody('b1', 1)),
      new AddBodyCommand(sampleBody('b2', 2)),
    ])

    history.apply(batch)
    expect(doc.bodies.find((b) => b.id === 'b1')).toBeDefined()
    expect(doc.bodies.find((b) => b.id === 'b2')).toBeDefined()

    history.undo()
    expect(doc.bodies.find((b) => b.id === 'b1')).toBeUndefined()
    expect(doc.bodies.find((b) => b.id === 'b2')).toBeUndefined()
  })
})
