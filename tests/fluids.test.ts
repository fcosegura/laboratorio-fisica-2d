import { describe, expect, it } from 'vitest'
import { clipHalfPlane, polygonArea, polygonCentroid } from '../src/core/math/polygon.ts'

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
})
