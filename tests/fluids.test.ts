import { describe, expect, it } from 'vitest'
import {
  capsuleToPolygon,
  clipHalfPlane,
  polygonArea,
  polygonCentroid,
} from '../src/core/math/polygon.ts'
import { planeSpan } from '../src/fluids/analytic/AnalyticFluid.ts'

describe('hydrostatic clipping', () => {
  it('submerged rectangle of height h has area w*h and centroid at h/2', () => {
    const rect = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 3 },
      { x: 0, y: 3 },
    ]
    const clipped = clipHalfPlane(rect, 0, 1, 1.2)
    expect(polygonArea(clipped)).toBeCloseTo(2.4, 6)
    const c = polygonCentroid(clipped)
    expect(c.x).toBeCloseTo(1, 6)
    expect(c.y).toBeCloseTo(0.6, 6)
  })

  it('clips along −g, not a hardcoded horizontal plane', () => {
    const rect = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
    ]
    const gx = 1
    const gy = 0
    const nx = -gx
    const ny = -gy
    const clipped = clipHalfPlane(rect, nx, ny, nx * 1)
    expect(polygonArea(clipped)).toBeCloseTo(2, 5)
  })
})

describe('capsule stadium', () => {
  it('approximates 2 r (2 h) + π r², not a circle of max(h, r)', () => {
    const h = 1
    const r = 0.25
    const poly = capsuleToPolygon(0, 0, h, r, 0, 24)
    const area = polygonArea(poly)
    const stadium = 4 * h * r + Math.PI * r * r
    const circleMax = Math.PI * Math.max(h, r) ** 2
    expect(Math.abs(area - stadium) / stadium).toBeLessThan(0.05)
    expect(Math.abs(area - circleMax) / circleMax).toBeGreaterThan(0.5)
  })
})

describe('planeSpan', () => {
  it('matches the x-span of a horizontal free surface', () => {
    const tank = [
      { x: -3, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 2.5 },
      { x: -3, y: 2.5 },
    ]
    expect(planeSpan(tank, 0, 1, 2.5)).toBeCloseTo(6, 6)
  })
})
