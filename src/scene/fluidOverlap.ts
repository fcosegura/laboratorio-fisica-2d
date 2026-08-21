/**
 * Política de solapes entre regiones de fluido (PR5 / D6, corto plazo):
 *
 * - Detectamos solape por AABB de los polígonos de autoría.
 * - La UI muestra un aviso muted; no mutamos el documento ni el solver.
 * - AnalyticFluid sigue aplicando fuerzas de todas las regiones (suma).
 *   Un guard “solo la de mayor solape” queda aplazado para no pelear un
 *   retuning del solver.
 */
import { aabbFromPoints, intersectsAABB } from '../core/math/aabb.ts'
import type { SceneFluidRegion } from './document.ts'

export type FluidOverlapPair = {
  aId: string
  bId: string
  aName: string
  bName: string
}

export function findOverlappingFluidRegions(
  regions: readonly SceneFluidRegion[],
): FluidOverlapPair[] {
  const pairs: FluidOverlapPair[] = []
  for (let i = 0; i < regions.length; i++) {
    const a = regions[i]!
    if (a.polygon.length < 3) continue
    const boxA = aabbFromPoints(a.polygon)
    for (let j = i + 1; j < regions.length; j++) {
      const b = regions[j]!
      if (b.polygon.length < 3) continue
      if (intersectsAABB(boxA, aabbFromPoints(b.polygon))) {
        pairs.push({ aId: a.id, bId: b.id, aName: a.name, bName: b.name })
      }
    }
  }
  return pairs
}

/** Mensaje corto para el inspector / HUD. Null si no hay solapes AABB. */
export function fluidOverlapWarning(regions: readonly SceneFluidRegion[]): string | null {
  const pairs = findOverlappingFluidRegions(regions)
  if (!pairs.length) return null
  if (pairs.length === 1) {
    const p = pairs[0]!
    return `Regiones solapadas (AABB): «${p.aName}» y «${p.bName}». Las fuerzas se suman.`
  }
  return `${pairs.length} pares de regiones con AABB solapado. Las fuerzas se suman.`
}
