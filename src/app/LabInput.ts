import { aabbFromShape, intersectsAABB, type AABB } from '../core/math/aabb.ts'
import { isConvex, polygonArea, polygonCentroid } from '../core/math/polygon.ts'
import { inverseTransformPoint, transformPoint } from '../core/math/transform.ts'
import { dist } from '../core/math/vec2.ts'
import type { Vec2 } from '../core/math/vec2.ts'
import { screenToWorld, zoomAt } from '../camera/coords.ts'
import { dragToForce, dragToImpulse, forceAnchorWorld } from '../interaction/force.ts'
import { handleAt, moveVertex, scaleFactor, scaleShape, vertexAt } from '../interaction/handles.ts'
import { reduceDown, reduceMove } from '../interaction/machine.ts'
import type { InteractionState } from '../interaction/state.ts'
import type { Tool } from '../interaction/tools.ts'
import { Tool as ToolId } from '../interaction/tools.ts'
import { applySolidPreset } from '../materials/applyPreset.ts'
import { DEFAULT_FLUID, getFluid } from '../materials/catalog.ts'
import { AddFluidCommand, AddFluidVolumeCommand, UpdateBodyCommand } from '../scene/commands.ts'
import type { SceneBody, SceneJoint } from '../scene/document.ts'
import { springParamsForMasses } from '../scene/joints.ts'
import { pickFluidRegion } from '../scene/picking.ts'
import type { LabRuntime } from './LabRuntime.ts'

const MIN_FORCE_DRAG = 0.04

/**
 * Pointer, wheel and keyboard input for the lab canvas, and the creation gestures they
 * drive (bodies, tanks, spills, joints, handles). Edits go through the runtime's
 * History-backed API; this class owns no document state.
 */
export class LabInput {
  private readonly lab: LabRuntime
  private pointers = new Map<number, { x: number; y: number }>()
  private pinch: { dist: number; ppm: number } | null = null

  constructor(lab: LabRuntime) {
    this.lab = lab
  }

  /** Attach pointer, wheel and keyboard listeners; returns the detach function. */
  bind(canvas: HTMLCanvasElement): () => void {
    canvas.style.touchAction = 'none'
    const onPointer = (e: PointerEvent) => this.onPointer(e)
    const onWheel = (e: WheelEvent) => this.onWheel(e)
    const onContext = (e: Event) => e.preventDefault()
    const onDbl = (e: MouseEvent) => this.onDblClick(e)
    const onKeyDown = (e: KeyboardEvent) => this.onKeyDown(e)
    const onKeyUp = (e: KeyboardEvent) => this.onKeyUp(e)
    const onResize = () => this.lab.resize()
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
    const ro = new ResizeObserver(() => this.lab.resize())
    ro.observe(canvas.parentElement ?? canvas)
    return () => {
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

  private worldOf(e: PointerEvent | MouseEvent): Vec2 {
    const rect = this.lab.canvas!.getBoundingClientRect()
    return screenToWorld(
      { x: e.clientX - rect.left, y: e.clientY - rect.top },
      this.lab.camera,
      this.lab.view(),
    )
  }

  private screenOf(e: PointerEvent | MouseEvent): Vec2 {
    const rect = this.lab.canvas!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault()
    const rect = this.lab.canvas!.getBoundingClientRect()
    const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    const factor = e.deltaY > 0 ? 0.9 : 1.1
    this.lab.camera = zoomAt(this.lab.camera, screen, this.lab.view(), factor)
  }

  private onPointer(e: PointerEvent): void {
    if (!this.lab.canvas) return
    const world = this.worldOf(e)
    const screen = this.screenOf(e)

    if (e.type === 'pointerdown') {
      this.lab.canvas.setPointerCapture(e.pointerId)
      this.pointers.set(e.pointerId, screen)
      if (this.pointers.size === 2) {
        const pts = [...this.pointers.values()]
        this.pinch = {
          dist: Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y),
          ppm: this.lab.camera.pixelsPerMeter,
        }
        this.lab.state = { kind: 'idle' }
        this.lab.engine.persistentForces = []
        this.lab.engine.grab = null
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
        this.lab.camera = zoomAt(
          { ...this.lab.camera, pixelsPerMeter: this.pinch.ppm },
          mid,
          this.lab.view(),
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
    if (this.lab.store?.getState().notice) this.lab.store.setState({ notice: null })
    const hit = this.lab.engine.bodyAt(world.x, world.y)
    const hitDynamic = this.hitDynamic(world.x, world.y)
    const layout = this.lab.handles()
    const handleKind = layout ? handleAt(layout, world) : null
    const region =
      this.lab.tool() === 'select' && this.lab.selectedFluidId
        ? this.lab.engine.doc.fluidRegions.find((f) => f.id === this.lab.selectedFluidId)
        : undefined
    const vertexIndex = region
      ? vertexAt(region.polygon, world, this.lab.camera.pixelsPerMeter)
      : -1
    const res = reduceDown(this.lab.state, {
      handle: layout && handleKind ? { kind: handleKind, layout } : null,
      vertex: region && vertexIndex >= 0 ? { regionId: region.id, index: vertexIndex } : null,
      tool: this.lab.tool(),
      world,
      screen,
      hit,
      hitDynamic,
      shiftKey: e.shiftKey,
      button: e.button,
      spaceHeld: this.lab.store?.getState().spaceHeld,
      camera: { x: this.lab.camera.x, y: this.lab.camera.y },
      poseOf: (id) => this.lab.poseOf(id),
      bodyOf: (id) => this.lab.engine.doc.bodies.find((b) => b.id === id),
    })

    this.lab.state = res.state
    if (res.selected !== undefined) {
      if (e.shiftKey && this.lab.tool() === 'select' && res.selected.length) {
        this.lab.selected = [...new Set([...this.lab.selected, ...res.selected])]
      } else {
        this.lab.selected = res.selected
      }
      if (res.selected.length) this.lab.selectedFluidId = null
    }

    // Select tool miss on bodies: try fluid region before marquee.
    if (
      this.lab.tool() === 'select' &&
      !hit &&
      e.button === 0 &&
      !this.lab.store?.getState().spaceHeld &&
      this.lab.state.kind === 'selecting'
    ) {
      const fluidId = pickFluidRegion(this.lab.engine.doc.fluidRegions, world.x, world.y)
      if (fluidId) {
        this.lab.selected = []
        this.lab.selectedFluidId = fluidId
        this.lab.state = { kind: 'idle' }
        this.lab.pushUi()
        return
      }
      this.lab.selectedFluidId = null
    }

    if (res.ensurePlaying) this.lab.ensurePlaying()
    if (res.pushUi) this.lab.pushUi()
  }

  private onMove(_e: PointerEvent, world: Vec2, screen: Vec2): void {
    const s = this.lab.state
    if (s.kind === 'panning') {
      this.lab.camera = {
        x: s.origX - (screen.x - s.startScreen.x) / this.lab.camera.pixelsPerMeter,
        y: s.origY + (screen.y - s.startScreen.y) / this.lab.camera.pixelsPerMeter,
        pixelsPerMeter: this.lab.camera.pixelsPerMeter,
      }
      return
    }
    if (s.kind === 'dragging') {
      const x = world.x - s.local.x
      const y = world.y - s.local.y
      if (this.lab.engine.clock.playing) {
        this.lab.engine.grab = { bodyId: s.bodyId, targetX: x, targetY: y }
      } else {
        this.lab.engine.world?.setTransform(s.bodyId, x, y, s.orig.angle)
        this.lab.engine.syncBodies()
      }
      return
    }
    if (s.kind === 'rotating') {
      const next = reduceMove(s, world)
      this.lab.state = next
      if (next.kind === 'rotating') {
        const pose = this.lab.poseOf(s.bodyId)
        this.lab.engine.world?.setTransform(s.bodyId, pose.x, pose.y, next.angle)
        this.lab.engine.syncBodies()
      }
      return
    }
    if (s.kind === 'scaling' || s.kind === 'editingVertex') {
      this.lab.state = reduceMove(s, world)
      return
    }
    if (s.kind === 'creating') {
      this.lab.state = { ...s, current: world }
      return
    }
    if (s.kind === 'applyingForce') {
      this.lab.state = { ...s, current: world }
      if (s.mode === 'force') this.applySustainedForce()
      return
    }
    if (s.kind === 'measuring' || s.kind === 'selecting') {
      this.lab.state = { ...s, current: world }
      return
    }
    if (s.kind === 'joining') {
      this.lab.state = { ...s, current: world }
    }
  }

  private bodyBounds(b: SceneBody): AABB {
    const pose = this.lab.poseOf(b.id)
    return aabbFromShape(b.shape, pose)
  }

  private onUp(_e: PointerEvent, world: Vec2): void {
    const s = this.lab.state
    if (s.kind === 'selecting') {
      const minX = Math.min(s.start.x, world.x)
      const maxX = Math.max(s.start.x, world.x)
      const minY = Math.min(s.start.y, world.y)
      const maxY = Math.max(s.start.y, world.y)
      const selectBox: AABB = { minX, maxX, minY, maxY }
      const found: string[] = []
      for (const b of this.lab.engine.doc.bodies) {
        const box = this.bodyBounds(b)
        if (intersectsAABB(selectBox, box)) {
          found.push(b.id)
        }
      }
      this.lab.selected = found
      this.lab.state = { kind: 'idle' }
      this.lab.selectedFluidId = null
      this.lab.pushUi()
      return
    }
    if (s.kind === 'creating') {
      if (s.tool === 'polygon') {
        return
      }
      this.commitCreate(s.tool, s.start, world, s.points)
      this.lab.state = { kind: 'idle' }
      return
    }
    if (s.kind === 'applyingForce') {
      const origin = forceAnchorWorld(s.local, this.lab.poseOf(s.bodyId))
      const dx = s.current.x - origin.x
      const dy = s.current.y - origin.y
      if (s.mode === 'impulse' && Math.hypot(dx, dy) >= MIN_FORCE_DRAG) {
        const mass = this.lab.bodyMass(s.bodyId)
        const j = dragToImpulse(mass, dx, dy)
        this.lab.engine.world?.wake(s.bodyId)
        this.lab.engine.applyImpulse(s.bodyId, j.x, j.y, origin)
        this.lab.ensurePlaying()
      }
      this.lab.engine.persistentForces = []
      this.lab.engine.grab = null
    }
    if (s.kind === 'dragging') {
      this.lab.engine.persistentForces = []
      this.lab.engine.grab = null
      if (!this.lab.engine.clock.playing) {
        const body = this.lab.engine.doc.bodies.find((b) => b.id === s.bodyId)
        const finalX = world.x - s.local.x
        const finalY = world.y - s.local.y
        // A plain click (no movement) must not leave an empty Ctrl+Z entry.
        const moved = Math.hypot(finalX - s.orig.x, finalY - s.orig.y) > 1e-9
        if (body && moved) {
          this.lab.history.apply(
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
    if (s.kind === 'rotating') {
      this.lab.state = { kind: 'idle' }
      // Same rule as the inspector: persist the authored angle, apply only that field.
      if (Math.abs(s.angle - s.origAngle) > 1e-6) this.lab.commitPatch(s.bodyId, { angle: s.angle })
      return
    }
    if (s.kind === 'editingVertex') {
      this.lab.state = { kind: 'idle' }
      const region = this.lab.engine.doc.fluidRegions.find((f) => f.id === s.regionId)
      if (!region) return
      const polygon = moveVertex(region.polygon, s.index, world)
      // The analytic tank needs a convex polygon (schema + Sutherland–Hodgman clip).
      if (isConvex(polygon) && polygonArea(polygon) > 0.04) {
        this.lab.commitFluidPatch(region.id, { polygon })
      } else {
        this.lab.store?.setState({
          notice: 'El tanque debe seguir siendo convexo; cambio descartado',
        })
      }
      return
    }
    if (s.kind === 'scaling') {
      this.lab.state = { kind: 'idle' }
      const body = this.lab.engine.doc.bodies.find((b) => b.id === s.bodyId)
      if (body) {
        const k = scaleFactor(body.shape, s.center, s.start, world)
        if (Math.abs(k - 1) > 1e-3)
          this.lab.commitPatch(s.bodyId, { shape: scaleShape(body.shape, k) })
      }
      return
    }
    this.lab.state = { kind: 'idle' }
  }

  private onDblClick(e: MouseEvent): void {
    if (this.lab.tool() === 'polygon' && this.lab.state.kind === 'creating') {
      const { start, points } = this.lab.state
      this.lab.state = { kind: 'idle' }
      const cleanPoints = (points ?? []).filter((p, i, arr) => {
        if (i === 0) return true
        const prev = arr[i - 1]!
        return Math.hypot(p.x - prev.x, p.y - prev.y) > 0.05
      })
      this.commitCreate('polygon', start, this.worldOf(e), cleanPoints)
    }
  }

  /** Re-aim the sustained force at the moving body (called every frame). */
  applySustainedForce(): void {
    if (this.lab.state.kind !== 'applyingForce' || this.lab.state.mode !== 'force') return
    const s = this.lab.state
    const origin = forceAnchorWorld(s.local, this.lab.poseOf(s.bodyId))
    const dx = s.current.x - origin.x
    const dy = s.current.y - origin.y
    const mass = this.lab.bodyMass(s.bodyId)
    const f = dragToForce(mass, dx, dy)
    this.lab.engine.world?.wake(s.bodyId)
    this.lab.engine.persistentForces = [
      { bodyId: s.bodyId, x: origin.x, y: origin.y, fx: f.x, fy: f.y },
    ]
  }

  private hitDynamic(x: number, y: number): string | null {
    return this.lab.engine.bodyAt(x, y, (id, body) => {
      if (body) return body.type === 'dynamic'
      const live = this.lab.engine.world?.getBody(id)?.type
      return live === 'dynamic'
    })
  }

  private commitCreate(tool: Tool, a: Vec2, b: Vec2, points?: Vec2[]): void {
    const matId = this.lab.store?.getState().materialId ?? 'wood'
    const id = this.lab.ids.next('body')
    if (tool === 'circle') {
      const r = Math.max(0.08, dist(a, b))
      this.lab.addBody(this.makeBody(id, 'Círculo', a.x, a.y, { kind: 'circle', radius: r }, matId))
    } else if (tool === 'rect') {
      const hx = Math.max(0.08, Math.abs(b.x - a.x) / 2)
      const hy = Math.max(0.08, Math.abs(b.y - a.y) / 2)
      const cx = (a.x + b.x) / 2
      const cy = (a.y + b.y) / 2
      this.lab.addBody(this.makeBody(id, 'Rectángulo', cx, cy, { kind: 'box', hx, hy }, matId))
    } else if (tool === 'line') {
      const cx = (a.x + b.x) / 2
      const cy = (a.y + b.y) / 2
      const len = Math.max(0.2, dist(a, b))
      const angle = Math.atan2(b.y - a.y, b.x - a.x)
      this.lab.addBody(
        this.makeBody(id, 'Plataforma', cx, cy, { kind: 'box', hx: len / 2, hy: 0.08 }, 'stone', {
          type: 'fixed',
          angle,
          locked: true,
          lockRotation: true,
        }),
      )
    } else if (tool === 'polygon' && points && points.length >= 3) {
      // Area centroid, not the vertex mean: the body origin then matches Rapier's COM.
      const { x: cx, y: cy } = polygonCentroid(points)
      const verts = points.map((p) => ({ x: p.x - cx, y: p.y - cy }))
      this.lab.addBody(
        this.makeBody(id, 'Polígono', cx, cy, { kind: 'convex', vertices: verts }, matId),
      )
    } else if (tool === 'fluid') {
      const minX = Math.min(a.x, b.x)
      const maxX = Math.max(a.x, b.x)
      const minY = Math.min(a.y, b.y)
      const maxY = Math.max(a.y, b.y)
      if (maxX - minX < 0.2 || maxY - minY < 0.2) return
      const fluidMatId = this.lab.store?.getState().fluidMaterialId ?? DEFAULT_FLUID
      const fluid = getFluid(fluidMatId)
      const regionId = this.lab.ids.next('fluid')
      this.lab.history.apply(
        new AddFluidCommand({
          id: regionId,
          name: fluid.name,
          polygon: [
            { x: minX, y: minY },
            { x: maxX, y: minY },
            { x: maxX, y: maxY },
            { x: minX, y: maxY },
          ],
          restSurfaceY: maxY,
          materialId: fluid.id,
        }),
      )
      this.lab.selected = []
      this.lab.selectedFluidId = regionId
      this.lab.pushUi()
    } else if (tool === 'spill') {
      const minX = Math.min(a.x, b.x)
      const maxX = Math.max(a.x, b.x)
      const minY = Math.min(a.y, b.y)
      const maxY = Math.max(a.y, b.y)
      if (maxX - minX < 0.2 || maxY - minY < 0.2) return
      const fluidMatId = this.lab.store?.getState().fluidMaterialId ?? DEFAULT_FLUID
      const fluid = getFluid(fluidMatId)
      this.lab.history.apply(
        new AddFluidVolumeCommand({
          id: this.lab.ids.next('fluid'),
          name: `${fluid.name} libre`,
          polygon: [
            { x: minX, y: minY },
            { x: maxX, y: minY },
            { x: maxX, y: maxY },
            { x: minX, y: maxY },
          ],
          materialId: fluid.id,
          spacing: 0.1,
        }),
      )
      const viz = this.lab.store?.getState().viz
      if (viz && !viz.fluidParticles)
        this.lab.store?.setState({ viz: { ...viz, fluidParticles: true } })
      // Append only the new volume — do not reseeds existing pools (that looked like an explosion).
      const created = this.lab.engine.doc.fluidVolumes[this.lab.engine.doc.fluidVolumes.length - 1]
      if (created) this.lab.engine.particles.addVolume(created, this.lab.engine.world)
      this.lab.pushUi()
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
      gravityScale: 1,
      ccd: true,
      locked: extra.locked ?? false,
      lockRotation: extra.lockRotation ?? false,
      ...applySolidPreset(materialId),
      // Hand-drawn bodies fall in vacuum: catalog damping is an invisible air drag
      // (~5 % off v after 2 s) and the inspector has no field for it.
      linearDamping: 0,
      angularDamping: 0,
      ...extra,
      shape,
    }
  }

  private commitJoin(s: Extract<InteractionState, { kind: 'joining' }>, world: Vec2): void {
    const hit = this.lab.engine.bodyAt(world.x, world.y)
    if (!hit || hit === s.bodyA) return
    const poseA = this.lab.poseOf(s.bodyA)
    const poseB = this.lab.poseOf(hit)
    const worldA = transformPoint({ x: 0, y: 0 }, s.anchorA, poseA)
    const kind = this.lab.store?.getState().jointKind ?? 'revolute'
    const coincident = kind === 'fixed' || kind === 'revolute'
    const localB = inverseTransformPoint({ x: 0, y: 0 }, coincident ? worldA : world, poseB)
    const joint: SceneJoint = {
      id: this.lab.ids.next('joint'),
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
      const params = springParamsForMasses(this.lab.bodyMass(s.bodyA), this.lab.bodyMass(hit))
      joint.stiffness = params.stiffness
      joint.damping = params.damping
    }
    this.lab.addJoint(joint)
  }

  private onKeyDown(e: KeyboardEvent): void {
    const tag = (e.target as HTMLElement | null)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    const store = this.lab.store
    if (!store) return

    if (e.code === 'Space') {
      e.preventDefault()
      store.setState({ spaceHeld: true })
      if (!e.repeat) {
        if (this.lab.engine.clock.playing) this.lab.engine.pause()
        else this.lab.engine.play()
        this.lab.pushUi()
      }
    }
    if (e.key === '.') this.lab.engine.stepOnce()
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) this.lab.redo()
      else this.lab.undo()
    }
    if (e.key === 'Delete' || e.key === 'Backspace') this.lab.deleteSelected()
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
      e.preventDefault()
      this.lab.duplicateSelected()
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
      if (t !== 'joint' && this.lab.state.kind === 'joining') this.lab.state = { kind: 'idle' }
      this.lab.engine.persistentForces = []
      this.lab.engine.grab = null
    }
    if (e.key === 'Escape') {
      const s = this.lab.state
      if (s.kind === 'rotating') {
        // Cancelled gesture: put the live body back, nothing reaches the document.
        const pose = this.lab.poseOf(s.bodyId)
        this.lab.engine.world?.setTransform(s.bodyId, pose.x, pose.y, s.origAngle)
        this.lab.engine.syncBodies()
      }
      this.lab.state = { kind: 'idle' }
      this.lab.engine.persistentForces = []
      this.lab.engine.grab = null
    }
    if (
      e.key === 'Enter' &&
      this.lab.state.kind === 'creating' &&
      this.lab.state.tool === 'polygon'
    ) {
      const { start, current, points } = this.lab.state
      this.lab.state = { kind: 'idle' }
      this.commitCreate('polygon', start, current, points)
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (e.code === 'Space') {
      // A focused button (e.g. Play after a click) activates on Space keyup and would
      // toggle play/pause a second time.
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') e.preventDefault()
      this.lab.store?.setState({ spaceHeld: false })
    }
  }
}
