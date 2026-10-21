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

/**
 * Solid-boundary terms for a particle at distance d (0..h) from a flat solid surface.
 * Ghost particles continue the seeding hex lattice behind the surface (first real layer at
 * s/2, ghost rows at s/2 − k·rowH, k ≥ 1), averaged over the two row phases. Without them a
 * particle at a wall misses half its neighbors, reads under-dense, and the fluid presses it
 * into the wall (pumping water up slanted walls and around corners).
 *
 * - rho / rhoNear: Σ w², Σ w³ over the ghosts (added to the particle's densities).
 * - push / pushNear: Σ w (n̂·r̂), Σ w² (n̂·r̂): normal weights of the Clavet relaxation push
 *   from ghosts carrying the particle's own pressure (mirror).
 */
export type WallTables = {
  h: number
  samples: number
  rho: Float64Array
  rhoNear: Float64Array
  push: Float64Array
  pushNear: Float64Array
}

export function clavetWallTables(s: number, h: number, samples = 64): WallTables {
  const rho = new Float64Array(samples + 1)
  const rhoNear = new Float64Array(samples + 1)
  const push = new Float64Array(samples + 1)
  const pushNear = new Float64Array(samples + 1)
  const rowH = s * 0.8660254037844386
  const nCols = Math.ceil(h / s) + 2
  for (let k = 0; k <= samples; k++) {
    const d = (k / samples) * h
    let r2 = 0
    let r3 = 0
    let p1 = 0
    let p2 = 0
    for (const phase of [0, 0.5]) {
      for (let row = 1; ; row++) {
        const dz = d - (s * 0.5 - row * rowH)
        if (dz >= h) break
        for (let col = -nCols; col <= nCols; col++) {
          const x = (col + phase) * s
          const r = Math.hypot(x, dz)
          if (r >= h || r < 1e-12) continue
          const w = 1 - r / h
          const cn = dz / r
          r2 += w * w
          r3 += w * w * w
          p1 += w * cn
          p2 += w * w * cn
        }
      }
    }
    rho[k] = r2 / 2
    rhoNear[k] = r3 / 2
    push[k] = p1 / 2
    pushNear[k] = p2 / 2
  }
  return { h, samples, rho, rhoNear, push, pushNear }
}

/** Linear lookup of a wall table at distance d (clamped to [0, h]). */
export function wallLookup(t: WallTables, table: Float64Array, d: number): number {
  const f = (Math.min(Math.max(d, 0), t.h) / t.h) * t.samples
  const i = Math.min(t.samples - 1, Math.floor(f))
  const a = f - i
  return table[i]! * (1 - a) + table[i + 1]! * a
}
