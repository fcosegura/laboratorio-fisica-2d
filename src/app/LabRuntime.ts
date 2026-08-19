import { IdFactory } from '../core/ids.ts'
import { dist } from '../core/math/vec2.ts'
import type { Vec2 } from '../core/math/vec2.ts'
import { inverseTransformPoint, transformPoint, type Transform } from '../core/math/transform.ts'
import { dragToForce, dragToImpulse, forceAnchorWorld } from '../interaction/force.ts'
import { getSolid } from '../materials/catalog.ts'
import {
  createCamera,
  panCamera,
  screenToWorld,
  zoomAt,
  zoomToFit,
  type Camera,
} from '../camera/coords.ts'
import type { Tool } from '../interaction/tools.ts'
import { Tool as ToolId } from '../interaction/tools.ts'
import type { InteractionState } from '../interaction/state.ts'
import { PixiRenderer } from '../render/PixiRenderer.ts'
import {
  AddBodyCommand,
  AddFluidCommand,
  AddJointCommand,
  DuplicateBodyCommand,
  RemoveBodyCommand,
  RemoveJointCommand,
  UpdateBodyCommand,
  UpdateJointCommand,
} from '../scene/commands.ts'
import { History } from '../scene/history.ts'
import { cloneDocument, emptyScene, GRAVITY_PRESETS, type SceneBody, type SceneDocument, type SceneJoint, type VizLayers } from '../scene/document.ts'
import { jointToDesc, reattachJoints, springParamsForMasses } from '../scene/joints.ts'
import { parseDocument, serializeDocument } from '../scene/schema.ts'
import { SimulationEngine } from '../sim/engine.ts'
import type { LabStore } from './store.ts'

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
    await this.engine.init()
    if (session !== this.session) return
    await this.renderer.init(canvas)
    if (session !== this.session) return
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
    const onKey = (e: KeyboardEvent) => this.onKey(e)
    const onResize = () => this.resize()
    canvas.addEventListener('pointerdown', onPointer)
    canvas.addEventListener('pointermove', onPointer)
    canvas.addEventListener('pointerup', onPointer)
    canvas.addEventListener('pointercancel', onPointer)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('contextmenu', onContext)
    canvas.addEventListener('dblclick', onDbl)
    window.addEventListener('keydown', onKey)
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
      window.removeEventListener('keydown', onKey)
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
    return screenToWorld({ x: e.clientX - rect.left, y: e.clientY - rect.top }, this.camera, this.view())
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
        return
      }
      this.onDown(e, world, screen)
    } else if (e.type === 'pointermove') {
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, screen)
      if (this.pointers.size === 2 && this.pinch) {
        const pts = [...this.pointers.values()]
        const d = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y)
        this.camera = {
          ...this.camera,
          pixelsPerMeter: this.pinch.ppm * (d / (this.pinch.dist || 1)),
        }
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
    const tool = this.tool()
    if (this.state.kind === 'joining' && tool !== 'joint') this.state = { kind: 'idle' }
    const space = this.store?.getState().spaceHeld
    if (e.button === 1 || e.button === 2 || tool === 'pan' || space) {
      this.state = { kind: 'panning', startScreen: screen, origX: this.camera.x, origY: this.camera.y }
      return
    }
    const hit = this.engine.bodyAt(world.x, world.y)

    if (tool === 'select') {
      if (hit) {
        this.selected = e.shiftKey ? [...new Set([...this.selected, hit])] : [hit]
        const body = this.engine.doc.bodies.find((b) => b.id === hit)!
        this.state = {
          kind: 'dragging',
          bodyId: hit,
          local: { x: world.x - body.x, y: world.y - body.y },
          startWorld: world,
          orig: { x: body.x, y: body.y, angle: body.angle },
        }
      } else {
        this.selected = []
        this.state = { kind: 'selecting', start: world, current: world }
      }
      this.pushUi()
      return
    }

    if (tool === 'force') {
      const bodyId = this.hitDynamic(world.x, world.y)
      if (!bodyId) return
      this.selected = [bodyId]
      const pose = this.poseOf(bodyId)
      this.state = {
        kind: 'applyingForce',
        bodyId,
        local: inverseTransformPoint({ x: 0, y: 0 }, world, pose),
        current: world,
        mode: e.shiftKey ? 'force' : 'impulse',
      }
      if (e.shiftKey) this.ensurePlaying()
      this.pushUi()
      return
    }

    if (tool === 'measure') {
      this.state = { kind: 'measuring', start: world, current: world }
      return
    }

    if (tool === 'joint') {
      if (!hit) return
      this.selected = [hit]
      const pose = this.poseOf(hit)
      const local = inverseTransformPoint({ x: 0, y: 0 }, world, pose)
      this.state = {
        kind: 'joining',
        bodyA: hit,
        anchorA: { x: local.x, y: local.y },
        current: { x: world.x, y: world.y },
      }
      this.pushUi()
      return
    }

    if (tool === 'polygon') {
      if (this.state.kind === 'creating' && this.state.tool === 'polygon') {
        this.state.points = [...(this.state.points ?? []), world]
        this.state.current = world
      } else {
        this.state = { kind: 'creating', tool: 'polygon', start: world, current: world, points: [world] }
      }
      return
    }

    if (tool === 'circle' || tool === 'rect' || tool === 'line' || tool === 'fluid') {
      this.state = { kind: 'creating', tool, start: world, current: world }
    }
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
        this.patchBody(s.bodyId, { x, y })
        this.engine.world?.setTransform(s.bodyId, x, y, s.orig.angle)
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
    }
    if (s.kind === 'joining') {
      this.state = { ...s, current: world }
    }
  }

  private onUp(_e: PointerEvent, world: Vec2): void {
    const s = this.state
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
          this.history.apply(
            new UpdateBodyCommand(s.bodyId, { x: body.x, y: body.y, vx: 0, vy: 0, omega: 0 }),
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
      this.commitCreate('polygon', start, this.worldOf(e), points)
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
    this.engine.persistentForces = [{ bodyId: s.bodyId, x: origin.x, y: origin.y, fx: f.x, fy: f.y }]
  }

  private hitDynamic(x: number, y: number): string | null {
    return (
      this.engine.world?.pointHit(x, y, {
        predicate: (id) => this.engine.world?.getBody(id)?.type === 'dynamic',
      })?.bodyId ?? null
    )
  }

  private poseOf(id: string): Transform {
    const snap = this.engine.interpolated(id)
    if (snap) return { x: snap.x, y: snap.y, angle: snap.angle }
    const body = this.engine.doc.bodies.find((b) => b.id === id)
    return { x: body?.x ?? 0, y: body?.y ?? 0, angle: body?.angle ?? 0 }
  }

  private bodyMass(id: string): number {
    return this.engine.world?.getBody(id)?.mass ?? this.engine.curr.find((b) => b.id === id)?.mass ?? 1
  }

  private ensurePlaying(): void {
    if (this.engine.clock.playing) return
    this.engine.play()
    this.pushUi()
  }

  private commitCreate(tool: Tool, a: Vec2, b: Vec2, points?: Vec2[]): void {
    const matId = this.store?.getState().materialId ?? 'wood'
    const mat = getSolid(matId)
    const id = this.ids.next('body')
    if (tool === 'circle') {
      const r = Math.max(0.08, dist(a, b))
      this.addBody(
        this.makeBody(id, 'Círculo', a.x, a.y, { kind: 'circle', radius: r }, matId),
      )
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
      this.addBody(this.makeBody(id, 'Polígono', cx, cy, { kind: 'convex', vertices: verts }, matId))
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
    }
    void mat
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
    this.engine.world?.addBody({
      id: body.id,
      type: body.type,
      translation: { x: body.x, y: body.y },
      rotation: body.angle,
      gravityScale: body.gravityScale,
      linearDamping: body.linearDamping,
      angularDamping: body.angularDamping,
      ccd: body.ccd,
      lockRotation: body.lockRotation,
      colliders: [
        {
          shape: body.shape,
          density: body.density,
          friction: body.friction,
          restitution: body.restitution,
        },
      ],
    })
    this.selected = [body.id]
    this.engine.world?.writeBodies(this.engine.curr)
    this.pushUi()
  }

  patchBody(id: string, patch: Partial<SceneBody>): void {
    const body = this.engine.doc.bodies.find((b) => b.id === id)
    if (body) Object.assign(body, patch)
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
      this.engine.world.removeBody(id)
      this.engine.world.addBody({
        id: body.id,
        type: body.type,
        translation: { x: body.x, y: body.y },
        rotation: body.angle,
        linvel: { x: body.vx, y: body.vy },
        angvel: body.omega,
        gravityScale: body.gravityScale,
        linearDamping: body.linearDamping,
        angularDamping: body.angularDamping,
        ccd: body.ccd,
        lockRotation: body.lockRotation,
        colliders: [
          {
            shape: body.shape,
            ...(body.massMode === 'explicit' && body.mass
              ? { mass: body.mass }
              : { density: body.density }),
            friction: body.friction,
            restitution: body.restitution,
          },
        ],
      })
      reattachJoints(this.engine.world, this.engine.doc, id)
    } else {
      if (patch.x !== undefined || patch.y !== undefined || patch.angle !== undefined) {
        this.engine.world.setTransform(id, body.x, body.y, body.angle)
      }
      if (patch.vx !== undefined || patch.vy !== undefined || patch.omega !== undefined) {
        this.engine.world.setVelocity(id, body.vx, body.vy, body.omega)
      }
      if (patch.gravityScale !== undefined) this.engine.world.setGravityScale(id, body.gravityScale)
      if (patch.type !== undefined) this.engine.world.setBodyType(id, body.type)
    }
    this.pushUi()
  }

  deleteSelected(): void {
    for (const id of this.selected) {
      this.history.apply(new RemoveBodyCommand(id))
      this.engine.world?.removeBody(id)
    }
    this.selected = []
    this.pushUi()
  }

  setTimeScale(s: number): void {
    this.engine.setTimeScale(s)
    this.pushUi()
  }

  duplicateSelected(): void {
    const created: string[] = []
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
      this.history.apply(new DuplicateBodyCommand(id, copy))
      this.engine.world?.addBody({
        id: copy.id,
        type: copy.type,
        translation: { x: copy.x, y: copy.y },
        rotation: copy.angle,
        gravityScale: copy.gravityScale,
        linearDamping: copy.linearDamping,
        angularDamping: copy.angularDamping,
        ccd: copy.ccd,
        lockRotation: copy.lockRotation,
        colliders: [
          {
            shape: copy.shape,
            density: copy.density,
            friction: copy.friction,
            restitution: copy.restitution,
          },
        ],
      })
      created.push(copy.id)
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
    this.engine.doc.camera = { ...this.camera }
    this.engine.doc.visualization = this.store?.getState().viz ?? this.engine.doc.visualization
    return serializeDocument(this.engine.doc)
  }

  async importJson(text: string): Promise<void> {
    await this.loadDocument(parseDocument(text))
  }

  private onKey(e: KeyboardEvent): void {
    const tag = (e.target as HTMLElement | null)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    const store = this.store
    if (!store) return
    if (e.code === 'Space' && e.repeat) return
    if (e.key === ' ') {
      if (this.engine.clock.playing) this.engine.pause()
      else this.engine.play()
      this.pushUi()
      e.preventDefault()
    }
    if (e.key === '.') this.engine.stepOnce()
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault()
      if (e.shiftKey) this.history.redo()
      else this.history.undo()
      void this.engine.reload(this.engine.doc)
    }
    if (e.key === 'Delete' || e.key === 'Backspace') this.deleteSelected()
    if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
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
      j: ToolId.joint,
    }
    const t = map[e.key.toLowerCase()]
    if (t && !e.ctrlKey && !e.metaKey) {
      store.setState({ tool: t })
      if (t !== 'joint' && this.state.kind === 'joining') this.state = { kind: 'idle' }
    }
    if (e.key === 'Escape') this.state = { kind: 'idle' }
    if (e.key === 'Enter' && this.state.kind === 'creating' && this.state.tool === 'polygon') {
      const { start, current, points } = this.state
      this.state = { kind: 'idle' }
      this.commitCreate('polygon', start, current, points)
    }
  }

  pushUi(): void {
    const store = this.store
    if (!store) return
    const selected = this.engine.doc.bodies.find((b) => b.id === this.selected[0]) ?? null
    const snap = selected ? this.engine.curr.find((b) => b.id === selected.id) : null
    const selectedJoints = selected
      ? this.engine.doc.joints.filter((j) => j.bodyA === selected.id || j.bodyB === selected.id)
      : []
    store.setState({
      playing: this.engine.clock.playing,
      timeScale: this.engine.clock.timeScale,
      simTime: this.engine.clock.simTime,
      selectedId: selected?.id ?? null,
      selectedBody: selected,
      selectedJoints,
      live: snap
        ? { vx: snap.vx, vy: snap.vy, omega: snap.omega, mass: snap.mass, x: snap.x, y: snap.y, angle: snap.angle }
        : null,
      bodyCount: this.engine.doc.bodies.length,
      particleCount: 0,
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

void panCamera
void cloneDocument
void GRAVITY_PRESETS
void IdFactory

export type { VizLayers }
