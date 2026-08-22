/**
 * Uniform-grid spatial hash via counting-sort. Reused typed arrays, zero Map.
 * Cell size should be ≥ the query radius so a 3×3 neighborhood finds all pairs.
 */
export class CountingSortGrid {
  start: Int32Array = new Int32Array(1)
  order: Int32Array = new Int32Array(0)
  cellOf: Int32Array = new Int32Array(0)
  private counts: Int32Array = new Int32Array(0)
  private nCellsX = 0
  private nCellsY = 0
  private n = 0

  build(px: ArrayLike<number>, py: ArrayLike<number>, n: number, cellSize: number): void {
    if (n <= 0 || cellSize <= 0) {
      this.n = 0
      this.nCellsX = 0
      this.nCellsY = 0
      this.start = new Int32Array(1)
      return
    }

    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (let i = 0; i < n; i++) {
      const x = px[i]!
      const y = py[i]!
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }

    const inv = 1 / cellSize
    const nCellsX = Math.max(1, Math.floor((maxX - minX) * inv) + 1)
    const nCellsY = Math.max(1, Math.floor((maxY - minY) * inv) + 1)
    const nCells = nCellsX * nCellsY

    const cellOf = growInt32(this.cellOf, n)
    const order = growInt32(this.order, n)
    const counts = growInt32(this.counts, nCells)
    const start = growInt32(this.start, nCells + 1)
    counts.fill(0, 0, nCells)

    for (let i = 0; i < n; i++) {
      const cx = Math.min(nCellsX - 1, Math.max(0, Math.floor((px[i]! - minX) * inv)))
      const cy = Math.min(nCellsY - 1, Math.max(0, Math.floor((py[i]! - minY) * inv)))
      const cell = cx + cy * nCellsX
      cellOf[i] = cell
      counts[cell]!++
    }

    start[0] = 0
    for (let c = 0; c < nCells; c++) start[c + 1] = start[c]! + counts[c]!
    counts.set(start.subarray(0, nCells))
    for (let i = 0; i < n; i++) {
      const c = cellOf[i]!
      order[counts[c]!] = i
      counts[c]!++
    }

    this.cellOf = cellOf
    this.order = order
    this.start = start
    this.counts = counts
    this.nCellsX = nCellsX
    this.nCellsY = nCellsY
    this.n = n
  }

  queryNeighbors(i: number, visit: (j: number) => void): void {
    const n = this.n
    if (i < 0 || i >= n) return
    const nCx = this.nCellsX
    const nCy = this.nCellsY
    const cell = this.cellOf[i]!
    const cx = cell % nCx
    const cy = (cell / nCx) | 0
    const start = this.start
    const order = this.order
    for (let oy = -1; oy <= 1; oy++) {
      const ny = cy + oy
      if (ny < 0 || ny >= nCy) continue
      for (let ox = -1; ox <= 1; ox++) {
        const nx = cx + ox
        if (nx < 0 || nx >= nCx) continue
        const c = nx + ny * nCx
        const a = start[c]!
        const b = start[c + 1]!
        for (let k = a; k < b; k++) visit(order[k]!)
      }
    }
  }
}

export function buildCountingSort(
  px: ArrayLike<number>,
  py: ArrayLike<number>,
  n: number,
  cellSize: number,
  out: CountingSortGrid,
): CountingSortGrid {
  out.build(px, py, n, cellSize)
  return out
}

function growInt32(arr: Int32Array, need: number): Int32Array {
  if (arr.length >= need) return arr
  return new Int32Array(Math.max(need, arr.length * 2 || 16))
}
