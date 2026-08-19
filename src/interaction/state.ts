import type { BodyId } from '../core/ids.ts'
import type { Vec2 } from '../core/math/vec2.ts'
import type { Tool } from './tools.ts'

export type InteractionState =
  | { kind: 'idle' }
  | { kind: 'hovering'; bodyId: BodyId }
  | { kind: 'selecting'; start: Vec2; current: Vec2 }
  | { kind: 'dragging'; bodyId: BodyId; local: Vec2; startWorld: Vec2; orig: { x: number; y: number; angle: number } }
  | { kind: 'rotating'; bodyId: BodyId; startAngle: number; origAngle: number }
  | {
      kind: 'creating'
      tool: Tool
      start: Vec2
      current: Vec2
      points?: Vec2[]
    }
  | { kind: 'panning'; startScreen: Vec2; origX: number; origY: number }
  | {
      kind: 'applyingForce'
      bodyId: BodyId
      origin: Vec2
      current: Vec2
      mode: 'impulse' | 'force'
    }
  | { kind: 'measuring'; start: Vec2; current: Vec2 }
  | { kind: 'pinching'; startDist: number; origPpm: number }

export type Pointer = {
  id: number
  screen: Vec2
  world: Vec2
  buttons: number
  shift: boolean
  alt: boolean
}

export const InteractionEvent = {
  hover: 'hover',
  down: 'down',
  move: 'move',
  up: 'up',
  cancel: 'cancel',
  wheel: 'wheel',
} as const
export type InteractionEvent = (typeof InteractionEvent)[keyof typeof InteractionEvent]
