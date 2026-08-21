import { getSolid } from './catalog.ts'

/**
 * Contrato `materialId`: el catálogo es preset one-shot. Esta función copia valores al SceneBody;
 * después, la verdad en runtime son los campos planos del cuerpo. `bodyToDesc` no vuelve a
 * sincronizar el material — solo reconsulta el catálogo como fallback de densidad.
 */

/** Minimal body fields needed to decide mass policy (avoids importing `scene`). */
export type SolidPresetCurrent = {
  massMode?: 'density' | 'explicit'
}

/** Full catalog sync (density mode). */
export type SolidPresetFull = {
  materialId: string
  friction: number
  restitution: number
  linearDamping: number
  angularDamping: number
  density: number
  massMode: 'density'
}

/**
 * Patch when selecting a solid material.
 * Contact + damping always; density/massMode omitted if current mass is explicit.
 */
export type SolidPresetPatch = {
  materialId: string
  friction: number
  restitution: number
  linearDamping: number
  angularDamping: number
  density?: number
  massMode?: 'density'
}

/** New bodies / density mode: always returns the full catalog sync. */
export function applySolidPreset(materialId: string): SolidPresetFull
/** Inspector / existing body: respects explicit mass (no density/massMode). */
export function applySolidPreset(
  materialId: string,
  current: SolidPresetCurrent,
): SolidPresetPatch
export function applySolidPreset(
  materialId: string,
  current?: SolidPresetCurrent,
): SolidPresetPatch {
  const mat = getSolid(materialId)
  const contactAndDamping = {
    materialId: mat.id,
    friction: mat.friction,
    restitution: mat.restitution,
    linearDamping: mat.linearDamping,
    angularDamping: mat.angularDamping,
  }
  if (current?.massMode === 'explicit') {
    return contactAndDamping
  }
  return {
    ...contactAndDamping,
    density: mat.density,
    massMode: 'density',
  }
}
