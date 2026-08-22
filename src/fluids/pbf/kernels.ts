/**
 * Clavet double-density kernels (2D). Rest density is measured on the same
 * hexagonal lattice used to seed volumes — never a copied constant.
 */

/**
 * Σ_j (1 − r_ij / h)² on a hex lattice of spacing `s` (row height s√3/2)
 * inside the disk of radius `h`, including the center particle.
 */
export function clavetRestDensity(s: number, h: number): number {
  if (s <= 0 || h <= 0) return 1
  const rowH = s * 0.8660254037844386
  const nRows = Math.ceil(h / rowH) + 2
  const nCols = Math.ceil(h / s) + 2
  let rho = 0
  for (let row = -nRows; row <= nRows; row++) {
    const y = row * rowH
    const xOff = (row & 1) !== 0 ? s * 0.5 : 0
    for (let col = -nCols; col <= nCols; col++) {
      const x = col * s + xOff
      const r = Math.hypot(x, y)
      if (r >= h) continue
      const w = 1 - r / h
      rho += w * w
    }
  }
  return rho
}

export function xsphEpsilon(mu: number): number {
  if (mu >= 1) return 0.45
  if (mu >= 0.02) return 0.18
  return 0.12
}
