import { IdFactory } from '../core/ids.ts'
import { aabbFromShape, intersectsAABB, type AABB } from '../core/math/aabb.ts'
import { dist } from '../core/math/vec2.ts'
import type { Vec2 } from '../core/math/vec2.ts'
import { inverseTransformPoint, transformPoint } from '../core/math/transform.ts'
import { dragToForce, dragToImpulse, forceAnchorWorld } from '../interaction/force.ts'
import { getSolid } from '../materials/catalog.ts'
import { createCamera, screenToWorld, zoomAt, zoomToFit, type Camera } from '../camera/coords.ts'
import type { Tool } from '../interaction/tools.ts'
import { Tool as ToolId } from '../interaction/tools.ts'
import type { InteractionState } from '../interaction/state.ts'
import { reduceDown } from '../interaction/machine.ts'
import type { KinematicPose } from '../interaction/machine.ts'
import { PixiRenderer } from '../render/PixiRenderer.ts'
import {
  AddBodyCommand,
  AddFluidCommand,
  AddFluidVolumeCommand,
  AddJointCommand,
  BatchCommand,
  DuplicateBodyCommand,
  RemoveBodyCommand,
  RemoveFluidCommand,
  RemoveFluidVolumeCommand,
  RemoveJointCommand,
  SetWorldCommand,
  UpdateBodyCommand,
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
  type SceneJoint,
  type VizLayers,
} from '../scene/document.ts'
import { bodyToDesc } from '../scene/builder.ts'
import { jointToDesc, reattachJoints, springParamsForMasses } from '../scene/joints.ts'
import { parseDocument, serializeDocument } from '../scene/schema.ts'
import { SimulationEngine } from '../sim/engine.ts'
import type { GraphChannel, LabStore } from './store.ts'

const MIN_FORCE_DRAG = 0.04

export class LabRuntime {
  engine: SimulationEngine
  renderer = new PixiRenderer()
  camera: Camera = createCamera()
  history: History
  ids = new IdFactory(10)
  state: InteractionState = { kind: 'idle' }
  selected: string[] = []
  canvas: HTMLCanvasElement | null = null
  private raf = 0
  private lastT = 0
  private pointers = new Map<number, { x: number; y: number }>()
  private pinch: { dist: number; ppm: number } | null = null
  private store: LabStore | null = null
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
    this.bind(canvas)
    this.resize()
    this.lastT = performance.now()
    const loop = (t: number) => {
      if (session !== this.session) return
      const dt = (t - this.lastT) / 1000
      this.lastT = t
      const t0 = performance.now()
      try {
        this.engine.advance(dt)
        this.applySustainedForce()
        this.renderer.draw(
          this.engine,
          this.camera,
          this.store?.getState().viz ?? this.engine.doc.visualization,
          this.selected,
          this.state,
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

  private bind(canvas: HTMLCanvasElement): void {
    this.unbind?.()
    canvas.style.touchAction = 'none'
    const onPointer = (e: PointerEvent) => this.onPointer(e)
    const onWheel = (e: WheelEvent) => this.onWheel(e)
    const onContext = (e: Event) => e.preventDefault()
    const onDbl = (e: MouseEvent) => this.onDblClick(e)
    const onKeyDown = (e: KeyboardEvent) => this.onKeyDown(e)
    const onKeyUp = (e: KeyboardEvent) => this.onKeyUp(e)
    const onResize = () => this.resize()
    canvas.addEventListener('pointerdown', onPointer)
    canvas.addEventListener('pointermove', onPointer)
    canvas.addEventListener('pointerup', onPointer)
    canvas.addEventListener('pointercancel', onPointer)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('contextmenu', onContext)
    canvas.addEventListener('dblclick', onDbl)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('resize', onResize)
    const ro = new ResizeObserver(() => this.resize())
    ro.observe(canvas.parentElement ?? canvas)
    this.unbind = () => {
      canvas.removeEventListener('pointerdown', onPointer)
      canvas.removeEventListener('pointermove', onPointer)
      canvas.removeEventListener('pointerup', onPointer)
      canvas.removeEventListener('pointercancel', onPointer)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('contextmenu', onContext)
      canvas.removeEventListener('dblclick', onDbl)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('resize', onResize)
      ro.disconnect()
    }
  }

  resize(): void {
    if (!this.canvas) return
    const parent = this.canvas.parentElement
    const w = parent?.clientWidth ?? this.canvas.clientWidth
    const h = parent?.clientHeight ?? this.canvas.clientHeight
    this.renderer.resize(w, h)
  }

  private view() {
    return this.renderer.view
  }

  private worldOf(e: PointerEvent | MouseEvent): Vec2 {
    const rect = this.canvas!.getBoundingClientRect()
    return screenToWorld(
      { x: e.clientX - rect.left, y: e.clientY - rect.top },
      this.camera,
      this.view(),
    )
  }

  private screenOf(e: PointerEvent | MouseEvent): Vec2 {
    const rect = this.canvas!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  private tool(): Tool {
    return this.store?.getState().tool ?? 'select'
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault()
    const rect = this.canvas!.getBoundingClientRect()
    const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    const factor = e.deltaY > 0 ? 0.9 : 1.1
    this.camera = zoomAt(this.camera, screen, this.view(), factor)
  }

  private onPointer(e: PointerEvent): void {
    if (!this.canvas) return
    const world = this.worldOf(e)
    const screen = this.screenOf(e)

    if (e.type === 'pointerdown') {
      this.canvas.setPointerCapture(e.pointerId)
      this.pointers.set(e.pointerId, screen)
      if (this.pointers.size === 2) {
        const pts = [...this.pointers.values()]
        this.pinch = {
          dist: Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y),
          ppm: this.camera.pixelsPerMeter,
        }
        this.state = { kind: 'idle' }
        this.engine.persistentForces = []
        return
      }
      this.onDown(e, world, screen)
    } else if (e.type === 'pointermove') {
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, screen)
      if (this.pointers.size === 2 && this.pinch) {
        const pts = [...this.pointers.values()]
        const mid = { x: (pts[0]!.x + pts[1]!.x) / 2, y: (pts[0]!.y + pts[1]!.y) / 2 }
        const d = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y)
        const factor = d / (this.pinch.dist || 1)
        this.camera = zoomAt(
          { ...this.camera, pixelsPerMeter: this.pinch.ppm },
          mid,
          this.view(),
          factor,
        )
        return
      }
      this.onMove(e, world, screen)
    } else {
      this.pointers.delete(e.pointerId)
      if (this.pointers.size < 2) this.pinch = null
      this.onUp(e, world)
    }
  }

  private onDown(e: PointerEvent, world: Vec2, screen: Vec2): void {
    const hit = this.engine.bodyAt(world.x, world.y)
    const hitDynamic = this.hitDynamic(world.x, world.y)
    const res = reduceDown(this.state, {
      tool: this.tool(),
      world,
      screen,
      hit,
      hitDynamic,
      shiftKey: e.shiftKey,
      button: e.button,
      spaceHeld: this.store?.getState().spaceHeld,
      camera: { x: this.camera.x, y: this.camera.y },
      poseOf: (id) => this.poseOf(id),
      bodyOf: (id) => this.engine.doc.bodies.find((b) => b.id === id),
    })

    this.state = res.state
    if (res.selected !== undefined) {
      if (e.shiftKey && this.tool() === 'select' && res.selected.length) {
        this.selected = [...new Set([...this.selected, ...res.selected])]
      } else {
        this.selected = res.selected
      }
    }
    if (res.ensurePlaying) this.ensurePlaying()
    if (res.pushUi) this.pushUi()
  }

  private onMove(_e: PointerEvent, world: Vec2, screen: Vec2): void {
    const s = this.state
    if (s.kind === 'panning') {
      this.camera = {
        x: s.origX - (screen.x - s.startScreen.x) / this.camera.pixelsPerMeter,
        y: s.origY + (screen.y - s.startScreen.y) / this.camera.pixelsPerMeter,
        pixelsPerMeter: this.camera.pixelsPerMeter,
      }
      return
    }
    if (s.kind === 'dragging') {
      const x = world.x - s.local.x
      const y = world.y - s.local.y
      if (this.engine.clock.playing) {
        const snap = this.engine.curr.find((b) => b.id === s.bodyId)
        if (snap) {
          const k = Math.max(20, snap.mass * 8)
          this.engine.persistentForces = [
            { bodyId: s.bodyId, x: snap.x, y: snap.y, fx: (x - snap.x) * k, fy: (y - snap.y) * k },
          ]
        }
      } else {
        this.engine.world?.setTransform(s.bodyId, x, y, s.orig.angle)
        this.engine.syncBodies()
      }
      return
    }
    if (s.kind === 'creating') {
      this.state = { ...s, current: world }
      return
    }
    if (s.kind === 'applyingForce') {
      this.state = { ...s, current: world }
      if (s.mode === 'force') this.applySustainedForce()
      return
    }
    if (s.kind === 'measuring' || s.kind === 'selecting') {
      this.state = { ...s, current: world }
      return
    }
    if (s.kind === 'joining') {
      this.state = { ...s, current: world }
    }
  }

  private bodyBounds(b: SceneBody): AABB {
    const pose = this.poseOf(b.id)
    return aabbFromShape(b.shape, pose)
  }

  private onUp(_e: PointerEvent, world: Vec2): void {
    const s = this.state
    if (s.kind === 'selecting') {
      const minX = Math.min(s.start.x, world.x)
      const maxX = Math.max(s.start.x, world.x)
      const minY = Math.min(s.start.y, world.y)
      const maxY = Math.max(s.start.y, world.y)
      const selectBox: AABB = { minX, maxX, minY, maxY }
      const found: string[] = []
      for (const b of this.engine.doc.bodies) {
        const box = this.bodyBounds(b)
        if (intersectsAABB(selectBox, box)) {
          found.push(b.id)
        }
      }
      this.selected = found
      this.state = { kind: 'idle' }
      this.pushUi()
      return
    }
    if (s.kind === 'creating') {
      if (s.tool === 'polygon') {
        return
      }
      this.commitCreate(s.tool, s.start, world, s.points)
      this.state = { kind: 'idle' }
      return
    }
    if (s.kind === 'applyingForce') {
      const origin = forceAnchorWorld(s.local, this.poseOf(s.bodyId))
      const dx = s.current.x - origin.x
      const dy = s.current.y - origin.y
      if (s.mode === 'impulse' && Math.hypot(dx, dy) >= MIN_FORCE_DRAG) {
        const mass = this.bodyMass(s.bodyId)
        const j = dragToImpulse(mass, dx, dy)
        this.engine.world?.wake(s.bodyId)
        this.engine.applyImpulse(s.bodyId, j.x, j.y, origin)
        this.ensurePlaying()
      }
      this.engine.persistentForces = []
    }
    if (s.kind === 'dragging') {
      this.engine.persistentForces = []
      if (!this.engine.clock.playing) {
        const body = this.engine.doc.bodies.find((b) => b.id === s.bodyId)
        if (body) {
          const finalX = world.x - s.local.x
          const finalY = world.y - s.local.y
          this.history.apply(
            new UpdateBodyCommand(
              s.bodyId,
              { x: finalX, y: finalY, vx: s.orig.vx, vy: s.orig.vy, omega: s.orig.omega },
              { x: s.orig.x, y: s.orig.y, vx: s.orig.vx, vy: s.orig.vy, omega: s.orig.omega },
            ),
          )
        }
      }
    }
    if (s.kind === 'joining') {
      this.commitJoin(s, world)
    }
    this.state = { kind: 'idle' }
  }

  private onDblClick(e: MouseEvent): void {
    if (this.tool() === 'polygon' && this.state.kind === 'creating') {
      const { start, points } = this.state
      this.state = { kind: 'idle' }
      const cleanPoints = (points ?? []).filter((p, i, arr) => {
        if (i === 0) return true
        const prev = arr[i - 1]!
        return Math.hypot(p.x - prev.x, p.y - prev.y) > 0.05
      })
      this.commitCreate('polygon', start, this.worldOf(e), cleanPoints)
    }
  }

  private applySustainedForce(): void {
    if (this.state.kind !== 'applyingForce' || this.state.mode !== 'force') return
    const s = this.state
    const origin = forceAnchorWorld(s.local, this.poseOf(s.bodyId))
    const dx = s.current.x - origin.x
    const dy = s.current.y - origin.y
    const mass = this.bodyMass(s.bodyId)
    const f = dragToForce(mass, dx, dy)
    this.engine.world?.wake(s.bodyId)
    this.engine.persistentForces = [
      { bodyId: s.bodyId, x: origin.x, y: origin.y, fx: f.x, fy: f.y },
    ]
  }

  private hitDynamic(x: number, y: number): string | null {
    return this.engine.bodyAt(x, y, (id, body) => {
      if (body) return body.type === 'dynamic'
      const live = this.engine.world?.getBody(id)?.type
      return live === 'dynamic'
    })
  }

  private poseOf(id: string): KinematicPose {
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

  private bodyMass(id: string): number {
    return (
      this.engine.world?.getBody(id)?.mass ?? this.engine.curr.find((b) => b.id === id)?.mass ?? 1
    )
  }

  private ensurePlaying(): void {
    if (this.engine.clock.playing) return
    this.engine.play()
    this.pushUi()
  }

  private commitCreate(tool: Tool, a: Vec2, b: Vec2, points?: Vec2[]): void {
    const matId = this.store?.getState().materialId ?? 'wood'
    const id = this.ids.next('body')
    if (tool === 'circle') {
      const r = Math.max(0.08, dist(a, b))
      this.addBody(this.makeBody(id, 'Círculo', a.x, a.y, { kind: 'circle', radius: r }, matId))
    } else if (tool === 'rect') {
      const hx = Math.max(0.08, Math.abs(b.x - a.x) / 2)
      const hy = Math.max(0.08, Math.abs(b.y - a.y) / 2)
      const cx = (a.x + b.x) / 2
      const cy = (a.y + b.y) / 2
      this.addBody(this.makeBody(id, 'Rectángulo', cx, cy, { kind: 'box', hx, hy }, matId))
    } else if (tool === 'line') {
      const cx = (a.x + b.x) / 2
      const cy = (a.y + b.y) / 2
      const len = Math.max(0.2, dist(a, b))
      const angle = Math.atan2(b.y - a.y, b.x - a.x)
      this.addBody(
        this.makeBody(id, 'Plataforma', cx, cy, { kind: 'box', hx: len / 2, hy: 0.08 }, 'stone', {
          type: 'fixed',
          angle,
          locked: true,
          lockRotation: true,
        }),
      )
    } else if (tool === 'polygon' && points && points.length >= 3) {
      const cx = points.reduce((s, p) => s + p.x, 0) / points.length
      const cy = points.reduce((s, p) => s + p.y, 0) / points.length
      const verts = points.map((p) => ({ x: p.x - cx, y: p.y - cy }))
      this.addBody(
        this.makeBody(id, 'Polígono', cx, cy, { kind: 'convex', vertices: verts }, matId),
      )
    } else if (tool === 'fluid') {
      const minX = Math.min(a.x, b.x)
      const maxX = Math.max(a.x, b.x)
      const minY = Math.min(a.y, b.y)
      const maxY = Math.max(a.y, b.y)
      if (maxX - minX < 0.2 || maxY - minY < 0.2) return
      this.history.apply(
        new AddFluidCommand({
          id: this.ids.next('fluid'),
          name: 'Agua',
          polygon: [
            { x: minX, y: minY },
            { x: maxX, y: minY },
            { x: maxX, y: maxY },
            { x: minX, y: maxY },
          ],
          restSurfaceY: maxY,
          materialId: 'water',
        }),
      )
    } else if (tool === 'spill') {
      const minX = Math.min(a.x, b.x)
      const maxX = Math.max(a.x, b.x)
      const minY = Math.min(a.y, b.y)
      const maxY = Math.max(a.y, b.y)
      if (maxX - minX < 0.2 || maxY - minY < 0.2) return
      this.history.apply(
        new AddFluidVolumeCommand({
          id: this.ids.next('fluid'),
          name: 'Fluido libre',
          polygon: [
            { x: minX, y: minY },
            { x: maxX, y: minY },
            { x: maxX, y: maxY },
            { x: minX, y: maxY },
          ],
          materialId: 'water',
          spacing: 0.1,
        }),
      )
      this.engine.doc.visualization.fluidParticles = true
      // Append only the new volume — do not reseeds existing pools (that looked like an explosion).
      const created = this.engine.doc.fluidVolumes[this.engine.doc.fluidVolumes.length - 1]
      if (created) this.engine.particles.addVolume(created, this.engine.world)
      this.pushUi()
    }
  }

  private makeBody(
    id: string,
    name: string,
    x: number,
    y: number,
    shape: SceneBody['shape'],
    materialId: string,
    extra: Partial<SceneBody> = {},
  ): SceneBody {
    const mat = getSolid(materialId)
    return {
      id,
      name,
      type: extra.type ?? 'dynamic',
      x,
      y,
      angle: extra.angle ?? 0,
      vx: 0,
      vy: 0,
      omega: 0,
      massMode: 'density',
      density: mat.density,
      friction: mat.friction,
      restitution: mat.restitution,
      materialId,
      gravityScale: 1,
      linearDamping: mat.linearDamping,
      angularDamping: mat.angularDamping,
      ccd: true,
      locked: extra.locked ?? false,
      lockRotation: extra.lockRotation ?? false,
      ...extra,
      shape,
    }
  }

  addBody(body: SceneBody): void {
    this.history.apply(new AddBodyCommand(body))
    this.engine.world?.addBody(bodyToDesc(body))
    this.selected = [body.id]
    this.engine.world?.writeBodies(this.engine.curr)
    this.pushUi()
  }

  commitPatch(id: string, patch: Partial<SceneBody>): void {
    this.history.apply(new UpdateBodyCommand(id, patch))
    const body = this.engine.doc.bodies.find((b) => b.id === id)
    if (!body || !this.engine.world) return
    const rebuildKeys: (keyof SceneBody)[] = [
      'density',
      'mass',
      'massMode',
      'friction',
      'restitution',
      'shape',
      'materialId',
      'linearDamping',
      'angularDamping',
      'ccd',
      'lockRotation',
      'locked',
    ]
    if (rebuildKeys.some((k) => k in patch)) {
      const live = this.engine.world.getBody(id)
      this.engine.world.removeBody(id)
      const desc = bodyToDesc(body)
      if (live) {
        desc.translation = { x: live.x, y: live.y }
        desc.rotation = live.angle
        desc.linvel = { x: live.vx, y: live.vy }
        desc.angvel = live.omega
      }
      this.engine.world.addBody(desc)
      reattachJoints(this.engine.world, this.engine.doc, id)
      this.engine.syncBodies()
    } else {
      const live = this.engine.world.getBody(id)
      if (patch.x !== undefined || patch.y !== undefined || patch.angle !== undefined) {
        this.engine.world.setTransform(
          id,
          patch.x ?? live?.x ?? body.x,
          patch.y ?? live?.y ?? body.y,
          patch.angle ?? live?.angle ?? body.angle,
        )
      }
      if (patch.vx !== undefined || patch.vy !== undefined || patch.omega !== undefined) {
        this.engine.world.setVelocity(
          id,
          patch.vx ?? live?.vx ?? body.vx,
          patch.vy ?? live?.vy ?? body.vy,
          patch.omega ?? live?.omega ?? body.omega,
        )
      }
      if (patch.gravityScale !== undefined) this.engine.world.setGravityScale(id, body.gravityScale)
      if (patch.type !== undefined) this.engine.world.setBodyType(id, body.type)
      this.engine.syncBodies()
    }
    this.pushUi()
  }

  deleteSelected(): void {
    const commands = []
    for (const id of this.selected) {
      commands.push(new RemoveBodyCommand(id))
      this.engine.world?.removeBody(id)
    }
    if (commands.length) {
      this.history.apply(new BatchCommand(commands))
    }
    this.selected = []
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

  /** TODO: syncWorld incremental (docs/plan-de-mejora.md Fase 1). Reload evita divergencia documento/mundo. */
  undo(): void {
    if (!this.history.undo()) return
    void this.engine.reload(this.engine.doc).then(() => this.pushUi())
  }

  redo(): void {
    if (!this.history.redo()) return
    void this.engine.reload(this.engine.doc).then(() => this.pushUi())
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

  private commitJoin(s: Extract<InteractionState, { kind: 'joining' }>, world: Vec2): void {
    const hit = this.engine.bodyAt(world.x, world.y)
    if (!hit || hit === s.bodyA) return
    const poseA = this.poseOf(s.bodyA)
    const poseB = this.poseOf(hit)
    const worldA = transformPoint({ x: 0, y: 0 }, s.anchorA, poseA)
    const kind = this.store?.getState().jointKind ?? 'revolute'
    const coincident = kind === 'fixed' || kind === 'revolute'
    const localB = inverseTransformPoint({ x: 0, y: 0 }, coincident ? worldA : world, poseB)
    const joint: SceneJoint = {
      id: this.ids.next('joint'),
      kind,
      bodyA: s.bodyA,
      bodyB: hit,
      anchorA: { x: s.anchorA.x, y: s.anchorA.y },
      anchorB: { x: localB.x, y: localB.y },
    }
    if (kind === 'fixed') {
      joint.frameA = 0
      joint.frameB = poseA.angle - poseB.angle
    }
    if (kind === 'spring' || kind === 'rope') joint.restLength = dist(worldA, world)
    if (kind === 'spring') {
      const params = springParamsForMasses(this.bodyMass(s.bodyA), this.bodyMass(hit))
      joint.stiffness = params.stiffness
      joint.damping = params.damping
    }
    this.addJoint(joint)
  }

  async loadDocument(doc: SceneDocument): Promise<void> {
    this.history.clear()
    this.selected = []
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

  private onKeyDown(e: KeyboardEvent): void {
    const tag = (e.target as HTMLElement | null)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    const store = this.store
    if (!store) return

    if (e.code === 'Space') {
      store.setState({ spaceHeld: true })
      if (!e.repeat) {
        if (this.engine.clock.playing) this.engine.pause()
        else this.engine.play()
        this.pushUi()
        e.preventDefault()
      }
    }
    if (e.key === '.') this.engine.stepOnce()
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) this.redo()
      else this.undo()
    }
    if (e.key === 'Delete' || e.key === 'Backspace') this.deleteSelected()
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
      e.preventDefault()
      this.duplicateSelected()
    }
    const map: Record<string, Tool> = {
      v: ToolId.select,
      h: ToolId.pan,
      c: ToolId.circle,
      r: ToolId.rect,
      g: ToolId.polygon,
      l: ToolId.line,
      f: ToolId.force,
      m: ToolId.measure,
      w: ToolId.fluid,
      e: ToolId.spill,
      j: ToolId.joint,
    }
    const t = map[e.key.toLowerCase()]
    if (t && !e.ctrlKey && !e.metaKey) {
      store.setState({ tool: t })
      if (t !== 'joint' && this.state.kind === 'joining') this.state = { kind: 'idle' }
      this.engine.persistentForces = []
    }
    if (e.key === 'Escape') {
      this.state = { kind: 'idle' }
      this.engine.persistentForces = []
    }
    if (e.key === 'Enter' && this.state.kind === 'creating' && this.state.tool === 'polygon') {
      const { start, current, points } = this.state
      this.state = { kind: 'idle' }
      this.commitCreate('polygon', start, current, points)
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (e.code === 'Space') {
      this.store?.setState({ spaceHeld: false })
    }
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
    store.setState({
      playing: this.engine.clock.playing,
      timeScale: this.engine.clock.timeScale,
      simTime: this.engine.clock.simTime,
      selectedId: selected?.id ?? null,
      selectedBody: selected ? structuredClone(selected) : null,
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
