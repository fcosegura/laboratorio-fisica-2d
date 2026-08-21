import { describe, expect, it } from 'vitest'
import { applySolidPreset } from '../src/materials/applyPreset.ts'
import { SOLID_MATERIALS, getSolid } from '../src/materials/catalog.ts'
import type { SceneBody } from '../src/scene/document.ts'
import { bodyToDesc } from '../src/scene/builder.ts'

function baseBody(overrides: Partial<SceneBody> = {}): SceneBody {
  return {
    id: 'body:test',
    name: 'Test',
    type: 'dynamic',
    x: 0,
    y: 0,
    angle: 0,
    vx: 0,
    vy: 0,
    omega: 0,
    massMode: 'density',
    density: 600,
    friction: 0.5,
    restitution: 0.15,
    materialId: 'wood',
    gravityScale: 1,
    linearDamping: 0.05,
    angularDamping: 0.05,
    ccd: false,
    locked: false,
    lockRotation: false,
    shape: { kind: 'box', hx: 0.5, hy: 0.5 },
    ...overrides,
  }
}

describe('applySolidPreset', () => {
  it('copies contact, damping and density in density mode', () => {
    for (const mat of SOLID_MATERIALS) {
      const patch = applySolidPreset(mat.id)
      expect(patch).toEqual({
        materialId: mat.id,
        friction: mat.friction,
        restitution: mat.restitution,
        linearDamping: mat.linearDamping,
        angularDamping: mat.angularDamping,
        density: mat.density,
        massMode: 'density',
      })
    }
  })

  it('does not overwrite density or massMode when massMode is explicit', () => {
    const wood = getSolid('wood')
    const metal = getSolid('metal')
    const patch = applySolidPreset(metal.id, { massMode: 'explicit' })
    expect(patch.materialId).toBe(metal.id)
    expect(patch.friction).toBe(metal.friction)
    expect(patch.restitution).toBe(metal.restitution)
    expect(patch.linearDamping).toBe(metal.linearDamping)
    expect(patch.angularDamping).toBe(metal.angularDamping)
    expect(patch.density).toBeUndefined()
    expect(patch.massMode).toBeUndefined()
    expect(patch).not.toHaveProperty('mass')
    // Catalog wood density must not leak into an explicit-mass patch.
    expect(Object.keys(patch)).not.toContain('density')
    expect(wood.density).not.toBe(metal.density)
  })
})

describe('bodyToDesc', () => {
  it('maps every catalog solid into BodyDesc contact / density / damping', () => {
    for (const mat of SOLID_MATERIALS) {
      const desc = bodyToDesc(
        baseBody({
          materialId: mat.id,
          density: mat.density,
          friction: mat.friction,
          restitution: mat.restitution,
          linearDamping: mat.linearDamping,
          angularDamping: mat.angularDamping,
          massMode: 'density',
        }),
      )
      const col = desc.colliders[0]!
      expect(col.friction).toBe(mat.friction)
      expect(col.restitution).toBe(mat.restitution)
      expect(col.density).toBe(mat.density)
      expect(col.mass).toBeUndefined()
      expect(desc.linearDamping).toBe(mat.linearDamping)
      expect(desc.angularDamping).toBe(mat.angularDamping)
    }
  })

  it('uses explicit mass instead of density when massMode is explicit', () => {
    const desc = bodyToDesc(
      baseBody({
        massMode: 'explicit',
        mass: 12.5,
        density: 999,
        materialId: 'metal',
      }),
    )
    const col = desc.colliders[0]!
    expect(col.mass).toBe(12.5)
    expect(col.density).toBeUndefined()
  })

  it('falls back to catalog density when body density is 0', () => {
    const mat = getSolid('stone')
    const desc = bodyToDesc(
      baseBody({
        materialId: mat.id,
        density: 0,
        massMode: 'density',
      }),
    )
    expect(desc.colliders[0]!.density).toBe(mat.density)
  })
})
