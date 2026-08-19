import { describe, expect, it } from 'vitest'
import type { InteractionState } from './state.ts'
import { Tool } from './tools.ts'

function reduce(
  state: InteractionState,
  event: { type: 'down' | 'up' | 'cancel'; tool: Tool; hit: string | null },
): InteractionState {
  if (event.type === 'cancel') return { kind: 'idle' }
  if (state.kind === 'idle' && event.type === 'down') {
    if (event.tool === 'pan') return { kind: 'panning', startScreen: { x: 0, y: 0 }, origX: 0, origY: 0 }
    if (event.tool === 'select' && event.hit) {
      return {
        kind: 'dragging',
        bodyId: event.hit,
        local: { x: 0, y: 0 },
        startWorld: { x: 0, y: 0 },
        orig: { x: 0, y: 0, angle: 0 },
      }
    }
    if (event.tool === 'circle' || event.tool === 'rect' || event.tool === 'line' || event.tool === 'fluid') {
      return { kind: 'creating', tool: event.tool, start: { x: 0, y: 0 }, current: { x: 0, y: 0 } }
    }
    if (event.tool === 'force' && event.hit) {
      return {
        kind: 'applyingForce',
        bodyId: event.hit,
        local: { x: 0, y: 0 },
        current: { x: 0, y: 0 },
        mode: 'impulse',
      }
    }
  }
  if (event.type === 'up') return { kind: 'idle' }
  return state
}

describe('interaction FSM', () => {
  it('select + hit starts dragging, up returns to idle', () => {
    let s: InteractionState = { kind: 'idle' }
    s = reduce(s, { type: 'down', tool: Tool.select, hit: 'body:1' })
    expect(s.kind).toBe('dragging')
    s = reduce(s, { type: 'up', tool: Tool.select, hit: 'body:1' })
    expect(s.kind).toBe('idle')
  })

  it('circle tool starts creating', () => {
    let s: InteractionState = { kind: 'idle' }
    s = reduce(s, { type: 'down', tool: Tool.circle, hit: null })
    expect(s.kind).toBe('creating')
    if (s.kind === 'creating') expect(s.tool).toBe('circle')
  })

  it('cancel always returns to idle', () => {
    let s: InteractionState = {
      kind: 'creating',
      tool: 'rect',
      start: { x: 0, y: 0 },
      current: { x: 1, y: 1 },
    }
    s = reduce(s, { type: 'cancel', tool: 'rect', hit: null })
    expect(s.kind).toBe('idle')
  })
})
