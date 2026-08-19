import { describe, expect, it } from 'vitest'
import { emptyScene } from './document.ts'
import { pickBody } from './picking.ts'

describe('pickBody', () => {
  it('hits a circle at its live pose, even if the document pose is stale', () => {
    const doc = emptyScene()
    const ball = {
      ...doc.bodies[0]!,
      id: 'body:ball',
      type: 'dynamic' as const,
      x: 0,
      y: 0,
      shape: { kind: 'circle' as const, radius: 0.3 },
    }
    expect(pickBody([ball], 0.1, 0.1)).toBe('body:ball')
    expect(pickBody([ball], 2, 2)).toBeNull()
    expect(pickBody([ball], 0.1, 0.1, [{ id: 'body:ball', x: 4, y: 4, angle: 0 }])).toBeNull()
    expect(pickBody([ball], 4.1, 4, [{ id: 'body:ball', x: 4, y: 4, angle: 0 }])).toBe('body:ball')
  })

  it('hits a rotated box in local space', () => {
    const box = {
      ...emptyScene().bodies[0]!,
      id: 'body:box',
      type: 'dynamic' as const,
      x: 0,
      y: 0,
      angle: Math.PI / 2,
      shape: { kind: 'box' as const, hx: 1, hy: 0.2 },
    }
    expect(pickBody([box], 0, 0.5)).toBe('body:box')
    expect(pickBody([box], 0.5, 0)).toBeNull()
  })

  it('prefers the last overlapping body and honors predicates', () => {
    const ground = emptyScene().bodies[0]!
    const ball = {
      ...ground,
      id: 'body:ball',
      type: 'dynamic' as const,
      x: 0,
      y: -0.25,
      shape: { kind: 'circle' as const, radius: 0.4 },
    }
    expect(pickBody([ground, ball], 0, -0.25)).toBe('body:ball')
    expect(pickBody([ground, ball], 0, -0.25, undefined, (b) => b.type === 'dynamic')).toBe('body:ball')
    expect(pickBody([ground, ball], 0, -0.25, undefined, (b) => b.type === 'fixed')).toBe(ground.id)
  })
})
