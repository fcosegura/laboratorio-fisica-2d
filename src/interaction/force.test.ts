import { describe, expect, it } from 'vitest'
import { dragToForce, dragToImpulse, FORCE_ACCEL_PER_METER, IMPULSE_VELOCITY_PER_METER } from './force.ts'

describe('force tool scaling', () => {
  it('maps 1 m of drag to Δv = k regardless of mass', () => {
    const j = dragToImpulse(600, 1, 0)
    expect(j.x).toBeCloseTo(600 * IMPULSE_VELOCITY_PER_METER)
    expect(j.y).toBe(0)
    expect(j.x / 600).toBeCloseTo(IMPULSE_VELOCITY_PER_METER)
  })

  it('maps 1 m of drag to a ≈ 12 m/s² regardless of mass', () => {
    const f = dragToForce(1885, 0, 1)
    expect(f.y / 1885).toBeCloseTo(FORCE_ACCEL_PER_METER)
  })
})
