import type { BodyId } from '../core/ids.ts'
import { inverseTransformPoint, type Transform } from '../core/math/transform.ts'
import type { Vec2 } from '../core/math/vec2.ts'
import type { SceneBody } from '../scene/document.ts'
import { pointerAngle, type HandleKind, type HandleLayout } from './handles.ts'
import type { InteractionState } from './state.ts'
import type { Tool } from './tools.ts'

/** Live kinematic pose (snapshot / engine.curr), not authorship in the document. */
export type KinematicPose = Transform & { vx: number; vy: number; omega: number }

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
  poseOf: (id: BodyId) => KinematicPose
  bodyOf: (id: BodyId) => SceneBody | undefined
  /** Rotate / scale handle under the pointer (select tool, single selection, paused). */
  handle?: { kind: HandleKind; layout: HandleLayout } | null
  /** Vertex of the selected fluid region under the pointer (select tool). */
  vertex?: { regionId: string; index: number } | null
}

export function reduceDown(
  state: InteractionState,
  ctx: DownEventContext,
): { state: InteractionState; selected?: BodyId[]; pushUi?: boolean; ensurePlaying?: boolean } {
  const { tool, world, screen, hit, hitDynamic, shiftKey, button, spaceHeld, camera, poseOf } = ctx

  if (state.kind === 'joining' && tool !== 'joint') {
    state = { kind: 'idle' }
  }

  if (button === 1 || button === 2 || tool === 'pan' || spaceHeld) {
    return {
      state: { kind: 'panning', startScreen: screen, origX: camera.x, origY: camera.y },
    }
  }

  if (tool === 'select' && ctx.vertex && button === 0) {
    return {
      state: {
        kind: 'editingVertex',
        regionId: ctx.vertex.regionId,
        index: ctx.vertex.index,
        current: world,
      },
    }
  }

  if (tool === 'select' && ctx.handle && button === 0) {
    const { kind, layout } = ctx.handle
    if (kind === 'rotate') {
      const angle = poseOf(layout.bodyId).angle
      return {
        state: {
          kind: 'rotating',
          bodyId: layout.bodyId,
          center: layout.center,
          startPointer: pointerAngle(layout.center, world),
          origAngle: angle,
          angle,
        },
      }
    }
    return {
      state: {
        kind: 'scaling',
        bodyId: layout.bodyId,
        center: layout.center,
        start: world,
        current: world,
      },
    }
  }

  if (tool === 'select') {
    if (hit) {
      const pose = poseOf(hit)
      const orig = {
        x: pose.x,
        y: pose.y,
        angle: pose.angle,
        vx: pose.vx,
        vy: pose.vy,
        omega: pose.omega,
      }
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

  if (tool === 'thruster') {
    if (!hitDynamic) return { state }
    const pose = poseOf(hitDynamic)
    return {
      state: {
        kind: 'placingThruster',
        bodyId: hitDynamic,
        local: inverseTransformPoint({ x: 0, y: 0 }, world, pose),
        current: world,
      },
      selected: [hitDynamic],
      pushUi: true,
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

  if (
    tool === 'circle' ||
    tool === 'rect' ||
    tool === 'line' ||
    tool === 'fluid' ||
    tool === 'spill'
  ) {
    return {
      state: { kind: 'creating', tool, start: world, current: world },
    }
  }

  return { state }
}

export function reduceMove(state: InteractionState, world: Vec2): InteractionState {
  if (
    state.kind === 'creating' ||
    state.kind === 'applyingForce' ||
    state.kind === 'placingThruster' ||
    state.kind === 'measuring' ||
    state.kind === 'selecting' ||
    state.kind === 'joining' ||
    state.kind === 'scaling' ||
    state.kind === 'editingVertex'
  ) {
    return { ...state, current: world }
  }
  if (state.kind === 'rotating') {
    const delta = pointerAngle(state.center, world) - state.startPointer
    return { ...state, angle: state.origAngle + delta }
  }
  return state
}
