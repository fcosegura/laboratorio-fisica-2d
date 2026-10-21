import { create } from 'zustand'
import {
  DEFAULT_VIZ,
  type JointKindUi,
  type SceneBody,
  type SceneFluidRegion,
  type SceneJoint,
  type SceneWind,
  type VizLayers,
} from '../scene/document.ts'
import { Tool, type Tool as ToolId } from '../interaction/tools.ts'
import type { GravityPreset } from '../scene/document.ts'
import { CHANNEL_LABELS, type RecorderChannel } from '../sim/recorder.ts'
import { DEFAULT_FLUID } from '../materials/catalog.ts'

export { CHANNEL_LABELS }
export type { RecorderChannel }

export type GraphChannel = 'x' | 'y' | 'vx' | 'vy' | 'speed' | 'energy' | 'kinetic'

export const GRAPH_CHANNELS: readonly GraphChannel[] = [
  'y',
  'x',
  'vx',
  'vy',
  'speed',
  'energy',
  'kinetic',
]

export type LiveBody = {
  x: number
  y: number
  angle: number
  vx: number
  vy: number
  omega: number
  mass: number
}

export type JointUi = SceneJoint & { otherName: string }

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
  /** Material de fluido al crear tanque (`fluid`) o derrame (`spill`). */
  fluidMaterialId: string
  viz: VizLayers
  playing: boolean
  timeScale: number
  simTime: number
  selectedId: string | null
  selectedBody: SceneBody | null
  selectedFluidId: string | null
  selectedFluidRegion: SceneFluidRegion | null
  /** Aviso muted cuando hay regiones de fluido con AABB solapado. */
  fluidOverlapWarning: string | null
  /** Aviso breve de una acción rechazada (p. ej. tanque no convexo). */
  notice: string | null
  /** Lista plana para el selector del inspector (id + nombre). */
  fluidRegionOptions: { id: string; name: string }[]
  selectedJoints: JointUi[]
  live: LiveBody | null
  bodyCount: number
  fluidCount: number
  particleCount: number
  /** Partículas de agua libre descartadas por el límite (0 = ninguna). */
  particlesTruncated: number
  /** Máximo de partículas de agua libre del motor. */
  particleLimit: number
  timings: Timings
  canUndo: boolean
  canRedo: boolean
  spaceHeld: boolean
  gravityPreset: GravityPreset
  /** Aire del mundo (null = vacío). */
  wind: SceneWind | null
  inspectorOpen: boolean
  graphsOpen: boolean
  debugHud: boolean
  graphChannel: GraphChannel
}

export const useLabStore = create<LabUiState>(() => ({
  tool: Tool.select,
  jointKind: 'revolute',
  materialId: 'wood',
  fluidMaterialId: DEFAULT_FLUID,
  viz: { ...DEFAULT_VIZ },
  playing: false,
  timeScale: 1,
  simTime: 0,
  selectedId: null,
  selectedBody: null,
  selectedFluidId: null,
  selectedFluidRegion: null,
  fluidOverlapWarning: null,
  notice: null,
  fluidRegionOptions: [],
  selectedJoints: [],
  live: null,
  bodyCount: 0,
  fluidCount: 0,
  particleCount: 0,
  particlesTruncated: 0,
  particleLimit: 0,
  timings: { physics: 0, fluids: 0, render: 0, frame: 0, steps: 0, dropped: 0 },
  canUndo: false,
  canRedo: false,
  spaceHeld: false,
  gravityPreset: 'earth',
  wind: null,
  inspectorOpen: true,
  graphsOpen: true,
  debugHud: true,
  graphChannel: 'y',
}))

export type LabStore = typeof useLabStore
