import { describe, expect, it } from 'vitest'
import { PHYSICS_DT } from '../core/constants.ts'
import { Clock } from './clock.ts'

describe('Clock', () => {
  it('takes a fixed number of steps independent of frame spikes', () => {
    const c = new Clock()
    c.playing = true
    const a = new Clock()
    a.playing = true
    // 1 second of 60fps vs mixed frame times
    for (let i = 0; i < 60; i++) c.advance(1 / 60)
    const mixed = [1 / 30, 1 / 120, 1 / 120, 1 / 45, 1 / 90]
    let t = 0
    let i = 0
    while (t < 1) {
      const dt = mixed[i % mixed.length]!
      a.advance(dt)
      t += dt
      i++
    }
    expect(Math.abs(c.simTime - a.simTime)).toBeLessThan(PHYSICS_DT * 2)
  })

  it('stepOnce advances exactly one dt', () => {
    const c = new Clock()
    c.stepOnce()
    expect(c.simTime).toBeCloseTo(PHYSICS_DT, 10)
    expect(c.alpha).toBe(1)
  })

  it('does not step while paused', () => {
    const c = new Clock()
    c.playing = false
    expect(c.advance(1)).toBe(0)
    expect(c.simTime).toBe(0)
  })
})
