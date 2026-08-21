export type PropertyDescriptor = {
  min?: number
  max?: number
  step?: number
  unit?: string
  label?: string
}

export const PROPERTY_DESCRIPTORS = {
  x: { step: 0.01, unit: 'm', label: 'x' },
  y: { step: 0.01, unit: 'm', label: 'y' },
  angleDeg: { step: 1, unit: '°', label: 'θ' },
  vx: { step: 0.1, unit: 'm/s', label: 'vx' },
  vy: { step: 0.1, unit: 'm/s', label: 'vy' },
  omega: { step: 0.1, unit: 'rad/s', label: 'ω' },
  density: {
    min: 0.01,
    max: 100_000,
    step: 10,
    unit: 'kg/m² (≡ kg/m³ con espesor 1 m)',
    label: 'Densidad',
  },
  mass: { min: 0.001, max: 1_000_000, step: 0.1, unit: 'kg', label: 'Masa' },
  friction: { min: 0, max: 10, step: 0.05, label: 'Fricción' },
  restitution: { min: 0, max: 2, step: 0.05, label: 'Restitución' },
  gravityScale: { min: -50, max: 50, step: 0.1, label: 'Escala g' },
  linearDamping: { min: 0, max: 100, step: 0.05, label: 'Amortiguación lineal' },
  angularDamping: { min: 0, max: 100, step: 0.05, label: 'Amortiguación angular' },
  timeScale: { min: 0.05, max: 5, step: 0.1, label: 'Escala de tiempo' },
  stiffness: { min: 0, max: 1_000_000, step: 10, label: 'Rigidez' },
  damping: { min: 0, max: 10_000, step: 0.5, label: 'Amortiguación' },
  restLength: { min: 0, max: 1000, step: 0.05, unit: 'm', label: 'Longitud' },
} as const satisfies Record<string, PropertyDescriptor>

export function clampProperty(value: number, desc?: PropertyDescriptor): number {
  if (!Number.isFinite(value)) return desc?.min ?? 0
  if (!desc) return value
  let result = value
  if (desc.min !== undefined && result < desc.min) result = desc.min
  if (desc.max !== undefined && result > desc.max) result = desc.max
  return result
}

export function parseAndClamp(raw: string, desc?: PropertyDescriptor): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const num = Number(trimmed)
  if (!Number.isFinite(num)) return null
  return clampProperty(num, desc)
}

