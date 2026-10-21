import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js'
import type { Camera } from '../camera/coords.ts'
import {
  aabbFromPoints,
  aabbFromShape,
  emptyAABB,
  includeAABB,
  type AABB,
} from '../core/math/aabb.ts'
import type { Vec2 } from '../core/math/vec2.ts'
import {
  FORCE_ACCEL_PER_METER,
  forceAnchorWorld,
  IMPULSE_VELOCITY_PER_METER,
} from '../interaction/force.ts'
import { getFluid, getSolid } from '../materials/catalog.ts'
import type { SceneBody, SceneDocument, SceneFan, VizLayers } from '../scene/document.ts'
import { jointAnchorWorld } from '../scene/joints.ts'
import type { AppliedForce, SimulationEngine } from '../sim/engine.ts'
import { fanProfile, fanPulse, thrusterWorld, windAt } from '../sim/forces.ts'
import {
  aimFromDrag,
  DEFAULT_FAN_RANGE,
  DEFAULT_FAN_WIDTH,
  fanEditPatch,
  fanTip,
} from '../interaction/fan.ts'
import type { InteractionState } from '../interaction/state.ts'
import {
  moveVertex,
  scaleFactor,
  scaleShape,
  vertexHandleRadius,
  type HandleLayout,
} from '../interaction/handles.ts'
import {
  capsuleToPolygon,
  clipHalfPlane,
  isConvex,
  removeDuplicateVertices,
} from '../core/math/polygon.ts'
import { decomposePolygon } from '../core/math/decompose.ts'
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
const COLLIDER = 0xffe14d
const THRUST = 0xff8a3d
const WIND = 0xcfe3ff
/** Force-layer arrows: 1 N → 1 cm, capped so a heavy body's force stays on screen. */
const FORCE_ARROW_MAX = 3
/** Wind streaks: about one per cell of this side (m), coarsened when zoomed out. */
const WIND_CELL = 2.5
const WIND_MAX_STREAKS = 260

/** Deterministic hash in [0, 1) for integer cell coordinates and a salt. */
function hash01(i: number, j: number, salt: number): number {
  const h = Math.sin(i * 127.1 + j * 311.7 + salt * 74.7) * 43758.5453
  return h - Math.floor(h)
}

function gridStep(ppm: number): number {
  if (ppm > 40) return 1
  if (ppm > 16) return 2
  return 5
}

function bodyColor(body: SceneBody): number {
  return body.color ?? getSolid(body.materialId).color
}

function lightenColor(color: number, t: number): number {
  const r = (color >> 16) & 255
  const g = (color >> 8) & 255
  const b = color & 255
  const lr = Math.round(r + (255 - r) * t)
  const lg = Math.round(g + (255 - g) * t)
  const lb = Math.round(b + (255 - b) * t)
  return (lr << 16) | (lg << 8) | lb
}

function drawShape(g: Graphics, body: SceneBody, color: number, alpha = 1): void {
  const s = body.shape
  g.clear()
  if (s.kind === 'circle') {
    g.circle(0, 0, s.radius)
      .fill({ color, alpha })
      .stroke({ color: 0x000000, alpha: 0.35, width: 0.03 })
    g.moveTo(0, 0).lineTo(s.radius, 0).stroke({ color: 0xffffff, alpha: 0.35, width: 0.04 })
  } else if (s.kind === 'box') {
    g.rect(-s.hx, -s.hy, s.hx * 2, s.hy * 2)
      .fill({ color, alpha })
      .stroke({ color: 0x000000, alpha: 0.35, width: 0.03 })
  } else if (s.kind === 'capsule') {
    g.roundRect(
      -s.radius,
      -s.halfHeight - s.radius,
      s.radius * 2,
      (s.halfHeight + s.radius) * 2,
      s.radius,
    )
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
    g.roundRect(
      -s.radius,
      -s.halfHeight - s.radius,
      s.radius * 2,
      (s.halfHeight + s.radius) * 2,
      s.radius,
    ).stroke({
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

/**
 * Collider outlines as the physics engine sees them: concave polygons split into the same
 * convex pieces Rapier builds (`decomposePolygon`), each piece outlined separately.
 */
function drawColliders(
  g: Graphics,
  shape: SceneBody['shape'],
  x: number,
  y: number,
  angle: number,
  color = COLLIDER,
  width = 0.025,
): void {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const toWorld = (p: Vec2) => [x + p.x * c - p.y * s, y + p.x * s + p.y * c]
  const style = { color, width, alpha: 0.85 }
  if (shape.kind === 'circle') {
    g.circle(x, y, shape.radius).stroke(style)
    g.moveTo(x, y)
      .lineTo(x + shape.radius * c, y + shape.radius * s)
      .stroke(style)
  } else if (shape.kind === 'box') {
    const { hx, hy } = shape
    const corners = [
      { x: -hx, y: -hy },
      { x: hx, y: -hy },
      { x: hx, y: hy },
      { x: -hx, y: hy },
    ]
    g.poly(corners.flatMap(toWorld)).stroke(style)
  } else if (shape.kind === 'capsule') {
    const outline = capsuleToPolygon(x, y, shape.halfHeight, shape.radius, angle, 12)
    g.poly(outline.flatMap((p) => [p.x, p.y])).stroke(style)
  } else if (shape.kind === 'convex') {
    const verts = removeDuplicateVertices(shape.vertices)
    if (verts.length < 3) return
    const parts = isConvex(verts) ? [verts] : decomposePolygon(verts)
    for (const part of parts) g.poly(part.flatMap(toWorld)).stroke(style)
  } else if (shape.kind === 'polyline') {
    const pts = shape.vertices.flatMap(toWorld)
    if (pts.length >= 4) g.poly(pts, false).stroke(style)
  } else if (shape.kind === 'segment') {
    const [ax, ay] = toWorld(shape.a)
    const [bx, by] = toWorld(shape.b)
    g.moveTo(ax!, ay!).lineTo(bx!, by!).stroke(style)
  }
}

export class PixiRenderer {
  app: Application | null = null
  world = new Container()
  grid = new Graphics()
  air = new Graphics()
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
    this.air = new Graphics()
    this.fluids = new Graphics()
    this.bodiesLayer = new Container()
    this.overlay = new Graphics()
    this.labels = new Container()
    this.bodyGfx.clear()

    this.world.addChild(this.grid, this.air, this.fluids, this.bodiesLayer, this.overlay)
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
    for (const v of doc.fluidVolumes) includeAABB(box, aabbFromPoints(v.polygon))
    for (const f of doc.fans ?? []) includeAABB(box, aabbFromPoints([f, fanTip(f)]))
    return box
  }

  draw(
    engine: SimulationEngine,
    cam: Camera,
    viz: VizLayers,
    selected: string[],
    interaction: InteractionState,
    handles: HandleLayout | null = null,
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
    this.drawWind(engine, cam)
    this.drawFluids(engine, selected)
    this.syncBodies(engine, selected)
    this.drawOverlay(engine, viz, interaction, selected)
    if (handles) this.drawHandles(handles, engine, interaction)
    this.drawFluidVertices(engine, selected, interaction, cam.pixelsPerMeter)
    this.drawLabels(engine, cam, viz, interaction, measureLabel)
    this.lastDrawMs = performance.now() - t0
  }

  /** Vertex handles of the selected tank, and the outline being edited. */
  private drawFluidVertices(
    engine: SimulationEngine,
    selected: string[],
    interaction: InteractionState,
    pixelsPerMeter: number,
  ): void {
    const g = this.overlay
    const r = vertexHandleRadius(pixelsPerMeter)
    for (const region of engine.doc.fluidRegions) {
      if (!selected.includes(region.id)) continue
      const editing = interaction.kind === 'editingVertex' && interaction.regionId === region.id
      const poly = editing
        ? moveVertex(region.polygon, interaction.index, interaction.current)
        : region.polygon
      if (editing) {
        g.poly(poly.flatMap((p) => [p.x, p.y])).stroke({ color: SELECT, width: r * 0.4 })
      }
      for (const p of poly) {
        g.circle(p.x, p.y, r)
          .fill({ color: BG, alpha: 0.9 })
          .stroke({ color: SELECT, width: r * 0.35 })
      }
    }
  }

  /** Rotate (circle on a stem) and scale (square) handles, plus the live scale preview. */
  private drawHandles(
    h: HandleLayout,
    engine: SimulationEngine,
    interaction: InteractionState,
  ): void {
    const g = this.overlay
    const w = h.radius * 0.35
    g.moveTo(h.center.x, h.center.y)
      .lineTo(h.rotate.x, h.rotate.y)
      .stroke({ color: SELECT, width: w, alpha: 0.5 })
    g.circle(h.rotate.x, h.rotate.y, h.radius)
      .fill({ color: BG, alpha: 0.9 })
      .stroke({ color: SELECT, width: w })
    g.rect(h.scale.x - h.radius, h.scale.y - h.radius, h.radius * 2, h.radius * 2)
      .fill({ color: BG, alpha: 0.9 })
      .stroke({ color: SELECT, width: w })

    if (interaction.kind === 'scaling' && interaction.bodyId === h.bodyId) {
      const body = engine.doc.bodies.find((b) => b.id === h.bodyId)
      const pose = engine.interpolated(h.bodyId) ?? body
      if (body && pose) {
        const k = scaleFactor(
          body.shape,
          interaction.center,
          interaction.start,
          interaction.current,
        )
        drawColliders(g, scaleShape(body.shape, k), pose.x, pose.y, pose.angle, SELECT, w * 1.5)
      }
    }
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
      g.moveTo(x, minY)
        .lineTo(x, maxY)
        .stroke({
          color: x === 0 ? GRID_MAJOR : GRID,
          width: x === 0 ? 0.03 : 0.015,
          pixelLine: true,
        })
    }
    for (let y = y0; y <= maxY; y += step) {
      g.moveTo(minX, y)
        .lineTo(maxX, y)
        .stroke({
          color: y === 0 ? GRID_MAJOR : GRID,
          width: y === 0 ? 0.03 : 0.015,
          pixelLine: true,
        })
    }
  }

  /**
   * Wind streaks anchored to world cells: each one drifts one cell with the mean wind and
   * fades in and out, so panning and zooming do not make them jump. Frozen while paused
   * (driven by sim time); length follows the local gusty speed.
   */
  private drawWind(engine: SimulationEngine, cam: Camera): void {
    const g = this.air
    g.clear()
    const wind = engine.doc.world.wind
    if (!wind) return
    const speed = wind.speed
    if (speed < 0.05) return
    const ux = Math.cos(wind.direction)
    const uy = Math.sin(wind.direction)
    const { width, height } = this.view
    const spanX = width / cam.pixelsPerMeter
    const spanY = height / cam.pixelsPerMeter
    let cell = WIND_CELL
    while ((spanX / cell + 2) * (spanY / cell + 2) > WIND_MAX_STREAKS) cell *= 2
    const t = engine.clock.simTime
    const life = cell / speed
    const i0 = Math.floor((cam.x - spanX / 2) / cell) - 1
    const i1 = Math.ceil((cam.x + spanX / 2) / cell)
    const j0 = Math.floor((cam.y - spanY / 2) / cell) - 1
    const j1 = Math.ceil((cam.y + spanY / 2) / cell)
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const phase = (t / life + hash01(i, j, 3)) % 1
        const d = phase * cell
        const x = (i + hash01(i, j, 1)) * cell + ux * d - ux * cell * 0.5
        const y = (j + hash01(i, j, 2)) * cell + uy * d - uy * cell * 0.5
        const w = windAt(wind, t, x, y)
        const len = Math.min(1.2, Math.max(0.15, Math.hypot(w.x, w.y) * 0.05))
        const alpha = 0.32 * Math.sin(Math.PI * phase)
        g.moveTo(x - ux * len, y - uy * len)
          .lineTo(x, y)
          .stroke({ color: WIND, width: 0.025, alpha, cap: 'round' })
      }
    }
  }

  private drawFluids(engine: SimulationEngine, selected: string[]): void {
    const g = this.fluids
    g.clear()
    for (const region of engine.doc.fluidRegions) {
      const sample = engine.fluids.samples.find((s) => s.regionId === region.id)
      const surfaceY = sample?.surfaceY ?? region.restSurfaceY
      const mat = getFluid(region.materialId)
      const clipped = clipHalfPlane(
        region.polygon,
        sample?.clipNx ?? 0,
        sample?.clipNy ?? 1,
        sample?.clipD ?? surfaceY,
      )
      if (clipped.length < 3) continue
      const pts = clipped.flatMap((p) => [p.x, p.y])
      g.poly(pts).fill({ color: mat.color, alpha: mat.opacity })
      const selectedRegion = selected.includes(region.id)
      g.poly(pts).stroke({
        color: 0xffffff,
        alpha: selectedRegion ? 0.95 : 0.35,
        width: selectedRegion ? 0.08 : 0.04,
      })
    }

    // PBF particles. Draw radius is larger than collision so discs overlap
    // into a puddle; concentric falloff avoids a gravel look.
    const drawR = engine.particles.particleDrawRadius
    for (const p of engine.particles.particles) {
      const foam = p.density < 0.75 || Math.hypot(p.vx, p.vy) > 1.2
      const color = foam ? lightenColor(p.color, 0.4) : p.color
      const alpha = foam ? Math.min(0.5, p.opacity + 0.05) : Math.min(0.85, p.opacity + 0.2)
      g.circle(p.x, p.y, drawR).fill({ color, alpha: alpha * 0.28 })
      g.circle(p.x, p.y, drawR * 0.62).fill({ color, alpha: alpha * 0.5 })
      g.circle(p.x, p.y, drawR * 0.32).fill({ color, alpha })
    }

    // Seed outlines when volumes exist but particles have not been built yet.
    if (engine.particles.particleCount === 0) {
      for (const vol of engine.doc.fluidVolumes) {
        const mat = getFluid(vol.materialId)
        const pts = vol.polygon.flatMap((p) => [p.x, p.y])
        if (pts.length >= 6) {
          g.poly(pts).stroke({ color: mat.color, alpha: 0.45, width: 0.03 })
        }
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

  private arrow(
    g: Graphics,
    x: number,
    y: number,
    dx: number,
    dy: number,
    color: number,
    width = 0.04,
  ): void {
    const len = Math.hypot(dx, dy)
    if (len < 1e-4) return
    const ux = dx / len
    const uy = dy / len
    g.moveTo(x, y)
      .lineTo(x + dx, y + dy)
      .stroke({ color, width, cap: 'round' })
    const ah = Math.min(0.18, len * 0.3)
    g.moveTo(x + dx, y + dy)
      .lineTo(x + dx - ux * ah + -uy * ah * 0.4, y + dy - uy * ah + ux * ah * 0.4)
      .stroke({ color, width, cap: 'round' })
    g.moveTo(x + dx, y + dy)
      .lineTo(x + dx - ux * ah + uy * ah * 0.4, y + dy - uy * ah + -ux * ah * 0.4)
      .stroke({ color, width, cap: 'round' })
  }

  private drawOverlay(
    engine: SimulationEngine,
    viz: VizLayers,
    interaction: InteractionState,
    selected: string[],
  ): void {
    const g = this.overlay
    g.clear()
    const gy = engine.doc.world.gravity.y
    const gx = engine.doc.world.gravity.x

    if (viz.trajectories) {
      for (const [id, trail] of engine.trails) {
        if (trail.length < 4) continue
        const body = engine.doc.bodies.find((b) => b.id === id)
        if (!body) continue
        g.moveTo(trail[0]!, trail[1]!)
        for (let i = 2; i < trail.length; i += 2) g.lineTo(trail[i]!, trail[i + 1]!)
        g.stroke({ color: lightenColor(bodyColor(body), 0.35), width: 0.03, alpha: 0.7 })
      }
    }

    // COM, velocity and gravity live at the centre of mass (vx/vy are COM velocities);
    // the body origin differs from it for asymmetric shapes.
    for (const body of engine.doc.bodies) {
      const snap = engine.interpolated(body.id)
      if (!snap) continue
      if (viz.com) {
        g.circle(snap.comX, snap.comY, 0.06).fill({ color: 0xffffff, alpha: 0.9 })
      }
      if (viz.velocity) {
        this.arrow(g, snap.comX, snap.comY, snap.vx * 0.15, snap.vy * 0.15, VEL)
      }
      if (viz.gravity && body.type === 'dynamic' && body.gravityScale !== 0) {
        this.arrow(
          g,
          snap.comX,
          snap.comY,
          gx * 0.05 * body.gravityScale,
          gy * 0.05 * body.gravityScale,
          GRAV,
        )
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
        const pose = engine.interpolated(body.id) ?? body
        drawColliders(g, body.shape, pose.x, pose.y, pose.angle)
      }
    }

    if (viz.force) {
      for (const f of engine.appliedForces) {
        this.cappedArrow(g, f.x, f.y, f.fx * 0.01, f.fy * 0.01, FORCE)
      }
      for (const f of engine.persistentForces) {
        this.cappedArrow(g, f.x, f.y, f.fx * 0.02, f.fy * 0.02, FORCE)
      }
    }

    this.drawThrusters(g, engine)
    this.drawFans(g, engine, selected, interaction)

    this.drawJoints(g, engine)
    this.drawGhost(g, engine, interaction)
  }

  private cappedArrow(g: Graphics, x: number, y: number, dx: number, dy: number, color: number) {
    const len = Math.hypot(dx, dy)
    const k = len > FORCE_ARROW_MAX ? FORCE_ARROW_MAX / len : 1
    this.arrow(g, x, y, dx * k, dy * k, color)
  }

  /**
   * Nozzle at the anchor, arrow along the force (length grows with F / m·g, saturating) and,
   * while playing, a flickering exhaust flame on the opposite side.
   */
  private drawThrusters(g: Graphics, engine: SimulationEngine): void {
    const playing = engine.clock.playing
    for (const body of engine.doc.bodies) {
      const thruster = body.thruster
      if (!thruster) continue
      const pose = this.poseOf(engine, body.id)
      if (!pose) continue
      const f = thrusterWorld(thruster, pose)
      const mag = Math.hypot(f.fx, f.fy)
      const ux = mag > 0 ? f.fx / mag : Math.cos(thruster.angle)
      const uy = mag > 0 ? f.fy / mag : Math.sin(thruster.angle)
      const mass = engine.curr.find((b) => b.id === body.id)?.mass ?? 0
      const ratio = mass > 0 ? mag / (mass * 9.81) : 1
      const len = 0.3 + 1.1 * Math.tanh(ratio)
      const active = playing && body.type === 'dynamic' && mag > 0
      if (active) {
        const flicker = 0.75 + 0.25 * Math.sin(engine.clock.simTime * 40 + f.x * 13)
        const fl = len * 0.7 * flicker
        const px = -uy * 0.09
        const py = ux * 0.09
        g.poly([f.x + px, f.y + py, f.x - ux * fl, f.y - uy * fl, f.x - px, f.y - py]).fill({
          color: 0xffd166,
          alpha: 0.85,
        })
        g.poly([
          f.x + px * 0.5,
          f.y + py * 0.5,
          f.x - ux * fl * 0.55,
          f.y - uy * fl * 0.55,
          f.x - px * 0.5,
          f.y - py * 0.5,
        ]).fill({ color: 0xffffff, alpha: 0.8 })
      }
      this.arrow(g, f.x, f.y, ux * len, uy * len, THRUST, 0.05)
      g.circle(f.x, f.y, 0.07)
        .fill({ color: BG, alpha: 0.9 })
        .stroke({ color: THRUST, width: 0.03 })
    }
  }

  /** Jet rectangle of a fan: nozzle edge, then the far edge. */
  private jetOutline(fan: Pick<SceneFan, 'x' | 'y' | 'angle' | 'width' | 'range'>): number[] {
    const jx = Math.cos(fan.angle)
    const jy = Math.sin(fan.angle)
    const nx = -jy * (fan.width / 2)
    const ny = jx * (fan.width / 2)
    const tx = fan.x + jx * fan.range
    const ty = fan.y + jy * fan.range
    return [fan.x + nx, fan.y + ny, tx + nx, ty + ny, tx - nx, ty - ny, fan.x - nx, fan.y - ny]
  }

  /**
   * Fans: faint jet outline, streaks drifting down the jet (length and opacity follow the
   * local, pulsed speed; frozen while paused), and a housing whose blades spin with the
   * speed. A move / aim gesture previews the edited fan.
   */
  private drawFans(
    g: Graphics,
    engine: SimulationEngine,
    selected: string[],
    interaction: InteractionState,
  ): void {
    const fans = engine.doc.fans ?? []
    const t = engine.clock.simTime
    for (let i = 0; i < fans.length; i++) {
      let fan = fans[i]!
      if (interaction.kind === 'editingFan' && interaction.fanId === fan.id) {
        fan = {
          ...fan,
          ...fanEditPatch(fan, interaction.grab, interaction.offset, interaction.current),
        }
      }
      const isSel = selected.includes(fan.id)
      const jx = Math.cos(fan.angle)
      const jy = Math.sin(fan.angle)
      const nx = -jy
      const ny = jx
      const speed = fan.speed * fanPulse(fan, t)

      g.poly(this.jetOutline(fan)).stroke({
        color: isSel ? SELECT : WIND,
        width: isSel ? 0.035 : 0.02,
        alpha: isSel ? 0.7 : 0.18,
      })

      const count = Math.min(60, Math.max(6, Math.round(fan.width * fan.range * 2)))
      for (let k = 0; k < count; k++) {
        const across = (hash01(k, i, 1) - 0.5) * fan.width * 0.9
        const phase = ((t * Math.max(fan.speed, 0.5) * 0.5) / fan.range + hash01(k, i, 2)) % 1
        const s = phase * fan.range
        const local = speed * fanProfile(fan, s, across)
        if (local < 0.05) continue
        const len = Math.min(0.8, 0.08 + local * 0.06)
        const x = fan.x + jx * s + nx * across
        const y = fan.y + jy * s + ny * across
        g.moveTo(x - jx * len, y - jy * len)
          .lineTo(x, y)
          .stroke({
            color: WIND,
            width: 0.025,
            alpha: 0.45 * Math.sin(Math.PI * phase) * Math.min(1, local / 4 + 0.25),
            cap: 'round',
          })
      }

      // Housing behind the nozzle, blades seen side-on (a spinning line across).
      const half = Math.min(fan.width / 2, 0.45) + 0.05
      const depth = 0.3
      const at = (a: number, b: number) => [fan.x + jx * a + nx * b, fan.y + jy * a + ny * b]
      g.poly([...at(0, half), ...at(-depth, half), ...at(-depth, -half), ...at(0, -half)])
        .fill({ color: 0x2a3444, alpha: 0.95 })
        .stroke({ color: isSel ? SELECT : 0x9fb3c8, width: 0.03 })
      const spin = engine.clock.playing ? t * (2 + fan.speed * fanPulse(fan, t) * 2) : 0.6
      for (const p of [spin, spin + Math.PI / 2]) {
        const r = (half - 0.06) * Math.cos(p)
        const [ax, ay] = at(-depth / 2, r)
        const [bx, by] = at(-depth / 2, -r)
        g.moveTo(ax!, ay!).lineTo(bx!, by!).stroke({ color: 0xcfe3ff, width: 0.04, cap: 'round' })
      }
      const [hx, hy] = at(-depth / 2, 0)
      g.circle(hx!, hy!, 0.05).fill({ color: 0xcfe3ff })

      if (isSel && interaction.kind !== 'editingFan') {
        const tip = fanTip(fan)
        g.circle(tip.x, tip.y, 0.09)
          .fill({ color: BG, alpha: 0.9 })
          .stroke({ color: SELECT, width: 0.035 })
      }
    }
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
      } else if (
        interaction.tool === 'rect' ||
        interaction.tool === 'fluid' ||
        interaction.tool === 'spill'
      ) {
        const minX = Math.min(a.x, b.x)
        const minY = Math.min(a.y, b.y)
        const w = Math.abs(b.x - a.x)
        const h = Math.abs(b.y - a.y)
        g.rect(minX, minY, w, h).stroke()
        if (interaction.tool === 'fluid')
          g.rect(minX, minY, w, h).fill({ color: 0x3aa0d8, alpha: 0.25 })
        if (interaction.tool === 'spill')
          g.rect(minX, minY, w, h).fill({ color: 0x2dd4bf, alpha: 0.3 })
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
    if (interaction.kind === 'creating' && interaction.tool === 'fan') {
      const a = interaction.start
      const b = interaction.current
      const aim =
        Math.hypot(b.x - a.x, b.y - a.y) < 0.15
          ? { angle: 0, range: DEFAULT_FAN_RANGE }
          : aimFromDrag(a, b)
      const preview = { x: a.x, y: a.y, width: DEFAULT_FAN_WIDTH, ...aim }
      g.poly(this.jetOutline(preview)).stroke({ color: WIND, width: 0.035, alpha: 0.8 })
      g.circle(a.x, a.y, 0.08).fill({ color: WIND })
    }
    if (interaction.kind === 'placingThruster') {
      const pose = this.poseOf(engine, interaction.bodyId)
      const origin = pose ? forceAnchorWorld(interaction.local, pose) : interaction.current
      this.arrow(
        g,
        origin.x,
        origin.y,
        interaction.current.x - origin.x,
        interaction.current.y - origin.y,
        THRUST,
        0.06,
      )
      g.circle(origin.x, origin.y, 0.07).stroke({ color: THRUST, width: 0.03 })
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
      g.rect(
        minX,
        minY,
        Math.abs(interaction.current.x - interaction.start.x),
        Math.abs(interaction.current.y - interaction.start.y),
      )
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
      g.circle(interaction.current.x, interaction.current.y, 0.05).fill({
        color: JOINT,
        alpha: 0.7,
      })
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
      const scale =
        interaction.mode === 'impulse'
          ? mass * IMPULSE_VELOCITY_PER_METER
          : mass * FORCE_ACCEL_PER_METER
      const unit = interaction.mode === 'impulse' ? 'N·s' : 'N'
      add(`${(mag * scale).toFixed(1)} ${unit}`, interaction.current, '#ffb020')
    }
    if (interaction.kind === 'placingThruster') {
      const pose = this.poseOf(engine, interaction.bodyId)
      const origin = pose ? forceAnchorWorld(interaction.local, pose) : interaction.current
      const mag = Math.hypot(interaction.current.x - origin.x, interaction.current.y - origin.y)
      const mass = engine.world?.getBody(interaction.bodyId)?.mass ?? 1
      add(`🚀 ${(mag * mass * FORCE_ACCEL_PER_METER).toFixed(1)} N`, interaction.current, '#ff8a3d')
    }
    if (interaction.kind === 'measuring' || measureLabel) {
      const mid = {
        x: interaction.kind === 'measuring' ? (interaction.start.x + interaction.current.x) / 2 : 0,
        y: interaction.kind === 'measuring' ? (interaction.start.y + interaction.current.y) / 2 : 0,
      }
      if (interaction.kind === 'measuring') {
        const d = Math.hypot(
          interaction.current.x - interaction.start.x,
          interaction.current.y - interaction.start.y,
        )
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

  private forceOrigin(
    engine: SimulationEngine,
    interaction: Extract<InteractionState, { kind: 'applyingForce' }>,
  ): Vec2 {
    if (!interaction.local) return interaction.current
    const snap = engine.interpolated(interaction.bodyId)
    const body = engine.doc.bodies.find((b) => b.id === interaction.bodyId)
    const pose = snap ?? body
    if (!pose) return interaction.current
    return forceAnchorWorld(interaction.local, pose)
  }
}

export type { AppliedForce }
