import type { MaterialId } from '../core/ids.ts'

export type SolidMaterial = {
  id: MaterialId
  name: string
  /** kg/m² (≡ kg/m³ con espesor 1 m). Valores numéricos = ρ 3D habitual; no cambiar sin recalibrar flotación. */
  density: number
  friction: number
  restitution: number
  linearDamping: number
  angularDamping: number
  color: number
  accent?: number
}

/**
 * Propiedades de fluido usadas por el motor (densidad, viscosidad para arrastre).
 * No modelamos capilaridad: no hay campo de tensión superficial en el contrato activo.
 */
export type FluidMaterial = {
  id: MaterialId
  name: string
  density: number
  viscosity: number
  color: number
  opacity: number
}

export const SOLID_MATERIALS: readonly SolidMaterial[] = [
  {
    id: 'wood',
    name: 'Madera',
    density: 600,
    friction: 0.5,
    restitution: 0.15,
    linearDamping: 0.05,
    angularDamping: 0.05,
    color: 0xc48a4a,
  },
  {
    id: 'cork',
    name: 'Corcho',
    density: 200,
    friction: 0.4,
    restitution: 0.1,
    linearDamping: 0.06,
    angularDamping: 0.06,
    color: 0xd2b48c,
  },
  {
    id: 'metal',
    name: 'Acero',
    density: 7800,
    friction: 0.4,
    restitution: 0.2,
    linearDamping: 0.02,
    angularDamping: 0.02,
    color: 0x8a9bb5,
  },
  {
    id: 'rubber',
    name: 'Goma',
    density: 1100,
    friction: 0.9,
    restitution: 0.75,
    linearDamping: 0.08,
    angularDamping: 0.08,
    color: 0x2c333d,
    accent: 0x3ee0c5,
  },
  {
    id: 'ice',
    name: 'Hielo',
    density: 900,
    friction: 0.05,
    restitution: 0.05,
    linearDamping: 0.01,
    angularDamping: 0.01,
    color: 0xb9e8f5,
  },
  {
    id: 'stone',
    name: 'Piedra',
    density: 2600,
    friction: 0.7,
    restitution: 0.1,
    linearDamping: 0.04,
    angularDamping: 0.04,
    color: 0x6b6560,
  },
  {
    id: 'plastic',
    name: 'Plástico',
    density: 950,
    friction: 0.35,
    restitution: 0.4,
    linearDamping: 0.04,
    angularDamping: 0.04,
    color: 0xe24b8d,
  },
]

export const FLUID_MATERIALS: readonly FluidMaterial[] = [
  {
    id: 'water',
    name: 'Agua',
    density: 1000,
    viscosity: 0.001,
    color: 0x3aa0d8,
    opacity: 0.55,
  },
  {
    id: 'oil',
    name: 'Aceite',
    density: 900,
    viscosity: 0.08,
    color: 0xc9a227,
    opacity: 0.6,
  },
  {
    id: 'honey',
    name: 'Miel',
    density: 1400,
    viscosity: 10,
    color: 0xd97706,
    opacity: 0.7,
  },
]

export const DEFAULT_SOLID = 'wood'
export const DEFAULT_FLUID = 'water'

function resolveOrFallback<T extends { id: string }>(
  kind: 'sólido' | 'fluido',
  id: string,
  list: readonly T[],
  fallbackId: string,
): T {
  const found = list.find((m) => m.id === id)
  if (found) return found
  const fallback = list.find((m) => m.id === fallbackId) ?? list[0]!
  const msg = `[materials] Material ${kind} desconocido '${id}'`
  if (import.meta.env.DEV) {
    console.error(msg)
    throw new Error(msg)
  }
  console.error(`${msg}; usando fallback '${fallback.id}'`)
  return fallback
}

export function getSolid(id: string): SolidMaterial {
  return resolveOrFallback('sólido', id, SOLID_MATERIALS, DEFAULT_SOLID)
}

export function getFluid(id: string): FluidMaterial {
  return resolveOrFallback('fluido', id, FLUID_MATERIALS, DEFAULT_FLUID)
}

/**
 * Contrato `materialId`: entradas del catálogo = presets one-shot (`applySolidPreset`).
 * En runtime la verdad son los campos planos de SceneBody; `bodyToDesc` solo reconsulta
 * `getSolid` como fallback de densidad. No hay enlace vivo catálogo ↔ cuerpo.
 */
