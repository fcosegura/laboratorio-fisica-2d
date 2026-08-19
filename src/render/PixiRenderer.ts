import {
  Application,
  Container,
  Graphics,
  Text,
  TextStyle,
} from 'pixi.js'
import type { Camera } from '../camera/coords.ts'
import { aabbFromPoints, aabbFromShape, emptyAABB, includeAABB, type AABB } from '../core/math/aabb.ts'
import type { Vec2 } from '../core/math/vec2.ts'
import { FORCE_ACCEL_PER_METER, forceAnchorWorld, IMPULSE_VELOCITY_PER_METER } from '../interaction/force.ts'
import { getFluid, getSolid } from '../materials/catalog.ts'
import type { SceneBody, SceneDocument, VizLayers } from '../scene/document.ts'
import { jointAnchorWorld } from '../scene/joints.ts'
import type { AppliedForce, SimulationEngine } from '../sim/engine.ts'
import type { InteractionState } from '../interaction/state.ts'
import { clipHalfPlane } from '../core/math/polygon.ts'
import { PHYSICS_DT } from '../core/constants.ts'

const BG = 0x0c121c
const GRID = 0x1a2436
const GRID_MAJOR = 0x243044
const SELECT = 0x3ee0c5
const FORCE = 0xffb020
const VEL = 0x7aa2ff
const GRAV = 0xe24b8d
const CONTACT = 0xff6b6b
const JOINT = 0xc4b5fd

function gridStep(ppm: number): number {
  if (ppm > 40) return 1
  if (ppm > 16) return 2
  return 5
}

function bodyColor(body: SceneBody): number {
  return body.color ?? getSolid(body.materialId).color
}

function drawShape(g: Graphics, body: SceneBody, color: number, alpha = 1): void {
  const s = body.shape
  g.clear()
  if (s.kind === 'circle') {
    g.circle(0, 0, s.radius).fill({ color, alpha }).stroke({ color: 0x000000, alpha: 0.35, width: 0.03 })
    g.moveTo(0, 0).lineTo(s.radius, 0).stroke({ color: 0xffffff, alpha: 0.35, width: 0.04 })
  } else if (s.kind === 'box') {
    g.rect(-s.hx, -s.hy, s.hx * 2, s.hy * 2).fill({ color, alpha }).stroke({ color: 0x000000, alpha: 0.35, width: 0.03 })
  } else if (s.kind === 'capsule') {
    g.roundRect(-s.radius, -s.halfHeight - s.radius, s.radius * 2, (s.halfHeight + s.radius) * 2, s.radius)
      .fill({ color, alpha })
      .stroke({ color: 0x000000, alpha: 0.35, width: 0.03 })
  } else if (s.kind === 'convex') {
    const pts = s.vertices.flatMap((p) => [p.x, p.y])
    if (pts.length >= 6) {
      g.poly(pts).fill({ color, alpha }).stroke({ color: 0x000000, alpha: 0.35, width: 0.03 })
    }
  } else if (s.kind === 'polyline') {
    const pts = s.vertices.flatMap((p) => [p.x, p.y])
    if (pts.length >= 4) {
      g.poly(pts).stroke({ color, width: 0.06, alpha })
    }
  } else if (s.kind === 'segment') {
    g.moveTo(s.a.x, s.a.y).lineTo(s.b.x, s.b.y).stroke({ color, width: 0.08, alpha })
  }
}

function drawSelectionHighlight(g: Graphics, body: SceneBody): void {
  const s = body.shape
  if (s.kind === 'circle') {
    g.circle(0, 0, s.radius).stroke({ color: SELECT, width: 0.06, alpha: 1 })
  } else if (s.kind === 'box') {
    g.rect(-s.hx, -s.hy, s.hx * 2, s.hy * 2).stroke({ color: SELECT, width: 0.06, alpha: 1 })
  } else if (s.kind === 'capsule') {
    g.roundRect(-s.radius, -s.halfHeight - s.radius, s.radius * 2, (s.halfHeight + s.radius) * 2, s.radius).stroke({
      color: SELECT,
      width: 0.06,
      alpha: 1,
    })
  } else if (s.kind === 'convex') {
    const pts = s.vertices.flatMap((p) => [p.x, p.y])
    if (pts.length >= 6) g.poly(pts).stroke({ color: SELECT, width: 0.06, alpha: 1 })
  } else if (s.kind === 'polyline') {
    const pts = s.vertices.flatMap((p) => [p.x, p.y])
    if (pts.length >= 4) g.poly(pts).stroke({ color: SELECT, width: 0.08, alpha: 1 })
  } else if (s.kind === 'segment') {
    g.moveTo(s.a.x, s.a.y).lineTo(s.b.x, s.b.y).stroke({ color: SELECT, width: 0.1, alpha: 1 })
  }
}

export class PixiRenderer {
  app: Application | null = null
  world = new Container()
  grid = new Graphics()
  fluids = new Graphics()
  bodiesLayer = new Container()
  overlay = new Graphics()
  labels = new Container()
  private bodyGfx = new Map<string, Graphics>()
  private labelStyles = new Map<string, TextStyle>()
  view = { width: 1, height: 1, dpr: 1 }
  lastDrawMs = 0

  async init(canvas: HTMLCanvasElement): Promise<void> {
    this.destroy()
    const app = new Application()
    await app.init({
      canvas,
      background: BG,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      preference: 'webgl',
    })
    this.app = app
    this.world = new Container()
    this.grid = new Graphics()
    this.fluids = new Graphics()
    this.bodiesLayer = new Container()
    this.overlay = new Graphics()
    this.labels = new Container()
    this.bodyGfx.clear()

    this.world.addChild(this.grid, this.fluids, this.bodiesLayer, this.overlay)
    app.stage.addChild(this.world)
    app.stage.addChild(this.labels)
    this.resize(canvas.clientWidth, canvas.clientHeight)
  }

  resize(width: number, height: number): void {
    if (!this.app) return
    const w = Math.max(1, Math.floor(width))
    const h = Math.max(1, Math.floor(height))
    this.view = { width: w, height: h, dpr: this.app.renderer.resolution }
    this.app.renderer.resize(w, h)
  }

  destroy(): void {
    this.app?.destroy({ removeView: false }, { children: true })
    this.app = null
    this.bodyGfx.clear()
  }

  sceneBounds(doc: SceneDocument): AABB {
    const box = emptyAABB()
    for (const b of doc.bodies) {
      includeAABB(box, aabbFromShape(b.shape, { x: b.x, y: b.y, angle: b.angle }))
    }
    for (const f of doc.fluidRegions) includeAABB(box, aabbFromPoints(f.polygon))
    return box
  }

  draw(
    engine: SimulationEngine,
    cam: Camera,
    viz: VizLayers,
    selected: string[],
    interaction: InteractionState,
    measureLabel?: string,
  ): void {
    const t0 = performance.now()
    const app = this.app
    if (!app || this.world.destroyed) return
    const { width, height } = this.view
    this.world.position.set(width / 2, height / 2)
    this.world.scale.set(cam.pixelsPerMeter, -cam.pixelsPerMeter)
    this.world.pivot.set(cam.x, cam.y)

    this.drawGrid(cam)
    this.drawFluids(engine)
    this.syncBodies(engine, selected)
    this.drawOverlay(engine, viz, interaction)
    this.drawLabels(engine, cam, viz, interaction, measureLabel)
    this.lastDrawMs = performance.now() - t0
  }

  private drawGrid(cam: Camera): void {
    const g = this.grid
    g.clear()
    const { width, height } = this.view
    const spanX = width / cam.pixelsPerMeter
    const spanY = height / cam.pixelsPerMeter
    const step = gridStep(cam.pixelsPerMeter)
    const minX = cam.x - spanX / 2 - step
    const maxX = cam.x + spanX / 2 + step
    const minY = cam.y - spanY / 2 - step
    const maxY = cam.y + spanY / 2 + step
    const x0 = Math.floor(minX / step) * step
    const y0 = Math.floor(minY / step) * step
    for (let x = x0; x <= maxX; x += step) {
      g.moveTo(x, minY).lineTo(x, maxY).stroke({ color: x === 0 ? GRID_MAJOR : GRID, width: x === 0 ? 0.03 : 0.015, pixelLine: true })
    }
    for (let y = y0; y <= maxY; y += step) {
      g.moveTo(minX, y).lineTo(maxX, y).stroke({ color: y === 0 ? GRID_MAJOR : GRID, width: y === 0 ? 0.03 : 0.015, pixelLine: true })
    }
  }

  private drawFluids(engine: SimulationEngine): void {
    const g = this.fluids
    g.clear()
    for (const region of engine.doc.fluidRegions) {
      const sample = engine.fluids.samples.find((s) => s.regionId === region.id)
      const surfaceY = sample?.surfaceY ?? region.restSurfaceY
      const mat = getFluid(region.materialId)
      const clipped = clipHalfPlane(region.polygon, 0, 1, surfaceY)
      if (clipped.length < 3) continue
      const pts = clipped.flatMap((p) => [p.x, p.y])
      g.poly(pts).fill({ color: mat.color, alpha: mat.opacity })
      if (clipped.length) {
        g.poly(pts).stroke({ color: 0xffffff, alpha: 0.35, width: 0.04 })
      }
    }
  }

  private syncBodies(engine: SimulationEngine, selected: string[]): void {
    const seen = new Set<string>()
    for (const body of engine.doc.bodies) {
      seen.add(body.id)
      let gfx = this.bodyGfx.get(body.id)
      if (!gfx) {
        gfx = new Graphics()
        this.bodyGfx.set(body.id, gfx)
        this.bodiesLayer.addChild(gfx)
      }
      const snap = engine.interpolated(body.id)
      drawShape(gfx, body, bodyColor(body), body.type === 'fixed' ? 0.85 : 1)
      if (selected.includes(body.id)) {
        drawSelectionHighlight(gfx, body)
      }
      if (snap) {
        gfx.position.set(snap.x, snap.y)
        gfx.rotation = snap.angle
      } else {
        gfx.position.set(body.x, body.y)
        gfx.rotation = body.angle
      }
    }
    for (const [id, gfx] of this.bodyGfx) {
      if (!seen.has(id)) {
        this.bodiesLayer.removeChild(gfx)
        gfx.destroy()
        this.bodyGfx.delete(id)
      }
    }
  }

  private arrow(g: Graphics, x: number, y: number, dx: number, dy: number, color: number, width = 0.04): void {
    const len = Math.hypot(dx, dy)
    if (len < 1e-4) return
    const ux = dx / len
    const uy = dy / len
    g.moveTo(x, y).lineTo(x + dx, y + dy).stroke({ color, width, cap: 'round' })
    const ah = Math.min(0.18, len * 0.3)
    g.moveTo(x + dx, y + dy)
      .lineTo(x + dx - ux * ah + -uy * ah * 0.4, y + dy - uy * ah + ux * ah * 0.4)
      .stroke({ color, width, cap: 'round' })
    g.moveTo(x + dx, y + dy)
      .lineTo(x + dx - ux * ah + uy * ah * 0.4, y + dy - uy * ah + -ux * ah * 0.4)
      .stroke({ color, width, cap: 'round' })
  }

  private drawOverlay(engine: SimulationEngine, viz: VizLayers, interaction: InteractionState): void {
    const g = this.overlay
    g.clear()
    const gy = engine.doc.world.gravity.y
    const gx = engine.doc.world.gravity.x

    for (const body of engine.doc.bodies) {
      const snap = engine.interpolated(body.id)
      if (!snap) continue
      if (viz.com) {
        g.circle(snap.x, snap.y, 0.06).fill({ color: 0xffffff, alpha: 0.9 })
      }
      if (viz.velocity) {
        this.arrow(g, snap.x, snap.y, snap.vx * 0.15, snap.vy * 0.15, VEL)
      }
      if (viz.gravity && body.type === 'dynamic' && body.gravityScale !== 0) {
        this.arrow(g, snap.x, snap.y, gx * 0.05 * body.gravityScale, gy * 0.05 * body.gravityScale, GRAV)
      }
    }

    if (viz.contacts) {
      for (const c of engine.contacts) {
        const Fn = c.impulseN / PHYSICS_DT
        const scale = 0.002
        g.circle(c.x, c.y, 0.05).fill({ color: CONTACT, alpha: 0.8 })
        this.arrow(g, c.x, c.y, c.nx * Fn * scale, c.ny * Fn * scale, CONTACT, 0.03)
      }
    }

    if (viz.colliders) {
      for (const body of engine.doc.bodies) {
        const snap = engine.interpolated(body.id)
        if (!snap) continue
        g.circle(snap.x, snap.y, 0.03).stroke({ color: 0xffff00, width: 0.02, alpha: 0.5 })
      }
    }

    if (viz.force) {
      for (const f of engine.appliedForces) {
        this.arrow(g, f.x, f.y, f.fx * 0.01, f.fy * 0.01, FORCE)
      }
      for (const f of engine.persistentForces) {
        this.arrow(g, f.x, f.y, f.fx * 0.02, f.fy * 0.02, FORCE)
      }
    }

    this.drawJoints(g, engine)
    this.drawGhost(g, engine, interaction)
  }

  private poseOf(engine: SimulationEngine, id: string) {
    return engine.interpolated(id) ?? engine.doc.bodies.find((b) => b.id === id) ?? null
  }

  private drawJoints(g: Graphics, engine: SimulationEngine): void {
    for (const joint of engine.doc.joints) {
      const poseA = this.poseOf(engine, joint.bodyA)
      const poseB = this.poseOf(engine, joint.bodyB)
      if (!poseA || !poseB) continue
      const a = jointAnchorWorld(joint.anchorA, poseA)
      const b = jointAnchorWorld(joint.anchorB, poseB)
      const kind = joint.kind === 'distance' ? 'rope' : joint.kind
      if (kind === 'spring') this.drawSpring(g, a, b)
      else if (kind === 'rope') this.drawDashed(g, a, b)
      else {
        g.moveTo(a.x, a.y)
          .lineTo(b.x, b.y)
          .stroke({ color: JOINT, width: kind === 'fixed' ? 0.07 : 0.04, alpha: 0.9, cap: 'round' })
      }
      if (kind === 'revolute') {
        g.circle(a.x, a.y, 0.07).stroke({ color: JOINT, width: 0.03 })
        g.circle(a.x, a.y, 0.03).fill({ color: JOINT, alpha: 0.9 })
      } else {
        g.circle(a.x, a.y, 0.045).fill({ color: JOINT, alpha: 0.95 })
        g.circle(b.x, b.y, 0.045).fill({ color: JOINT, alpha: 0.95 })
      }
    }
  }

  private drawSpring(g: Graphics, a: Vec2, b: Vec2): void {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    const ux = dx / len
    const uy = dy / len
    const px = -uy
    const py = ux
    const coils = 8
    const amp = 0.08
    g.moveTo(a.x, a.y)
    for (let i = 1; i <= coils; i++) {
      const t = i / (coils + 1)
      const side = i % 2 === 0 ? 1 : -1
      g.lineTo(a.x + ux * len * t + px * amp * side, a.y + uy * len * t + py * amp * side)
    }
    g.lineTo(b.x, b.y).stroke({ color: JOINT, width: 0.04, cap: 'round', join: 'round' })
  }

  private drawDashed(g: Graphics, a: Vec2, b: Vec2): void {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy)
    if (len < 1e-6) return
    const ux = dx / len
    const uy = dy / len
    const dash = 0.12
    const gap = 0.07
    let d = 0
    let draw = true
    while (d < len) {
      const seg = Math.min(draw ? dash : gap, len - d)
      const x0 = a.x + ux * d
      const y0 = a.y + uy * d
      d += seg
      if (draw) g.moveTo(x0, y0).lineTo(a.x + ux * d, a.y + uy * d)
      draw = !draw
    }
    g.stroke({ color: JOINT, width: 0.04, cap: 'round' })
  }

  private drawGhost(g: Graphics, engine: SimulationEngine, interaction: InteractionState): void {
    if (interaction.kind === 'creating') {
      const a = interaction.start
      const b = interaction.current
      g.setStrokeStyle({ color: SELECT, width: 0.05, alpha: 0.9 })
      if (interaction.tool === 'circle') {
        const r = Math.max(0.05, Math.hypot(b.x - a.x, b.y - a.y))
        g.circle(a.x, a.y, r).stroke()
      } else if (interaction.tool === 'rect' || interaction.tool === 'fluid') {
        const minX = Math.min(a.x, b.x)
        const minY = Math.min(a.y, b.y)
        const w = Math.abs(b.x - a.x)
        const h = Math.abs(b.y - a.y)
        g.rect(minX, minY, w, h).stroke()
        if (interaction.tool === 'fluid') g.rect(minX, minY, w, h).fill({ color: 0x3aa0d8, alpha: 0.25 })
      } else if (interaction.tool === 'line') {
        g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke()
      } else if (interaction.tool === 'polygon' && interaction.points) {
        const pts = [...interaction.points, b]
        if (pts.length >= 2) {
          g.moveTo(pts[0]!.x, pts[0]!.y)
          for (let i = 1; i < pts.length; i++) g.lineTo(pts[i]!.x, pts[i]!.y)
          g.stroke()
        }
        for (const p of pts) g.circle(p.x, p.y, 0.06).fill({ color: SELECT })
      }
    }
    if (interaction.kind === 'applyingForce') {
      const origin = this.forceOrigin(engine, interaction)
      this.arrow(
        g,
        origin.x,
        origin.y,
        interaction.current.x - origin.x,
        interaction.current.y - origin.y,
        FORCE,
        0.06,
      )
    }
    if (interaction.kind === 'measuring') {
      g.moveTo(interaction.start.x, interaction.start.y)
        .lineTo(interaction.current.x, interaction.current.y)
        .stroke({ color: 0xffffff, width: 0.04 })
      g.circle(interaction.start.x, interaction.start.y, 0.05).fill({ color: 0xffffff })
      g.circle(interaction.current.x, interaction.current.y, 0.05).fill({ color: 0xffffff })
    }
    if (interaction.kind === 'selecting') {
      const minX = Math.min(interaction.start.x, interaction.current.x)
      const minY = Math.min(interaction.start.y, interaction.current.y)
      g.rect(minX, minY, Math.abs(interaction.current.x - interaction.start.x), Math.abs(interaction.current.y - interaction.start.y))
        .fill({ color: SELECT, alpha: 0.08 })
        .stroke({ color: SELECT, width: 0.03, alpha: 0.8 })
    }
    if (interaction.kind === 'joining') {
      const pose = this.poseOf(engine, interaction.bodyA)
      const origin = pose ? jointAnchorWorld(interaction.anchorA, pose) : interaction.current
      g.moveTo(origin.x, origin.y)
        .lineTo(interaction.current.x, interaction.current.y)
        .stroke({ color: JOINT, width: 0.05, alpha: 0.9 })
      g.circle(origin.x, origin.y, 0.06).fill({ color: JOINT })
      g.circle(interaction.current.x, interaction.current.y, 0.05).fill({ color: JOINT, alpha: 0.7 })
    }
  }

  private getTextStyle(color = '#e8eef7'): TextStyle {
    let s = this.labelStyles.get(color)
    if (!s) {
      s = new TextStyle({
        fill: color,
        fontSize: 12,
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      })
      this.labelStyles.set(color, s)
    }
    return s
  }

  private drawLabels(
    engine: SimulationEngine,
    cam: Camera,
    viz: VizLayers,
    interaction: InteractionState,
    measureLabel?: string,
  ): void {
    const removed = this.labels.removeChildren()
    for (const child of removed) {
      child.destroy({ texture: true, context: true })
    }
    const add = (text: string, world: Vec2, color = '#e8eef7') => {
      const t = new Text({ text, style: this.getTextStyle(color) })
      t.position.set(
        (world.x - cam.x) * cam.pixelsPerMeter + this.view.width / 2 + 8,
        -(world.y - cam.y) * cam.pixelsPerMeter + this.view.height / 2 - 8,
      )
      t.scale.set(1)
      this.labels.addChild(t)
    }
    if (interaction.kind === 'applyingForce') {
      const origin = this.forceOrigin(engine, interaction)
      const dx = interaction.current.x - origin.x
      const dy = interaction.current.y - origin.y
      const mag = Math.hypot(dx, dy)
      const mass = engine.world?.getBody(interaction.bodyId)?.mass ?? 1
      const scale = interaction.mode === 'impulse' ? mass * IMPULSE_VELOCITY_PER_METER : mass * FORCE_ACCEL_PER_METER
      const unit = interaction.mode === 'impulse' ? 'N·s' : 'N'
      add(`${(mag * scale).toFixed(1)} ${unit}`, interaction.current, '#ffb020')
    }
    if (interaction.kind === 'measuring' || measureLabel) {
      const mid = {
        x: (interaction.kind === 'measuring' ? (interaction.start.x + interaction.current.x) / 2 : 0),
        y: (interaction.kind === 'measuring' ? (interaction.start.y + interaction.current.y) / 2 : 0),
      }
      if (interaction.kind === 'measuring') {
        const d = Math.hypot(interaction.current.x - interaction.start.x, interaction.current.y - interaction.start.y)
        add(`${d.toFixed(2)} m`, mid)
      }
    }
    if (viz.velocity) {
      for (const b of engine.curr) {
        const speed = Math.hypot(b.vx, b.vy)
        if (speed > 0.15) add(`${speed.toFixed(1)} m/s`, { x: b.x, y: b.y + 0.2 }, '#7aa2ff')
      }
    }
  }

  private forceOrigin(engine: SimulationEngine, interaction: Extract<InteractionState, { kind: 'applyingForce' }>): Vec2 {
    if (!interaction.local) return interaction.current
    const snap = engine.interpolated(interaction.bodyId)
    const body = engine.doc.bodies.find((b) => b.id === interaction.bodyId)
    const pose = snap ?? body
    if (!pose) return interaction.current
    return forceAnchorWorld(interaction.local, pose)
  }
}

export type { AppliedForce }
