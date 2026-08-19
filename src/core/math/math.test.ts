import { describe, expect, it } from 'vitest'
import {
  add,
  clipHalfPlane,
  clipPolygon,
  decomposePolygon,
  dist,
  isConvex,
  polygonArea,
  polygonCentroid,
  signedArea,
  vec2,
} from './index.ts'

describe('vec2', () => {
  it('adds and measures distance', () => {
    const out = vec2()
    add(out, vec2(3, 4), vec2(1, 2))
    expect(out).toEqual({ x: 4, y: 6 })
    expect(dist(vec2(0, 0), vec2(3, 4))).toBe(5)
  })
})

describe('polygon', () => {
  it('computes area and centroid of a unit square', () => {
    const sq = [vec2(0, 0), vec2(2, 0), vec2(2, 2), vec2(0, 2)]
    expect(polygonArea(sq)).toBeCloseTo(4, 10)
    const c = polygonCentroid(sq)
    expect(c.x).toBeCloseTo(1, 10)
    expect(c.y).toBeCloseTo(1, 10)
    expect(isConvex(sq)).toBe(true)
    expect(signedArea(sq)).toBeGreaterThan(0)
  })

  it('clips a square against a half-plane y <= 1', () => {
    const sq = [vec2(0, 0), vec2(2, 0), vec2(2, 2), vec2(0, 2)]
    const clipped = clipHalfPlane(sq, 0, 1, 1)
    expect(polygonArea(clipped)).toBeCloseTo(2, 6)
    const c = polygonCentroid(clipped)
    expect(c.y).toBeCloseTo(0.5, 6)
  })

  it('clips a square against another square (Sutherland–Hodgman)', () => {
    const a = [vec2(0, 0), vec2(2, 0), vec2(2, 2), vec2(0, 2)]
    const b = [vec2(1, 1), vec2(3, 1), vec2(3, 3), vec2(1, 3)]
    const clipped = clipPolygon(a, b)
    expect(polygonArea(clipped)).toBeCloseTo(1, 6)
  })

  it('decomposes an L-shape into convex parts covering the original area', () => {
    const L = [
      vec2(0, 0),
      vec2(2, 0),
      vec2(2, 1),
      vec2(1, 1),
      vec2(1, 2),
      vec2(0, 2),
    ]
    expect(isConvex(L)).toBe(false)
    const parts = decomposePolygon(L)
    expect(parts.length).toBeGreaterThanOrEqual(1)
    for (const p of parts) expect(isConvex(p)).toBe(true)
    const area = parts.reduce((s, p) => s + polygonArea(p), 0)
    expect(area).toBeCloseTo(3, 5)
  })
})

describe('aabbFromShape', () => {
  it('computes bounding box for circle and rotated box', async () => {
    const { aabbFromShape } = await import('./aabb.ts')
    const circleBox = aabbFromShape({ kind: 'circle', radius: 2 }, { x: 5, y: 5, angle: 0 })
    expect(circleBox).toEqual({ minX: 3, minY: 3, maxX: 7, maxY: 7 })

    const boxBox = aabbFromShape({ kind: 'box', hx: 1, hy: 2 }, { x: 0, y: 0, angle: Math.PI / 2 })
    expect(boxBox.minX).toBeCloseTo(-2, 4)
    expect(boxBox.maxX).toBeCloseTo(2, 4)
    expect(boxBox.minY).toBeCloseTo(-1, 4)
    expect(boxBox.maxY).toBeCloseTo(1, 4)
  })

  it('computes bounding box for capsule, polyline and segment', async () => {
    const { aabbFromShape } = await import('./aabb.ts')
    const capBox = aabbFromShape({ kind: 'capsule', halfHeight: 2, radius: 0.5 }, { x: 0, y: 0, angle: 0 })
    expect(capBox.minX).toBeCloseTo(-0.5, 4)
    expect(capBox.maxX).toBeCloseTo(0.5, 4)
    expect(capBox.minY).toBeCloseTo(-2.5, 4)
    expect(capBox.maxY).toBeCloseTo(2.5, 4)

    const segBox = aabbFromShape({ kind: 'segment', a: { x: -1, y: 0 }, b: { x: 3, y: 4 } }, { x: 0, y: 0, angle: 0 })
    expect(segBox).toEqual({ minX: -1, minY: 0, maxX: 3, maxY: 4 })
  })
})

