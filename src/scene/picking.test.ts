import { describe, expect, it } from 'vitest'
import { emptyScene } from './document.ts'
import { pickBody, shapeContains } from './picking.ts'
import type { PhysicsShape } from '../physics/ports.ts'

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

  it('supports Map and function pose providers', () => {
    const doc = emptyScene()
    const ball = {
      ...doc.bodies[0]!,
      id: 'body:ball',
      type: 'dynamic' as const,
      x: 0,
      y: 0,
      shape: { kind: 'circle' as const, radius: 0.3 },
    }
    const map = new Map([['body:ball', { x: 10, y: 10, angle: 0 }]])
    expect(pickBody([ball], 10.1, 10.1, map)).toBe('body:ball')

    const fn = (id: string) => (id === 'body:ball' ? { x: -5, y: -5, angle: 0 } : undefined)
    expect(pickBody([ball], -5.1, -5.1, fn)).toBe('body:ball')
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

describe('shapeContains for all shapes', () => {
  it('capsule shape contains points along shaft and hemispherical caps', () => {
    const capsule: PhysicsShape = { kind: 'capsule', halfHeight: 1, radius: 0.5 }
    // Center of shaft
    expect(shapeContains(capsule, { x: 0, y: 0 })).toBe(true)
    // Edge of shaft
    expect(shapeContains(capsule, { x: 0.49, y: 0.5 })).toBe(true)
    expect(shapeContains(capsule, { x: 0.55, y: 0.5 })).toBe(false)
    // Top cap (y = 1 + 0.4 = 1.4, <= 1.5)
    expect(shapeContains(capsule, { x: 0, y: 1.4 })).toBe(true)
    expect(shapeContains(capsule, { x: 0, y: 1.6 })).toBe(false)
    // Bottom cap
    expect(shapeContains(capsule, { x: 0, y: -1.4 })).toBe(true)
    expect(shapeContains(capsule, { x: 0, y: -1.6 })).toBe(false)
  })

  it('segment shape contains points within SEGMENT_HIT tolerance', () => {
    const segment: PhysicsShape = { kind: 'segment', a: { x: -1, y: 0 }, b: { x: 1, y: 0 } }
    // Exact midpoint
    expect(shapeContains(segment, { x: 0, y: 0 })).toBe(true)
    // Within tolerance (0.1 <= 0.12)
    expect(shapeContains(segment, { x: 0, y: 0.1 })).toBe(true)
    // Outside tolerance (0.2 > 0.12)
    expect(shapeContains(segment, { x: 0, y: 0.2 })).toBe(false)
    // Beyond endpoints
    expect(shapeContains(segment, { x: 1.1, y: 0 })).toBe(true)
    expect(shapeContains(segment, { x: 1.3, y: 0 })).toBe(false)
  })

  it('polyline shape contains points near any of its edges', () => {
    const polyline: PhysicsShape = {
      kind: 'polyline',
      vertices: [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 2 },
      ],
    }
    // Near first segment
    expect(shapeContains(polyline, { x: 1, y: 0.05 })).toBe(true)
    // Near corner
    expect(shapeContains(polyline, { x: 2, y: 0.05 })).toBe(true)
    // Near second segment
    expect(shapeContains(polyline, { x: 2.05, y: 1 })).toBe(true)
    // Far away
    expect(shapeContains(polyline, { x: 0.5, y: 1.5 })).toBe(false)
  })

  it('compound shape contains points matching any sub-part', () => {
    const compound: PhysicsShape = {
      kind: 'compound',
      parts: [
        { kind: 'circle', radius: 0.5 },
        { kind: 'box', hx: 2, hy: 0.2 },
      ],
    }
    // In circle
    expect(shapeContains(compound, { x: 0, y: 0.4 })).toBe(true)
    // In box wing
    expect(shapeContains(compound, { x: 1.8, y: 0.1 })).toBe(true)
    // Outside both
    expect(shapeContains(compound, { x: 1.8, y: 1 })).toBe(false)
  })

  it('convex shape contains points inside polygon', () => {
    const convex: PhysicsShape = {
      kind: 'convex',
      vertices: [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 1, y: 2 },
      ],
    }
    expect(shapeContains(convex, { x: 1, y: 0.5 })).toBe(true)
    expect(shapeContains(convex, { x: 3, y: 3 })).toBe(false)
  })
})

