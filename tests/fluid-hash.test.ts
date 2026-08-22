import { describe, expect, it } from 'vitest'
import { CountingSortGrid, buildCountingSort } from '../src/fluids/pbf/hash.ts'

describe('counting-sort spatial hash', () => {
  it('queryNeighbors finds every pair closer than cell size among 100 points', () => {
    const n = 100
    const px = new Float64Array(n)
    const py = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      px[i] = (i % 10) * 0.08
      py[i] = Math.floor(i / 10) * 0.08
    }
    const cell = 0.1
    const grid = new CountingSortGrid()
    buildCountingSort(px, py, n, cell, grid)
    expect(grid.order.length).toBeGreaterThanOrEqual(n)
    expect(grid.cellOf.length).toBeGreaterThanOrEqual(n)

    for (let i = 0; i < n; i++) {
      const found = new Set<number>()
      grid.queryNeighbors(i, (j) => found.add(j))
      expect(found.has(i)).toBe(true)
      for (let j = 0; j < n; j++) {
        if (i === j) continue
        const r = Math.hypot(px[i]! - px[j]!, py[i]! - py[j]!)
        if (r < cell) expect(found.has(j)).toBe(true)
      }
    }
  })

  it('reuses buffers across rebuilds', () => {
    const grid = new CountingSortGrid()
    const px = new Float64Array([0, 0.05, 1])
    const py = new Float64Array([0, 0, 0])
    buildCountingSort(px, py, 3, 0.1, grid)
    const startRef = grid.start
    const orderRef = grid.order
    buildCountingSort(px, py, 3, 0.1, grid)
    expect(grid.start).toBe(startRef)
    expect(grid.order).toBe(orderRef)
  })
})
