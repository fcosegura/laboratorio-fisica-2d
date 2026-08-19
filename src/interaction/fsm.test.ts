import { describe, expect, it } from 'vitest'
import type { InteractionState } from './state.ts'
import { Tool } from './tools.ts'
import { reduceDown, reduceMove } from './machine.ts'

describe('interaction FSM (machine.ts)', () => {
  const dummyCtx = (overrides: Partial<Parameters<typeof reduceDown>[1]> = {}): Parameters<typeof reduceDown>[1] => ({
    tool: Tool.select,
    world: { x: 1, y: 2 },
    screen: { x: 100, y: 200 },
    hit: null,
    hitDynamic: null,
    shiftKey: false,
    button: 0,
    camera: { x: 0, y: 0 },
    poseOf: () => ({ x: 0, y: 0, angle: 0 }),
    bodyOf: (id) => ({
      id,
      name: 'Test',
      type: 'dynamic',
      x: 1,
      y: 2,
      angle: 0,
      vx: 0,
      vy: 0,
      omega: 0,
      massMode: 'density',
      density: 1000,
      friction: 0.5,
      restitution: 0.2,
      materialId: 'wood',
      gravityScale: 1,
      linearDamping: 0,
      angularDamping: 0,
      ccd: false,
      locked: false,
      lockRotation: false,
      shape: { kind: 'circle', radius: 1 },
    }),
    ...overrides,
  })

  it('select + hit starts dragging, select + no-hit starts selecting (marquee)', () => {
    let s: InteractionState = { kind: 'idle' }
    const res1 = reduceDown(s, dummyCtx({ tool: Tool.select, hit: 'body:1' }))
    expect(res1.state.kind).toBe('dragging')
    if (res1.state.kind === 'dragging') {
      expect(res1.state.bodyId).toBe('body:1')
    }

    const res2 = reduceDown(s, dummyCtx({ tool: Tool.select, hit: null }))
    expect(res2.state.kind).toBe('selecting')
    if (res2.state.kind === 'selecting') {
      expect(res2.state.start).toEqual({ x: 1, y: 2 })
    }
  })

  it('circle and rect tools start creating', () => {
    let s: InteractionState = { kind: 'idle' }
    const resCircle = reduceDown(s, dummyCtx({ tool: Tool.circle }))
    expect(resCircle.state.kind).toBe('creating')
    if (resCircle.state.kind === 'creating') expect(resCircle.state.tool).toBe('circle')

    const resRect = reduceDown(s, dummyCtx({ tool: Tool.rect }))
    expect(resRect.state.kind).toBe('creating')
    if (resRect.state.kind === 'creating') expect(resRect.state.tool).toBe('rect')
  })

  it('polygon tool adds points when creating', () => {
    let s: InteractionState = { kind: 'idle' }
    const res1 = reduceDown(s, dummyCtx({ tool: Tool.polygon, world: { x: 0, y: 0 } }))
    expect(res1.state.kind).toBe('creating')
    if (res1.state.kind === 'creating') {
      expect(res1.state.points).toEqual([{ x: 0, y: 0 }])
    }

    const res2 = reduceDown(res1.state, dummyCtx({ tool: Tool.polygon, world: { x: 1, y: 1 } }))
    if (res2.state.kind === 'creating') {
      expect(res2.state.points).toHaveLength(2)
      expect(res2.state.points![1]).toEqual({ x: 1, y: 1 })
    }
  })

  it('force tool starts applyingForce on dynamic bodies', () => {
    let s: InteractionState = { kind: 'idle' }
    const res = reduceDown(s, dummyCtx({ tool: Tool.force, hitDynamic: 'body:dyn' }))
    expect(res.state.kind).toBe('applyingForce')
    if (res.state.kind === 'applyingForce') {
      expect(res.state.bodyId).toBe('body:dyn')
      expect(res.state.mode).toBe('impulse')
    }
  })

  it('joint tool starts joining on hit body', () => {
    let s: InteractionState = { kind: 'idle' }
    const res = reduceDown(s, dummyCtx({ tool: Tool.joint, hit: 'body:1' }))
    expect(res.state.kind).toBe('joining')
    if (res.state.kind === 'joining') {
      expect(res.state.bodyA).toBe('body:1')
    }
  })

  it('middle button, right button or spaceHeld starts panning', () => {
    let s: InteractionState = { kind: 'idle' }
    const resMid = reduceDown(s, dummyCtx({ button: 1 }))
    expect(resMid.state.kind).toBe('panning')

    const resRight = reduceDown(s, dummyCtx({ button: 2 }))
    expect(resRight.state.kind).toBe('panning')

    const resSpace = reduceDown(s, dummyCtx({ spaceHeld: true }))
    expect(resSpace.state.kind).toBe('panning')
  })

  it('reduceMove updates current point in active creating/measuring/selecting/joining states', () => {
    const s: InteractionState = {
      kind: 'measuring',
      start: { x: 0, y: 0 },
      current: { x: 0, y: 0 },
    }
    const moved = reduceMove(s, { x: 5, y: 5 })
    if (moved.kind === 'measuring') {
      expect(moved.current).toEqual({ x: 5, y: 5 })
    }
  })
})

