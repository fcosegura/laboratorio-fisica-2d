import {
  Application,
  Container,
  Graphics,
  Text,
  TextStyle,
} from 'pixi.js'
import type { Camera } from '../camera/coords.ts'
import { aabbFromBox, aabbFromCircle, aabbFromPoints, emptyAABB, includeAABB, type AABB } from '../core/math/aabb.ts'
import type { Vec2 } from '../core/math/vec2.ts'
import { FORCE_ACCEL_PER_METER, forceAnchorWorld, IMPULSE_VELOCITY_PER_METER } from '../interaction/force.ts'
import { getFluid, getSolid } from '../materials/catalog.ts'
import type { SceneBody, SceneDocument, VizLayers } from '../scene/document.ts'
import type { AppliedForce, SimulationEngine } from '../sim/engine.ts'
import type { InteractionState } from '../interaction/state.ts'
import { clipHalfPlane, polygonCentroid } from '../core/math/polygon.ts'
import { PHYSICS_DT } from '../core/constants.ts'

const BG = 0x0c121c
const GRID = 0x1a2436
const GRID_MAJOR = 0x243044
const SELECT = 0x3ee0c5
const FORCE = 0xffb020
const VEL = 0x7aa2ff
const GRAV = 0xe24b8d
const CONTACT = 0xff6b6b

function bodyColor(body: SceneBody): number {
  return body.color ?? getSolid(body.materialId).color
}

function drawShape(g: Graphics, body: SceneBody, color: number, alpha = 1): void {
  const s = body.shape
  g.clear()
  if (s.kind === 'circle') {
    g.circle(0, 0, s.radius).fill({ color, alpha })
    g.moveTo(0, 0).lineTo(s.radius, 0).stroke({ color: 0xffffff, alpha: 0.35, width: 0.04 })
  } else if (s.kind === 'box') {
    g.rect(-s.hx, -s.hy, s.hx * 2, s.hy * 2).fill({ color, alpha })
  } else if (s.kind === 'capsule') {
    g.roundRect(-s.radius, -s.halfHeight - s.radius, s.radius * 2, (s.halfHeight + s.radius) * 2, s.radius).fill({
      color,
      alpha,
    })
  } else if (s.kind === 'convex') {
    const pts = s.vertices.flatMap((p) => [p.x, p.y])
    if (pts.length >= 6) g.poly(pts).fill({ color, alpha })
  } else if (s.kind === 'segment') {
    g.moveTo(s.a.x, s.a.y).lineTo(s.b.x, s.b.y).stroke({ color, width: 0.08, alpha })
  }
  g.stroke({ color: 0x000000, alpha: 0.35, width: 0.03 })
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
  private labelStyle = new TextStyle({
    fill: '#e8eef7',
    fontSize: 12,
    fontFamily: 'ui-sans-serif, system-ui, sans-serif',
  })
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
      if (b.shape.kind === 'circle') includeAABB(box, aabbFromCircle(b.x, b.y, b.shape.radius))
      else if (b.shape.kind === 'box') includeAABB(box, aabbFromBox({ x: b.x, y: b.y, angle: b.angle }, b.shape.hx, b.shape.hy))
      else if (b.shape.kind === 'convex') includeAABB(box, aabbFromPoints(b.shape.vertices.map((p) => ({ x: p.x + b.x, y: p.y + b.y }))))
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
    if (!app) return
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
    const halfW = this.view.width / (2 * cam.pixelsPerMeter)
    const halfH = this.view.height / (2 * cam.pixelsPerMeter)
    const minX = cam.x - halfW
    const maxX = cam.x + halfW
    const minY = cam.y - halfH
    const maxY = cam.y + halfH
    const step = cam.pixelsPerMeter > 40 ? 1 : cam.pixelsPerMeter > 16 ? 2 : 5
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
      // surface line
      const xs = clipped.filter((p) => Math.abs(p.y - surfaceY) < 1e-3)
      if (clipped.length) {
        g.poly(pts).stroke({ color: 0xffffff, alpha: 0.35, width: 0.04 })
      }
      void xs
      void polygonCentroid
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
        gfx.stroke({ color: SELECT, width: 0.06, alpha: 1 })
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

    this.drawGhost(g, engine, interaction)
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
  }

  private drawLabels(
    engine: SimulationEngine,
    cam: Camera,
    viz: VizLayers,
    interaction: InteractionState,
    measureLabel?: string,
  ): void {
    this.labels.removeChildren()
    const add = (text: string, world: Vec2, color = '#e8eef7') => {
      const t = new Text({ text, style: new TextStyle({ ...this.labelStyle, fill: color, fontSize: 12 }) })
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
