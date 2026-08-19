import { describe, expect, it } from 'vitest'
import { MAX_FRAME_DT, MAX_STEPS_PER_FRAME, PHYSICS_DT } from '../core/constants.ts'
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

  it('caps steps per frame without zeroing remainder or reporting a dummy +1 drop', () => {
    const c = new Clock()
    c.playing = true
    const added = MAX_FRAME_DT
    const steps = c.advance(added)
    expect(steps).toBe(MAX_STEPS_PER_FRAME)
    expect(c.simTime).toBeCloseTo(MAX_STEPS_PER_FRAME * PHYSICS_DT, 10)
    expect(c.accumulator).toBeLessThan(PHYSICS_DT)
    expect(c.alpha).toBeGreaterThan(0)
    expect(c.alpha).toBeLessThanOrEqual(1)
    const totalPossible = Math.floor(added / PHYSICS_DT)
    expect(c.stepsDropped).toBe(totalPossible - MAX_STEPS_PER_FRAME)
  })

  it('high timeScale saturates substeps and counts dropped time', () => {
    const c = new Clock()
    c.playing = true
    c.timeScale = 5
    const frameDt = 0.1
    const steps = c.advance(frameDt)
    expect(steps).toBe(MAX_STEPS_PER_FRAME)
    const added = Math.min(frameDt, MAX_FRAME_DT) * 5
    const totalPossible = Math.floor(added / PHYSICS_DT)
    expect(c.stepsDropped).toBe(totalPossible - MAX_STEPS_PER_FRAME)
    expect(c.accumulator).toBeLessThan(PHYSICS_DT)
    expect(c.alpha).toBeGreaterThan(0)
  })

  it('a frame hitch does not rewind interpolation alpha to 0', () => {
    const c = new Clock()
    c.playing = true
    expect(c.advance(PHYSICS_DT)).toBe(1)
    expect(c.alpha).toBe(1)
    c.advance(MAX_FRAME_DT)
    expect(c.alpha).not.toBe(0)
    expect(c.alpha).toBeGreaterThan(0)
    expect(c.alpha).toBeLessThanOrEqual(1)
  })
})
