import { create } from 'zustand'
import { DEFAULT_VIZ, type JointKindUi, type SceneBody, type SceneJoint, type VizLayers } from '../scene/document.ts'
import { Tool, type Tool as ToolId } from '../interaction/tools.ts'
import type { GravityPreset } from '../scene/document.ts'

export type LiveBody = {
  x: number
  y: number
  angle: number
  vx: number
  vy: number
  omega: number
  mass: number
}

export type Timings = {
  physics: number
  fluids: number
  render: number
  frame: number
  steps: number
  dropped: number
}

export type LabUiState = {
  tool: ToolId
  jointKind: JointKindUi
  materialId: string
  viz: VizLayers
  playing: boolean
  timeScale: number
  simTime: number
  selectedId: string | null
  selectedBody: SceneBody | null
  selectedJoints: SceneJoint[]
  live: LiveBody | null
  bodyCount: number
  particleCount: number
  timings: Timings
  canUndo: boolean
  canRedo: boolean
  spaceHeld: boolean
  gravityPreset: GravityPreset
  inspectorOpen: boolean
  graphsOpen: boolean
  debugHud: boolean
  graphChannel: 'x' | 'y' | 'vx' | 'vy' | 'speed' | 'energy' | 'kinetic'
}

export const useLabStore = create<LabUiState>(() => ({
  tool: Tool.select,
  jointKind: 'revolute',
  materialId: 'wood',
  viz: { ...DEFAULT_VIZ },
  playing: false,
  timeScale: 1,
  simTime: 0,
  selectedId: null,
  selectedBody: null,
  selectedJoints: [],
  live: null,
  bodyCount: 0,
  particleCount: 0,
  timings: { physics: 0, fluids: 0, render: 0, frame: 0, steps: 0, dropped: 0 },
  canUndo: false,
  canRedo: false,
  spaceHeld: false,
  gravityPreset: 'earth',
  inspectorOpen: true,
  graphsOpen: true,
  debugHud: true,
  graphChannel: 'y',
}))

export type LabStore = typeof useLabStore
