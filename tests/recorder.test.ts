import { describe, expect, it } from 'vitest'
import { DataRecorder } from '../src/sim/recorder.ts'
import type { BodySnapshot } from '../src/physics/ports.ts'

describe('DataRecorder', () => {
  const dummyBody = (id: string, x = 0, y = 0, vx = 0, vy = 0): BodySnapshot => ({
    id,
    type: 'dynamic',
    x,
    y,
    angle: 0,
    vx,
    vy,
    omega: 0,
    mass: 2,
    inertia: 1,
  })

  it('observes bodies and collects time series', () => {
    const recorder = new DataRecorder(10, 60)
    recorder.observe('b1')

    recorder.sample(0, 1 / 60, { x: 0, y: -9.81 }, [dummyBody('b1', 0, 5, 0, 0)])
    recorder.sample(1 / 60, 1 / 60, { x: 0, y: -9.81 }, [dummyBody('b1', 0, 4.9, 0, -1)])

    const ySeries = recorder.series('b1', 'y')
    expect(ySeries.n).toBe(2)
    expect(ySeries.y[0]).toBe(5)
    expect(ySeries.y[1]).toBeCloseTo(4.9)

    const vySeries = recorder.series('b1', 'vy')
    expect(vySeries.y[1]).toBe(-1)
  })

  it('unobserve removes individual tracking without affecting other tracks', () => {
    const recorder = new DataRecorder(10, 60)
    recorder.observe('b1')
    recorder.observe('b2')
    expect(recorder.ids()).toEqual(['b1', 'b2'])

    recorder.unobserve('b1')
    expect(recorder.ids()).toEqual(['b2'])
  })

  it('unobserveAll removes all tracks and resets the recorder', () => {
    const recorder = new DataRecorder(10, 60)
    recorder.observe('b1')
    recorder.observe('b2')
    recorder.unobserveAll()
    expect(recorder.ids()).toEqual([])
  })

  it('potential energy is −m g · r with datum at the origin', () => {
    const recorder = new DataRecorder(10, 60)
    recorder.observe('b1')
    recorder.sample(0, 1 / 60, { x: 3, y: -4 }, [dummyBody('b1', 1, 2)])
    const pe = recorder.series('b1', 'potential')
    expect(pe.y[0]).toBeCloseTo(-2 * (3 * 1 + -4 * 2), 10)
  })

  it('does not treat the first velocity as acceleration from rest', () => {
    const recorder = new DataRecorder(10, 60)
    recorder.observe('b1')
    recorder.sample(0, 1 / 60, { x: 0, y: -9.81 }, [dummyBody('b1', 0, 0, 8, 0)])
    expect(recorder.series('b1', 'ax').y[0]).toBe(0)
    recorder.sample(1 / 60, 1 / 60, { x: 0, y: -9.81 }, [dummyBody('b1', 0, 0, 8, 0)])
    expect(recorder.series('b1', 'ax').y[1]).toBeCloseTo(0)
  })
})
