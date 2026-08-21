import { describe, expect, it } from 'vitest'
import {
  findOverlappingFluidRegions,
  fluidOverlapWarning,
} from '../src/scene/fluidOverlap.ts'
import type { SceneFluidRegion } from '../src/scene/document.ts'

function region(
  id: string,
  name: string,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): SceneFluidRegion {
  return {
    id,
    name,
    polygon: [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ],
    restSurfaceY: maxY,
    materialId: 'water',
  }
}

describe('fluidOverlap', () => {
  it('detects AABB overlap between regions', () => {
    const pairs = findOverlappingFluidRegions([
      region('a', 'Agua', 0, 0, 2, 2),
      region('b', 'Aceite', 1, 1, 3, 3),
    ])
    expect(pairs).toEqual([{ aId: 'a', bId: 'b', aName: 'Agua', bName: 'Aceite' }])
    expect(fluidOverlapWarning([region('a', 'Agua', 0, 0, 2, 2), region('b', 'Aceite', 1, 1, 3, 3)]))
      .toMatch(/solapadas/)
  })

  it('returns empty when AABBs are disjoint', () => {
    const regions = [region('a', 'A', 0, 0, 1, 1), region('b', 'B', 2, 2, 3, 3)]
    expect(findOverlappingFluidRegions(regions)).toEqual([])
    expect(fluidOverlapWarning(regions)).toBeNull()
  })
})
