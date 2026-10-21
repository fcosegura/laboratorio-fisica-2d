/**
 * Density kernel W(r) = (1 − r/h)² (2D), the one Clavet's double density used, now driving
 * the PBF density constraint. Normalization is irrelevant: ρ0 is measured on the same
 * hexagonal lattice used to seed volumes — never a copied constant — and C_i = ρ_i / ρ0 − 1.
 */

/**
 * Σ_j (1 − r_ij / h)² on a hex lattice of spacing `s` (row height s√3/2)
 * inside the disk of radius `h`, including the center particle.
 */
export function clavetRestDensity(s: number, h: number): number {
  let rho = 0
  forEachLatticeNeighbor(s, h, (w) => {
    rho += w * w
  })
  return rho || 1
}

/**
 * Σ_j |∇W(r_ij)|² / ρ0² on the rest lattice: the PBF λ denominator of an interior particle
 * at rest (the own-gradient term is 0 by symmetry). Scales the relaxation ε and s_corr.
 */
export function pbfRestGradSq(s: number, h: number): number {
  const rho0 = clavetRestDensity(s, h)
  let sum = 0
  forEachLatticeNeighbor(s, h, (w, r) => {
    if (r < 1e-12) return
    const g = (2 * w) / h / rho0
    sum += g * g
  })
  return sum || 1
}

function forEachLatticeNeighbor(s: number, h: number, visit: (w: number, r: number) => void): void {
  if (s <= 0 || h <= 0) return
  const rowH = s * 0.8660254037844386
  const nRows = Math.ceil(h / rowH) + 2
  const nCols = Math.ceil(h / s) + 2
  for (let row = -nRows; row <= nRows; row++) {
    const y = row * rowH
    const xOff = (row & 1) !== 0 ? s * 0.5 : 0
    for (let col = -nCols; col <= nCols; col++) {
      const x = col * s + xOff
      const r = Math.hypot(x, y)
      if (r >= h) continue
      visit(1 - r / h, r)
    }
  }
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
 * - rho: Σ w² over the ghosts (added to the particle's density).
 * - push: Σ w (n̂·r̂), so the ghosts' density gradient is ∇ρ = −(2/h)·push·n̂ (they never
 *   move: it enters the particle's own constraint gradient only).
 */
export type WallTables = {
  h: number
  samples: number
  rho: Float64Array
  push: Float64Array
}

export function clavetWallTables(s: number, h: number, samples = 64): WallTables {
  const rho = new Float64Array(samples + 1)
  const push = new Float64Array(samples + 1)
  const rowH = s * 0.8660254037844386
  const nCols = Math.ceil(h / s) + 2
  for (let k = 0; k <= samples; k++) {
    const d = (k / samples) * h
    let r2 = 0
    let p1 = 0
    for (const phase of [0, 0.5]) {
      for (let row = 1; ; row++) {
        const dz = d - (s * 0.5 - row * rowH)
        if (dz >= h) break
        for (let col = -nCols; col <= nCols; col++) {
          const x = (col + phase) * s
          const r = Math.hypot(x, dz)
          if (r >= h || r < 1e-12) continue
          const w = 1 - r / h
          r2 += w * w
          p1 += (w * dz) / r
        }
      }
    }
    rho[k] = r2 / 2
    push[k] = p1 / 2
  }
  return { h, samples, rho, push }
}

/** Linear lookup of a wall table at distance d (clamped to [0, h]). */
export function wallLookup(t: WallTables, table: Float64Array, d: number): number {
  const f = (Math.min(Math.max(d, 0), t.h) / t.h) * t.samples
  const i = Math.min(t.samples - 1, Math.floor(f))
  const a = f - i
  return table[i]! * (1 - a) + table[i + 1]! * a
}
