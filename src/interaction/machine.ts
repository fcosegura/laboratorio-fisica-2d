import type { BodyId } from '../core/ids.ts'
import { inverseTransformPoint, type Transform } from '../core/math/transform.ts'
import type { Vec2 } from '../core/math/vec2.ts'
import type { SceneBody } from '../scene/document.ts'
import type { InteractionState } from './state.ts'
import type { Tool } from './tools.ts'

export type DownEventContext = {
  tool: Tool
  world: Vec2
  screen: Vec2
  hit: BodyId | null
  hitDynamic: BodyId | null
  shiftKey: boolean
  button: number
  spaceHeld?: boolean
  camera: { x: number; y: number }
  poseOf: (id: BodyId) => Transform
  bodyOf: (id: BodyId) => SceneBody | undefined
}

export function reduceDown(
  state: InteractionState,
  ctx: DownEventContext,
): { state: InteractionState; selected?: BodyId[]; pushUi?: boolean; ensurePlaying?: boolean } {
  const { tool, world, screen, hit, hitDynamic, shiftKey, button, spaceHeld, camera, poseOf, bodyOf } = ctx

  if (state.kind === 'joining' && tool !== 'joint') {
    state = { kind: 'idle' }
  }

  if (button === 1 || button === 2 || tool === 'pan' || spaceHeld) {
    return {
      state: { kind: 'panning', startScreen: screen, origX: camera.x, origY: camera.y },
    }
  }

  if (tool === 'select') {
    if (hit) {
      const body = bodyOf(hit)
      const orig = body
        ? { x: body.x, y: body.y, angle: body.angle, vx: body.vx, vy: body.vy, omega: body.omega }
        : { x: 0, y: 0, angle: 0, vx: 0, vy: 0, omega: 0 }
      return {
        state: {
          kind: 'dragging',
          bodyId: hit,
          local: { x: world.x - orig.x, y: world.y - orig.y },
          startWorld: world,
          orig,
        },
        selected: [hit],
        pushUi: true,
      }
    } else {
      return {
        state: { kind: 'selecting', start: world, current: world },
        selected: [],
        pushUi: true,
      }
    }
  }

  if (tool === 'force') {
    if (!hitDynamic) return { state }
    const pose = poseOf(hitDynamic)
    return {
      state: {
        kind: 'applyingForce',
        bodyId: hitDynamic,
        local: inverseTransformPoint({ x: 0, y: 0 }, world, pose),
        current: world,
        mode: shiftKey ? 'force' : 'impulse',
      },
      selected: [hitDynamic],
      pushUi: true,
      ensurePlaying: shiftKey,
    }
  }

  if (tool === 'measure') {
    return {
      state: { kind: 'measuring', start: world, current: world },
    }
  }

  if (tool === 'joint') {
    if (!hit) return { state }
    const pose = poseOf(hit)
    const local = inverseTransformPoint({ x: 0, y: 0 }, world, pose)
    return {
      state: {
        kind: 'joining',
        bodyA: hit,
        anchorA: { x: local.x, y: local.y },
        current: { x: world.x, y: world.y },
      },
      selected: [hit],
      pushUi: true,
    }
  }

  if (tool === 'polygon') {
    if (state.kind === 'creating' && state.tool === 'polygon') {
      return {
        state: {
          ...state,
          points: [...(state.points ?? []), world],
          current: world,
        },
      }
    }
    return {
      state: { kind: 'creating', tool: 'polygon', start: world, current: world, points: [world] },
    }
  }

  if (tool === 'circle' || tool === 'rect' || tool === 'line' || tool === 'fluid') {
    return {
      state: { kind: 'creating', tool, start: world, current: world },
    }
  }

  return { state }
}

export function reduceMove(
  state: InteractionState,
  world: Vec2,
): InteractionState {
  if (state.kind === 'creating' || state.kind === 'applyingForce' || state.kind === 'measuring' || state.kind === 'selecting' || state.kind === 'joining') {
    return { ...state, current: world }
  }
  return state
}
