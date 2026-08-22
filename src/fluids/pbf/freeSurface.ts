/**
 * Estimate the free-surface plane offset d for the half-plane n·p ≤ d
 * (same convention as analytic clipHalfPlane: n is −ĝ, so “up”).
 *
 * Particles are binned along the tangent. Each occupied column contributes its
 * max height; the median of those maxes ignores splash columns. Callers should
 * skip the body's own tangent column so a film of water riding on the body
 * cannot report the free surface at the body's roof (levitation).
 */
export function estimateFreeSurfaceD(args: {
  x: ArrayLike<number>
  y: ArrayLike<number>
  n: number
  nx: number
  ny: number
  tMin: number
  tMax: number
  sMin: number
  sMax: number
  columnWidth: number
  skip?: (i: number, s: number, t: number) => boolean
}): number | null {
  const { x, y, n, nx, ny, skip } = args
  const tMin = args.tMin
  const tMax = args.tMax
  const tSpan = tMax - tMin
  if (n <= 0 || tSpan < 1e-9) return null
  const colW = Math.max(args.columnWidth, tSpan / 48, 1e-3)
  const nCol = Math.max(1, Math.ceil(tSpan / colW))
  const colMax = new Float64Array(nCol)
  const colCount = new Int32Array(nCol)
  colMax.fill(Number.NEGATIVE_INFINITY)
  const tx = -ny
  const ty = nx

  let kept = 0
  for (let i = 0; i < n; i++) {
    const px = x[i]!
    const py = y[i]!
    const t = px * tx + py * ty
    if (t < tMin || t > tMax) continue
    const s = px * nx + py * ny
    if (s < args.sMin || s > args.sMax) continue
    if (skip?.(i, s, t)) continue
    const ci = Math.min(nCol - 1, Math.max(0, Math.floor(((t - tMin) / tSpan) * nCol)))
    colCount[ci]!++
    if (s > colMax[ci]!) colMax[ci] = s
    kept++
  }
  if (kept < 4) return null

  // Need ≥2 particles in a column so a lone splash/film particle cannot set height.
  const heights: number[] = []
  for (let c = 0; c < nCol; c++) {
    if (colCount[c]! < 2) continue
    const h = colMax[c]!
    if (Number.isFinite(h)) heights.push(h)
  }
  if (heights.length < 2) return null
  heights.sort((a, b) => a - b)
  return heights[Math.floor(heights.length / 2)]!
}
