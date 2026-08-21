import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_FLUID,
  DEFAULT_SOLID,
  FLUID_MATERIALS,
  SOLID_MATERIALS,
  getFluid,
  getSolid,
} from '../src/materials/catalog.ts'
import { applySolidPreset } from '../src/materials/applyPreset.ts'

describe('catalog', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('includes cork with expected mechanical properties', () => {
    const cork = getSolid('cork')
    expect(cork.name).toBe('Corcho')
    expect(cork.density).toBe(200)
    expect(cork.friction).toBe(0.4)
    expect(cork.restitution).toBe(0.1)
    expect(cork.linearDamping).toBeGreaterThan(0)
    expect(cork.angularDamping).toBeGreaterThan(0)
    expect(Number.isFinite(cork.color)).toBe(true)
  })

  it('labels metal as Acero without changing id', () => {
    const metal = getSolid('metal')
    expect(metal.id).toBe('metal')
    expect(metal.name).toBe('Acero')
  })

  it('FluidMaterial has no surfaceTension field (no capillarity)', () => {
    for (const mat of FLUID_MATERIALS) {
      expect(mat).not.toHaveProperty('surfaceTension')
      expect(mat.density).toBeGreaterThan(0)
      expect(mat.viscosity).toBeGreaterThanOrEqual(0)
    }
  })

  it('applySolidPreset works with cork', () => {
    const patch = applySolidPreset('cork')
    expect(patch.materialId).toBe('cork')
    expect(patch.density).toBe(200)
    expect(patch.massMode).toBe('density')
  })

  it('getSolid / getFluid throw in DEV on unknown id', () => {
    expect(import.meta.env.DEV).toBe(true)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => getSolid('no-such-solid')).toThrow(/Material sólido desconocido/)
    expect(() => getFluid('no-such-fluid')).toThrow(/Material fluido desconocido/)
    expect(err).toHaveBeenCalled()
  })

  it('default ids resolve to catalog entries', () => {
    expect(SOLID_MATERIALS.some((m) => m.id === DEFAULT_SOLID)).toBe(true)
    expect(FLUID_MATERIALS.some((m) => m.id === DEFAULT_FLUID)).toBe(true)
    expect(getSolid(DEFAULT_SOLID).id).toBe(DEFAULT_SOLID)
    expect(getFluid(DEFAULT_FLUID).id).toBe(DEFAULT_FLUID)
  })
})
