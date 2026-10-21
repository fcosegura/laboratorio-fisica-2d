import { IdFactory } from '../core/ids.ts'
import { createCamera, zoomToFit, type Camera } from '../camera/coords.ts'
import { handleLayout, type HandleLayout } from '../interaction/handles.ts'
import type { KinematicPose } from '../interaction/machine.ts'
import type { InteractionState } from '../interaction/state.ts'
import type { Tool } from '../interaction/tools.ts'
import { PixiRenderer } from '../render/PixiRenderer.ts'
import {
  AddBodyCommand,
  AddJointCommand,
  BatchCommand,
  DuplicateBodyCommand,
  RemoveBodyCommand,
  RemoveFluidCommand,
  RemoveFluidVolumeCommand,
  RemoveJointCommand,
  SetWorldCommand,
  UpdateBodyCommand,
  UpdateFluidRegionCommand,
  UpdateJointCommand,
} from '../scene/commands.ts'
import { History } from '../scene/history.ts'
import {
  cloneDocument,
  emptyScene,
  GRAVITY_PRESETS,
  type GravityPreset,
  type SceneBody,
  type SceneDocument,
  type SceneFluidRegion,
  type SceneJoint,
  type VizLayers,
} from '../scene/document.ts'
import { bodyToDesc } from '../scene/builder.ts'
import { jointToDesc } from '../scene/joints.ts'
import { fluidOverlapWarning } from '../scene/fluidOverlap.ts'
import { parseDocument, serializeDocument } from '../scene/schema.ts'
import { PBF_MAX_PARTICLES } from '../fluids/pbf/PbfFluid.ts'
import { SimulationEngine } from '../sim/engine.ts'
import { LabInput } from './LabInput.ts'
import type { GraphChannel, LabStore } from './store.ts'

export class LabRuntime {
  engine: SimulationEngine
  renderer = new PixiRenderer()
  camera: Camera = createCamera()
  history: History
  ids = new IdFactory(10)
  state: InteractionState = { kind: 'idle' }
  selected: string[] = []
  /** Región de fluido analítico seleccionada (independiente de cuerpos). */
  selectedFluidId: string | null = null
  canvas: HTMLCanvasElement | null = null
  private raf = 0
  private lastT = 0

  store: LabStore | null = null
  readonly input: LabInput = new LabInput(this)
  private uiAcc = 0
  private unbind: (() => void) | null = null
  /** Bumped on dispose so an in-flight `mount()` cannot start a second loop. */
  private session = 0
  timings = { frame: 0, render: 0 }

  constructor(doc: SceneDocument = emptyScene()) {
    this.engine = new SimulationEngine(doc)
    this.camera = { ...doc.camera }
    this.history = new History(
      () => this.engine.doc,
      (d) => {
        this.engine.doc = d
      },
    )
  }

  attachStore(store: LabStore): void {
    this.store = store
  }

  async mount(canvas: HTMLCanvasElement): Promise<void> {
    const session = ++this.session
    this.canvas = canvas
    // Pass session guard into init: a stale mount must not rebuild after a newer
    // mount already created the live world (React Strict Mode remount race).
    await this.engine.init(() => session === this.session)
    if (session !== this.session) {
      // Newer mount/dispose owns lifecycle. Do not destroy their world or renderer.
      return
    }
    await this.renderer.init(canvas)
    if (session !== this.session) {
      return
    }
    this.unbind?.()
    this.unbind = this.input.bind(canvas)
    this.resize()
    this.lastT = performance.now()
    const loop = (t: number) => {
      if (session !== this.session) return
      const dt = (t - this.lastT) / 1000
      this.lastT = t
      const t0 = performance.now()
      try {
        this.engine.advance(dt)
        this.input.applySustainedForce()
        this.renderer.draw(
          this.engine,
          this.camera,
          this.store?.getState().viz ?? this.engine.doc.visualization,
          this.selectedFluidId ? [...this.selected, this.selectedFluidId] : this.selected,
          this.state,
          this.handles(),
        )
      } catch (err) {
        console.error(err)
      }
      this.timings.frame = performance.now() - t0
      this.timings.render = this.renderer.lastDrawMs
      this.uiAcc += dt
      if (this.uiAcc > 1 / 15) {
        this.uiAcc = 0
        this.pushUi()
      }
      if (session === this.session) this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  dispose(): void {
    this.session += 1
    cancelAnimationFrame(this.raf)
    this.raf = 0
    this.unbind?.()
    this.unbind = null
    this.renderer.destroy()
    this.engine.world?.destroy()
    this.engine.world = null
    this.canvas = null
  }

  resize(): void {
    if (!this.canvas) return
    const parent = this.canvas.parentElement
    const w = parent?.clientWidth ?? this.canvas.clientWidth
    const h = parent?.clientHeight ?? this.canvas.clientHeight
    this.renderer.resize(w, h)
  }

  view() {
    return this.renderer.view
  }

  tool(): Tool {
    return this.store?.getState().tool ?? 'select'
  }

  /** Rotate / scale handles: one selected body, select tool, paused (authoring only). */
  handles(): HandleLayout | null {
    if (this.selected.length !== 1 || this.tool() !== 'select' || this.engine.clock.playing) {
      return null
    }
    const id = this.selected[0]!
    const body = this.engine.doc.bodies.find((b) => b.id === id)
    if (!body) return null
    return handleLayout(id, body.shape, this.poseOf(id), this.camera.pixelsPerMeter)
  }

  /** Live pose (interpolated snapshot), falling back to authorship. */
  poseOf(id: string): KinematicPose {
    const snap = this.engine.interpolated(id)
    if (snap)
      return {
        x: snap.x,
        y: snap.y,
        angle: snap.angle,
        vx: snap.vx,
        vy: snap.vy,
        omega: snap.omega,
      }
    const body = this.engine.doc.bodies.find((b) => b.id === id)
    return {
      x: body?.x ?? 0,
      y: body?.y ?? 0,
      angle: body?.angle ?? 0,
      vx: body?.vx ?? 0,
      vy: body?.vy ?? 0,
      omega: body?.omega ?? 0,
    }
  }

  bodyMass(id: string): number {
    return (
      this.engine.world?.getBody(id)?.mass ?? this.engine.curr.find((b) => b.id === id)?.mass ?? 1
    )
  }

  ensurePlaying(): void {
    if (this.engine.clock.playing) return
    this.engine.play()
    this.pushUi()
  }

  addBody(body: SceneBody): void {
    this.history.apply(new AddBodyCommand(body))
    this.engine.world?.addBody(bodyToDesc(body))
    this.selected = [body.id]
    this.selectedFluidId = null
    this.engine.world?.writeBodies(this.engine.curr)
    this.pushUi()
  }

  commitPatch(id: string, patch: Partial<SceneBody>): void {
    this.history.apply(new UpdateBodyCommand(id, patch))
    const body = this.engine.doc.bodies.find((b) => b.id === id)
    if (!body) return
    this.engine.applyBodyChange(body, Object.keys(patch) as (keyof SceneBody)[])
    this.engine.syncBodies()
    this.pushUi()
  }

  commitFluidPatch(id: string, patch: Partial<SceneFluidRegion>): void {
    this.history.apply(new UpdateFluidRegionCommand(id, patch))
    // Samples vienen del último physicsStep; sin invalidar, el fill en pausa queda congelado.
    if (patch.restSurfaceY !== undefined || patch.polygon !== undefined) {
      this.engine.fluids.samples.length = 0
      this.engine.fluids.debug.length = 0
    }
    this.pushUi()
  }

  selectFluidRegion(id: string | null): void {
    this.selected = []
    this.selectedFluidId = id
    this.pushUi()
  }

  /** Selected fluid region and bodies go in one transaction: a single Ctrl+Z restores all. */
  deleteSelected(): void {
    if (!this.selectedFluidId && !this.selected.length) return
    this.history.begin()
    if (this.selectedFluidId) {
      this.history.apply(new RemoveFluidCommand(this.selectedFluidId))
      this.selectedFluidId = null
    }
    for (const id of this.selected) {
      this.history.apply(new RemoveBodyCommand(id))
      this.engine.world?.removeBody(id)
      this.engine.trails.delete(id)
      if (this.engine.grab?.bodyId === id) this.engine.grab = null
    }
    this.history.commit()
    this.selected = []
    this.engine.syncBodies()
    this.pushUi()
  }

  previewTimeScale(s: number): void {
    this.engine.setTimeScale(s)
    this.pushUi()
  }

  commitTimeScale(s: number): void {
    const prev = this.engine.doc.world.timeScale
    this.engine.setTimeScale(s)
    if (s === prev) {
      this.pushUi()
      return
    }
    this.history.apply(new SetWorldCommand({ timeScale: s }, { timeScale: prev }))
    this.pushUi()
  }

  setGravityPreset(p: GravityPreset): void {
    if (p === 'custom') {
      const prev = this.engine.doc.world.gravityPreset
      if (prev === 'custom') return
      this.history.apply(new SetWorldCommand({ gravityPreset: 'custom' }, { gravityPreset: prev }))
      this.pushUi()
      return
    }
    const g = GRAVITY_PRESETS[p]
    const world = this.engine.doc.world
    this.history.apply(
      new SetWorldCommand(
        { gravity: { ...g }, gravityPreset: p },
        { gravity: { ...world.gravity }, gravityPreset: world.gravityPreset },
      ),
    )
    this.engine.setGravity(g)
    this.pushUi()
  }

  /** Incremental: keeps simTime, graphs and the velocity of untouched bodies. */
  undo(): void {
    const prev = this.engine.doc
    if (!this.history.undo()) return
    this.afterHistoryJump(prev)
  }

  redo(): void {
    const prev = this.engine.doc
    if (!this.history.redo()) return
    this.afterHistoryJump(prev)
  }

  private afterHistoryJump(prev: SceneDocument): void {
    this.engine.syncWorld(prev, this.engine.doc)
    const ids = new Set(this.engine.doc.bodies.map((b) => b.id))
    this.selected = this.selected.filter((id) => ids.has(id))
    if (
      this.selectedFluidId &&
      !this.engine.doc.fluidRegions.some((f) => f.id === this.selectedFluidId)
    ) {
      this.selectedFluidId = null
    }
    this.pushUi()
  }

  removeFluids(): void {
    const regions = this.engine.doc.fluidRegions
    const volumes = this.engine.doc.fluidVolumes
    if (!regions.length && !volumes.length) return
    const commands = [
      ...regions.map((r) => new RemoveFluidCommand(r.id)),
      ...volumes.map((v) => new RemoveFluidVolumeCommand(v.id)),
    ]
    this.history.apply(commands.length === 1 ? commands[0]! : new BatchCommand(commands))
    this.engine.particles.retainVolumes(new Set(this.engine.doc.fluidVolumes.map((v) => v.id)))
    this.selectedFluidId = null
    this.pushUi()
  }

  observeGraph(id: string): void {
    this.engine.recorder.observe(id)
  }

  unobserveGraph(id: string): void {
    this.engine.recorder.unobserve(id)
  }

  graphSeries(id: string, channel: GraphChannel): { t: Float32Array; y: Float32Array; n: number } {
    return this.engine.recorder.series(id, channel)
  }

  setTimeScale(s: number): void {
    this.commitTimeScale(s)
  }

  duplicateSelected(): void {
    const created: string[] = []
    const commands = []
    for (const id of this.selected) {
      const src = this.engine.doc.bodies.find((b) => b.id === id)
      if (!src) continue
      const copy: SceneBody = {
        ...structuredClone(src),
        id: this.ids.next('body'),
        x: src.x + 0.4,
        y: src.y + 0.4,
        name: `${src.name} copia`,
      }
      commands.push(new DuplicateBodyCommand(id, copy))
      this.engine.world?.addBody(bodyToDesc(copy))
      created.push(copy.id)
    }
    if (commands.length) {
      this.history.apply(new BatchCommand(commands))
    }
    this.selected = created
    this.selectedFluidId = null
    this.pushUi()
  }

  addJoint(joint: SceneJoint): void {
    this.history.apply(new AddJointCommand(joint))
    this.engine.world?.addJoint(jointToDesc(joint))
    this.selected = [joint.bodyB]
    this.pushUi()
  }

  removeJoint(id: string): void {
    this.history.apply(new RemoveJointCommand(id))
    this.engine.world?.removeJoint(id)
    this.pushUi()
  }

  commitJointPatch(id: string, patch: Partial<SceneJoint>): void {
    this.history.apply(new UpdateJointCommand(id, patch))
    const joint = this.engine.doc.joints.find((j) => j.id === id)
    if (!joint || !this.engine.world) {
      this.pushUi()
      return
    }
    this.engine.world.removeJoint(id)
    this.engine.world.addJoint(jointToDesc(joint))
    this.pushUi()
  }

  async loadDocument(doc: SceneDocument): Promise<void> {
    this.history.clear()
    this.selected = []
    this.selectedFluidId = null
    this.camera = { ...doc.camera }
    const allIds = [
      ...doc.bodies.map((b) => b.id),
      ...doc.joints.map((j) => j.id),
      ...doc.fluidRegions.map((f) => f.id),
      ...doc.fluidVolumes.map((f) => f.id),
    ]
    this.ids.seedMax(allIds)
    this.store?.setState({ viz: { ...doc.visualization } })
    await this.engine.reload(doc)
    this.pushUi()
  }

  async reset(): Promise<void> {
    await this.engine.reset()
    this.pushUi()
  }

  fit(): void {
    this.camera = zoomToFit(this.camera, this.renderer.sceneBounds(this.engine.doc), this.view())
  }

  exportJson(): string {
    const copy = cloneDocument(this.engine.doc)
    copy.camera = { ...this.camera }
    copy.visualization = { ...(this.store?.getState().viz ?? copy.visualization) }
    return serializeDocument(copy)
  }

  async importJson(text: string): Promise<void> {
    await this.loadDocument(parseDocument(text))
  }

  pushUi(): void {
    const store = this.store
    if (!store) return
    const selected = this.engine.doc.bodies.find((b) => b.id === this.selected[0]) ?? null
    const snap = selected ? this.engine.curr.find((b) => b.id === selected.id) : null
    const selectedJoints = selected
      ? this.engine.doc.joints
          .filter((j) => j.bodyA === selected.id || j.bodyB === selected.id)
          .map((j) => {
            const otherId = j.bodyA === selected.id ? j.bodyB : j.bodyA
            const other = this.engine.doc.bodies.find((b) => b.id === otherId)
            return { ...structuredClone(j), otherName: other?.name ?? otherId }
          })
      : []
    const selectedFluid =
      this.engine.doc.fluidRegions.find((r) => r.id === this.selectedFluidId) ?? null
    // Undo/redo o borrar puede dejar un id huérfano; no empujar región fantasma a React.
    if (this.selectedFluidId && !selectedFluid) this.selectedFluidId = null
    store.setState({
      playing: this.engine.clock.playing,
      timeScale: this.engine.clock.timeScale,
      simTime: this.engine.clock.simTime,
      selectedId: selected?.id ?? null,
      selectedBody: selected ? structuredClone(selected) : null,
      selectedFluidId: selectedFluid?.id ?? null,
      selectedFluidRegion: selectedFluid ? structuredClone(selectedFluid) : null,
      fluidRegionOptions: this.engine.doc.fluidRegions.map((r) => ({ id: r.id, name: r.name })),
      fluidOverlapWarning: fluidOverlapWarning(this.engine.doc.fluidRegions),
      selectedJoints,
      live: snap
        ? {
            vx: snap.vx,
            vy: snap.vy,
            omega: snap.omega,
            mass: snap.mass,
            x: snap.x,
            y: snap.y,
            angle: snap.angle,
          }
        : null,
      bodyCount: this.engine.doc.bodies.length,
      fluidCount: this.engine.doc.fluidRegions.length + this.engine.doc.fluidVolumes.length,
      particleCount: this.engine.particles.particleCount,
      particlesTruncated: this.engine.particles.truncatedSeeds,
      particleLimit: PBF_MAX_PARTICLES,
      gravityPreset: this.engine.doc.world.gravityPreset,
      timings: {
        physics: this.engine.timings.physics,
        fluids: this.engine.timings.fluids,
        render: this.timings.render,
        frame: this.timings.frame,
        steps: this.engine.timings.steps,
        dropped: this.engine.clock.stepsDropped,
      },
      canUndo: this.history.canUndo(),
      canRedo: this.history.canRedo(),
    })
  }
}

export type { VizLayers }
