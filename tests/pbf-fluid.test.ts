import { describe, expect, it } from 'vitest'
import { SimulationEngine } from '../src/sim/engine.ts'
import { emptyScene, type SceneBody } from '../src/scene/document.ts'
import { EXPERIMENTS } from '../src/experiments/scenes.ts'
import { PBF_MAX_PARTICLES } from '../src/fluids/pbf/PbfFluid.ts'
import { clavetRestDensity } from '../src/fluids/pbf/kernels.ts'
import { pushOutOfShape } from '../src/fluids/pbf/collide.ts'
import { estimateFreeSurfaceD } from '../src/fluids/pbf/freeSurface.ts'
import type { PhysicsShape } from '../src/physics/ports.ts'

describe('SPH Clavet particle fluid', () => {
  it('seeds particles from fluidVolumes on init and keeps approximate count', async () => {
    const doc = emptyScene()
    doc.bodies = [
      {
        id: 'body:ground',
        name: 'Suelo',
        type: 'fixed',
        x: 0,
        y: -0.2,
        angle: 0,
        vx: 0,
        vy: 0,
        omega: 0,
        massMode: 'density',
        density: 2600,
        friction: 0.5,
        restitution: 0,
        materialId: 'stone',
        gravityScale: 1,
        linearDamping: 0,
        angularDamping: 0,
        ccd: false,
        locked: true,
        lockRotation: true,
        shape: { kind: 'box', hx: 4, hy: 0.2 },
      },
      {
        id: 'body:left',
        name: 'Izq',
        type: 'fixed',
        x: -1.1,
        y: 0.8,
        angle: 0,
        vx: 0,
        vy: 0,
        omega: 0,
        massMode: 'density',
        density: 2600,
        friction: 0.4,
        restitution: 0,
        materialId: 'stone',
        gravityScale: 1,
        linearDamping: 0,
        angularDamping: 0,
        ccd: false,
        locked: true,
        lockRotation: true,
        shape: { kind: 'box', hx: 0.1, hy: 1 },
      },
      {
        id: 'body:right',
        name: 'Der',
        type: 'fixed',
        x: 1.1,
        y: 0.8,
        angle: 0,
        vx: 0,
        vy: 0,
        omega: 0,
        massMode: 'density',
        density: 2600,
        friction: 0.4,
        restitution: 0,
        materialId: 'stone',
        gravityScale: 1,
        linearDamping: 0,
        angularDamping: 0,
        ccd: false,
        locked: true,
        lockRotation: true,
        shape: { kind: 'box', hx: 0.1, hy: 1 },
      },
    ]
    doc.fluidVolumes = [
      {
        id: 'fluid:pool',
        name: 'Charco',
        polygon: [
          { x: -0.9, y: 0.1 },
          { x: 0.9, y: 0.1 },
          { x: 0.9, y: 1.4 },
          { x: -0.9, y: 1.4 },
        ],
        materialId: 'water',
        spacing: 0.15,
      },
    ]
    const engine = new SimulationEngine(doc)
    await engine.init()
    const n0 = engine.particles.particleCount
    expect(n0).toBeGreaterThan(20)
    expect(n0).toBeLessThanOrEqual(PBF_MAX_PARTICLES)
    engine.play()
    for (let i = 0; i < 90; i++) engine.advance(1 / 60)
    // Contained by walls: most particles remain (some splash is OK).
    expect(engine.particles.particleCount).toBeGreaterThan(15)
    // Center of mass should stay roughly in the tank (not free-fall through floor).
    let cy = 0
    for (const p of engine.particles.particles) cy += p.y
    cy /= engine.particles.particleCount
    expect(cy).toBeGreaterThan(0.05)
    expect(cy).toBeLessThan(2.5)
    engine.world?.destroy()
  })

  it('spill-cup experiment seeds particles and cup stays near the table', async () => {
    const exp = EXPERIMENTS.find((e) => e.id === 'spill-cup')!.build()
    const engine = new SimulationEngine(exp)
    await engine.init()
    expect(engine.particles.particleCount).toBeGreaterThan(10)
    for (let i = 0; i < 120; i++) engine.stepOnce()
    const bottom = engine.curr.find((b) => b.id === 'body:cup-bottom')!
    expect(bottom.y).toBeGreaterThan(0.2)
    expect(bottom.y).toBeLessThan(3.5)
    engine.world?.destroy()
  })

  it('collapses a tall column into a wider pool (flows, does not keep the box)', async () => {
    const doc = emptyScene()
    doc.bodies = [
      {
        id: 'body:ground',
        name: 'Suelo',
        type: 'fixed',
        x: 0,
        y: -0.2,
        angle: 0,
        vx: 0,
        vy: 0,
        omega: 0,
        massMode: 'density',
        density: 2600,
        friction: 0.4,
        restitution: 0,
        materialId: 'stone',
        gravityScale: 1,
        linearDamping: 0,
        angularDamping: 0,
        ccd: false,
        locked: true,
        lockRotation: true,
        shape: { kind: 'box', hx: 5, hy: 0.2 },
      },
    ]
    doc.fluidVolumes = [
      {
        id: 'fluid:column',
        name: 'Columna',
        polygon: [
          { x: -0.25, y: 0.15 },
          { x: 0.25, y: 0.15 },
          { x: 0.25, y: 1.6 },
          { x: -0.25, y: 1.6 },
        ],
        materialId: 'water',
        spacing: 0.12,
      },
    ]
    const engine = new SimulationEngine(doc)
    await engine.init()
    engine.play()
    for (let i = 0; i < 150; i++) engine.advance(1 / 60)
    let minY = Infinity
    let maxY = -Infinity
    for (const p of engine.particles.particles) {
      if (p.y < minY) minY = p.y
      if (p.y > maxY) maxY = p.y
    }
    expect(maxY - minY).toBeLessThan(1.2)
    // Column should settle near the floor (not stay as a floating rigid block).
    expect((minY + maxY) / 2).toBeLessThan(0.9)
    engine.world?.destroy()
  })

  it('addVolume appends without resetting existing particle positions', async () => {
    const doc = emptyScene()
    doc.bodies = [
      {
        id: 'body:ground',
        name: 'Suelo',
        type: 'fixed',
        x: 0,
        y: -0.2,
        angle: 0,
        vx: 0,
        vy: 0,
        omega: 0,
        massMode: 'density',
        density: 2600,
        friction: 0.5,
        restitution: 0,
        materialId: 'stone',
        gravityScale: 1,
        linearDamping: 0,
        angularDamping: 0,
        ccd: false,
        locked: true,
        lockRotation: true,
        shape: { kind: 'box', hx: 6, hy: 0.2 },
      },
    ]
    doc.fluidVolumes = [
      {
        id: 'fluid:a',
        name: 'A',
        polygon: [
          { x: -2.2, y: 0.2 },
          { x: -1.4, y: 0.2 },
          { x: -1.4, y: 0.9 },
          { x: -2.2, y: 0.9 },
        ],
        materialId: 'water',
        spacing: 0.14,
      },
    ]
    const engine = new SimulationEngine(doc)
    await engine.init()
    engine.play()
    for (let i = 0; i < 60; i++) engine.advance(1 / 60)
    const before = engine.particles.particles
      .filter((p) => p.volumeId === 'fluid:a')
      .map((p) => ({ x: p.x, y: p.y }))
    expect(before.length).toBeGreaterThan(5)
    const n0 = engine.particles.particleCount
    engine.particles.addVolume({
      id: 'fluid:b',
      name: 'B',
      polygon: [
        { x: 1.4, y: 0.2 },
        { x: 2.2, y: 0.2 },
        { x: 2.2, y: 0.9 },
        { x: 1.4, y: 0.9 },
      ],
      materialId: 'water',
      spacing: 0.14,
    })
    expect(engine.particles.particleCount).toBeGreaterThan(n0)
    const after = engine.particles.particles.filter((p) => p.volumeId === 'fluid:a')
    expect(after.length).toBe(before.length)
    let drift = 0
    for (let i = 0; i < before.length; i++) {
      drift += Math.hypot(after[i]!.x - before[i]!.x, after[i]!.y - before[i]!.y)
    }
    // Must not snap back to the seed box (rebuild would move them a lot).
    expect(drift / before.length).toBeLessThan(0.05)
    engine.world?.destroy()
  })

  it('wood box floats in a particle pool (Archimedes via free surface)', async () => {
    const doc = emptyScene()
    doc.bodies = [
      {
        id: 'body:ground',
        name: 'Suelo',
        type: 'fixed',
        x: 0,
        y: -0.2,
        angle: 0,
        vx: 0,
        vy: 0,
        omega: 0,
        massMode: 'density',
        density: 2600,
        friction: 0.2,
        restitution: 0,
        materialId: 'stone',
        gravityScale: 1,
        linearDamping: 0,
        angularDamping: 0,
        ccd: false,
        locked: true,
        lockRotation: true,
        shape: { kind: 'box', hx: 4, hy: 0.2 },
      },
      {
        id: 'body:left',
        name: 'Izq',
        type: 'fixed',
        x: -1.6,
        y: 1.0,
        angle: 0,
        vx: 0,
        vy: 0,
        omega: 0,
        massMode: 'density',
        density: 2600,
        friction: 0.2,
        restitution: 0,
        materialId: 'stone',
        gravityScale: 1,
        linearDamping: 0,
        angularDamping: 0,
        ccd: false,
        locked: true,
        lockRotation: true,
        shape: { kind: 'box', hx: 0.1, hy: 1.2 },
      },
      {
        id: 'body:right',
        name: 'Der',
        type: 'fixed',
        x: 1.6,
        y: 1.0,
        angle: 0,
        vx: 0,
        vy: 0,
        omega: 0,
        massMode: 'density',
        density: 2600,
        friction: 0.2,
        restitution: 0,
        materialId: 'stone',
        gravityScale: 1,
        linearDamping: 0,
        angularDamping: 0,
        ccd: false,
        locked: true,
        lockRotation: true,
        shape: { kind: 'box', hx: 0.1, hy: 1.2 },
      },
      {
        id: 'body:wood',
        name: 'Madera',
        type: 'dynamic',
        x: 0,
        y: 1.2,
        angle: 0,
        vx: 0,
        vy: 0,
        omega: 0,
        massMode: 'density',
        density: 600,
        friction: 0.2,
        restitution: 0,
        materialId: 'wood',
        gravityScale: 1,
        linearDamping: 0.4,
        angularDamping: 0.4,
        ccd: false,
        locked: false,
        lockRotation: true,
        shape: { kind: 'box', hx: 0.3, hy: 0.12 },
      },
    ]
    doc.fluidVolumes = [
      {
        id: 'fluid:pool',
        name: 'Piscina',
        polygon: [
          { x: -1.4, y: 0.05 },
          { x: 1.4, y: 0.05 },
          { x: 1.4, y: 1.35 },
          { x: -1.4, y: 1.35 },
        ],
        materialId: 'water',
        spacing: 0.1,
      },
    ]
    const engine = new SimulationEngine(doc)
    await engine.init()
    engine.play()
    for (let i = 0; i < 360; i++) engine.advance(1 / 60)
    const wood = engine.curr.find((b) => b.id === 'body:wood')!
    const hy = 0.12
    const surfaceY = poolSurfaceY(engine.particles.particles, wood.x, 0.9)
    expect(engine.particles.buoyancyDebug.some((d) => d.bodyId === 'body:wood')).toBe(true)
    // Must sit in the pool, not on the floor and not hovering above the free surface.
    expect(wood.y - hy).toBeGreaterThan(0.06)
    expect(wood.y - hy).toBeLessThan(surfaceY - 0.03)
    expect(wood.y + hy).toBeGreaterThan(surfaceY)
    expect(Math.hypot(wood.vx, wood.vy)).toBeLessThan(0.22)
    engine.world?.destroy()
  })

  it('submerged wood rises and settles at the free surface (no levitation)', async () => {
    // Regression: film of water riding on the body used to set clipD at the
    // body's roof → F/W ≈ ρ_water/ρ_wood constantly → perpetual lift.
    const hx = 0.2
    const hy = 0.11
    const doc = emptyScene()
    doc.bodies = [
      {
        id: 'body:ground',
        name: 'Suelo',
        type: 'fixed',
        x: 0,
        y: -0.25,
        angle: 0,
        vx: 0,
        vy: 0,
        omega: 0,
        massMode: 'density',
        density: 2600,
        friction: 0.4,
        restitution: 0,
        materialId: 'stone',
        gravityScale: 1,
        linearDamping: 0,
        angularDamping: 0,
        ccd: false,
        locked: true,
        lockRotation: true,
        shape: { kind: 'box', hx: 6, hy: 0.25 },
      },
      {
        id: 'body:left',
        name: 'Izq',
        type: 'fixed',
        x: -1.5,
        y: 1.0,
        angle: 0,
        vx: 0,
        vy: 0,
        omega: 0,
        massMode: 'density',
        density: 2600,
        friction: 0.4,
        restitution: 0,
        materialId: 'stone',
        gravityScale: 1,
        linearDamping: 0,
        angularDamping: 0,
        ccd: false,
        locked: true,
        lockRotation: true,
        shape: { kind: 'box', hx: 0.1, hy: 1.0 },
      },
      {
        id: 'body:right',
        name: 'Der',
        type: 'fixed',
        x: 1.5,
        y: 1.0,
        angle: 0,
        vx: 0,
        vy: 0,
        omega: 0,
        massMode: 'density',
        density: 2600,
        friction: 0.4,
        restitution: 0,
        materialId: 'stone',
        gravityScale: 1,
        linearDamping: 0,
        angularDamping: 0,
        ccd: false,
        locked: true,
        lockRotation: true,
        shape: { kind: 'box', hx: 0.1, hy: 1.0 },
      },
      {
        id: 'body:wood',
        name: 'Madera',
        type: 'dynamic',
        x: 0,
        y: 0.35,
        angle: 0,
        vx: 0,
        vy: 0,
        omega: 0,
        massMode: 'density',
        density: 600,
        friction: 0.5,
        restitution: 0,
        materialId: 'wood',
        gravityScale: 1,
        linearDamping: 0.4,
        angularDamping: 0.4,
        ccd: false,
        locked: false,
        lockRotation: true,
        shape: { kind: 'box', hx, hy },
      },
    ]
    doc.fluidVolumes = [
      {
        id: 'fluid:pool',
        name: 'Piscina',
        polygon: [
          { x: -1.35, y: 0.05 },
          { x: 1.35, y: 0.05 },
          { x: 1.35, y: 1.5 },
          { x: -1.35, y: 1.5 },
        ],
        materialId: 'water',
        spacing: 0.09,
      },
    ]
    const engine = new SimulationEngine(doc)
    await engine.init()
    engine.play()
    for (let i = 0; i < 720; i++) engine.advance(1 / 60)
    const wood = engine.curr.find((b) => b.id === 'body:wood')!
    const surfaceY = poolSurfaceY(engine.particles.particles, wood.x, 0.7)
    // Must have risen off the deep start pose.
    expect(wood.y).toBeGreaterThan(0.45)
    // Must sit in the pool — not a meter above the free surface.
    expect(wood.y - hy).toBeLessThan(surfaceY + 0.05)
    expect(wood.y + hy).toBeGreaterThan(surfaceY - 0.05)
    expect(wood.y).toBeLessThan(surfaceY + hy + 0.15)
    expect(Math.hypot(wood.vx, wood.vy)).toBeLessThan(0.35)
    engine.world?.destroy()
  })

  it('wood convex triangle floats instead of resting on the floor', async () => {
    const doc = particlePoolDoc({
      id: 'body:hull',
      name: 'Polígono',
      type: 'dynamic',
      x: 0,
      y: 1.35,
      angle: 0,
      vx: 0,
      vy: 0,
      omega: 0,
      massMode: 'density',
      density: 600,
      friction: 0.15,
      restitution: 0,
      materialId: 'wood',
      gravityScale: 1,
      linearDamping: 0.5,
      angularDamping: 0.5,
      ccd: false,
      locked: false,
      lockRotation: true,
      shape: {
        kind: 'convex',
        vertices: [
          { x: 0, y: 0.28 },
          { x: -0.4, y: -0.22 },
          { x: 0.4, y: -0.22 },
        ],
      },
    })
    const engine = new SimulationEngine(doc)
    await engine.init()
    engine.play()
    for (let i = 0; i < 360; i++) engine.advance(1 / 60)
    const hull = engine.curr.find((b) => b.id === 'body:hull')!
    const surfaceY = poolSurfaceY(engine.particles.particles, hull.x, 0.9)
    expect(engine.particles.buoyancyDebug.some((d) => d.bodyId === 'body:hull')).toBe(true)
    expect(hull.y).toBeGreaterThan(0.28)
    expect(hull.y).toBeLessThan(surfaceY + 0.35)
    expect(hull.y - 0.22).toBeLessThan(surfaceY - 0.02)
    expect(Math.hypot(hull.vx, hull.vy)).toBeLessThan(0.22)
    engine.world?.destroy()
  })

  it('contained pool particles come to rest', async () => {
    const doc = particlePoolDoc({
      id: 'body:dummy',
      name: 'Dummy',
      type: 'fixed',
      x: 0,
      y: -8,
      angle: 0,
      vx: 0,
      vy: 0,
      omega: 0,
      massMode: 'density',
      density: 2600,
      friction: 0.2,
      restitution: 0,
      materialId: 'stone',
      gravityScale: 1,
      linearDamping: 0,
      angularDamping: 0,
      ccd: false,
      locked: true,
      lockRotation: true,
      shape: { kind: 'box', hx: 0.1, hy: 0.1 },
    })
    const engine = new SimulationEngine(doc)
    await engine.init()
    engine.play()
    for (let i = 0; i < 300; i++) engine.advance(1 / 60)
    let maxSp = 0
    let sum = 0
    for (const p of engine.particles.particles) {
      const sp = Math.hypot(p.vx, p.vy)
      if (sp > maxSp) maxSp = sp
      sum += sp
    }
    const n = engine.particles.particleCount
    expect(n).toBeGreaterThan(20)
    expect(maxSp).toBeLessThan(0.2)
    expect(sum / n).toBeLessThan(0.06)
    engine.world?.destroy()
  })

  it('floating wood box and pool come to rest without residual spin', async () => {
    const doc = particlePoolDoc({
      id: 'body:wood',
      name: 'Madera',
      type: 'dynamic',
      x: 0,
      y: 1.15,
      angle: 0,
      vx: 0,
      vy: 0,
      omega: 0,
      massMode: 'density',
      density: 600,
      friction: 0.2,
      restitution: 0,
      materialId: 'wood',
      gravityScale: 1,
      linearDamping: 0.5,
      angularDamping: 0.5,
      ccd: false,
      locked: false,
      lockRotation: false,
      shape: { kind: 'box', hx: 0.3, hy: 0.12 },
    })
    const engine = new SimulationEngine(doc)
    await engine.init()
    engine.play()
    for (let i = 0; i < 480; i++) engine.advance(1 / 60)
    const wood = engine.curr.find((b) => b.id === 'body:wood')!
    const hy = 0.12
    const surfaceY = poolSurfaceY(engine.particles.particles, wood.x, 0.9)
    expect(engine.particles.buoyancyDebug.some((d) => d.bodyId === 'body:wood')).toBe(true)
    expect(wood.y - hy).toBeGreaterThan(0.06)
    expect(wood.y + hy).toBeGreaterThan(surfaceY)
    expect(Math.hypot(wood.vx, wood.vy)).toBeLessThan(0.08)
    expect(Math.abs(wood.omega)).toBeLessThan(0.08)
    let maxP = 0
    for (const p of engine.particles.particles) {
      const sp = Math.hypot(p.vx, p.vy)
      if (sp > maxP) maxP = sp
    }
    expect(maxP).toBeLessThan(0.22)
    engine.world?.destroy()
  })

  it('hex 9×9 interior rest density is near ρ0', async () => {
    const s = 0.1
    const h = s * 2.2
    const rho0 = clavetRestDensity(s, h)
    const rowH = s * 0.8660254037844386
    const pts: { x: number; y: number }[] = []
    for (let row = 0; row < 9; row++) {
      const y = (row - 4) * rowH
      const xOff = (row & 1) !== 0 ? s * 0.5 : 0
      for (let col = 0; col < 9; col++) {
        pts.push({ x: (col - 4) * s + xOff, y })
      }
    }
    const interior = pts.filter((p) => Math.abs(p.x) < 2.5 * s && Math.abs(p.y) < 2.5 * rowH)
    expect(interior.length).toBeGreaterThan(4)
    for (const p of interior) {
      let rho = 0
      for (const q of pts) {
        const r = Math.hypot(p.x - q.x, p.y - q.y)
        if (r >= h) continue
        const w = 1 - r / h
        rho += w * w
      }
      const rel = rho / rho0
      expect(rel).toBeGreaterThanOrEqual(0.95)
      expect(rel).toBeLessThanOrEqual(1.05)
    }

    const doc = emptyScene()
    doc.world.gravity = { x: 0, y: 0 }
    doc.world.gravityPreset = 'zero'
    doc.bodies = []
    doc.fluidVolumes = [
      {
        id: 'fluid:hex',
        name: 'Hex',
        polygon: [
          { x: 0, y: 2 },
          { x: 1.0, y: 2 },
          { x: 1.0, y: 2.85 },
          { x: 0, y: 2.85 },
        ],
        materialId: 'water',
        spacing: s,
      },
    ]
    const engine = new SimulationEngine(doc)
    await engine.init()
    expect(engine.particles.particleCount).toBeGreaterThan(40)
    engine.play()
    engine.advance(1 / 60)
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const p of engine.particles.particles) {
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
      if (p.y < minY) minY = p.y
      if (p.y > maxY) maxY = p.y
    }
    const seeded = engine.particles.particles.filter(
      (p) => p.x > minX + h && p.x < maxX - h && p.y > minY + h && p.y < maxY - h,
    )
    expect(seeded.length).toBeGreaterThan(4)
    const mean = seeded.reduce((a, p) => a + p.density, 0) / seeded.length
    expect(mean).toBeGreaterThanOrEqual(0.95)
    expect(mean).toBeLessThanOrEqual(1.05)
    engine.world?.destroy()
  })

  it('a single particle in free fall follows v ≈ g t', async () => {
    const doc = emptyScene()
    doc.bodies = []
    doc.fluidVolumes = [
      {
        id: 'fluid:drop',
        name: 'Gota',
        polygon: [
          { x: -0.08, y: 5 },
          { x: 0.08, y: 5 },
          { x: 0.08, y: 5.15 },
          { x: -0.08, y: 5.15 },
        ],
        materialId: 'water',
        spacing: 0.1,
      },
    ]
    const engine = new SimulationEngine(doc)
    await engine.init()
    expect(engine.particles.particleCount).toBe(1)
    engine.play()
    for (let i = 0; i < 47; i++) engine.advance(1 / 60)
    const p = engine.particles.particles[0]!
    const g = doc.world.gravity.y
    const t = 47 / 60
    const expected = g * t
    expect(Math.abs(p.vy)).toBeGreaterThan(7.2)
    expect(Math.abs(p.vy)).toBeLessThan(8)
    expect(Math.abs(p.vy - expected) / Math.abs(expected)).toBeLessThan(0.08)
    engine.world?.destroy()
  })

  it('honey damps faster than water in the same cup', async () => {
    const makeCup = (materialId: 'water' | 'honey') => {
      const doc = emptyScene()
      doc.bodies = [
        {
          id: 'body:ground',
          name: 'Suelo',
          type: 'fixed',
          x: 0,
          y: -0.2,
          angle: 0,
          vx: 0,
          vy: 0,
          omega: 0,
          massMode: 'density',
          density: 2600,
          friction: 0.5,
          restitution: 0,
          materialId: 'stone',
          gravityScale: 1,
          linearDamping: 0,
          angularDamping: 0,
          ccd: false,
          locked: true,
          lockRotation: true,
          shape: { kind: 'box', hx: 4, hy: 0.2 },
        },
        {
          id: 'body:left',
          name: 'Izq',
          type: 'fixed',
          x: -1.1,
          y: 0.8,
          angle: 0,
          vx: 0,
          vy: 0,
          omega: 0,
          massMode: 'density',
          density: 2600,
          friction: 0.4,
          restitution: 0,
          materialId: 'stone',
          gravityScale: 1,
          linearDamping: 0,
          angularDamping: 0,
          ccd: false,
          locked: true,
          lockRotation: true,
          shape: { kind: 'box', hx: 0.1, hy: 1 },
        },
        {
          id: 'body:right',
          name: 'Der',
          type: 'fixed',
          x: 1.1,
          y: 0.8,
          angle: 0,
          vx: 0,
          vy: 0,
          omega: 0,
          massMode: 'density',
          density: 2600,
          friction: 0.4,
          restitution: 0,
          materialId: 'stone',
          gravityScale: 1,
          linearDamping: 0,
          angularDamping: 0,
          ccd: false,
          locked: true,
          lockRotation: true,
          shape: { kind: 'box', hx: 0.1, hy: 1 },
        },
      ]
      doc.fluidVolumes = [
        {
          id: 'fluid:pool',
          name: 'Charco',
          polygon: [
            { x: -0.9, y: 0.1 },
            { x: 0.9, y: 0.1 },
            { x: 0.9, y: 1.4 },
            { x: -0.9, y: 1.4 },
          ],
          materialId,
          spacing: 0.15,
        },
      ]
      return doc
    }
    const sumSpeed = async (materialId: 'water' | 'honey') => {
      const engine = new SimulationEngine(makeCup(materialId))
      await engine.init()
      engine.play()
      for (let i = 0; i < 90; i++) engine.advance(1 / 60)
      let sum = 0
      for (const p of engine.particles.particles) sum += Math.hypot(p.vx, p.vy)
      const n = engine.particles.particleCount
      engine.world?.destroy()
      return { sum, n }
    }
    const water = await sumSpeed('water')
    const honey = await sumSpeed('honey')
    expect(water.n).toBeGreaterThan(10)
    expect(honey.n).toBeGreaterThan(10)
    expect(honey.sum).toBeLessThan(0.55 * water.sum)
  })
})

describe('particle collide / free surface', () => {
  const tri: PhysicsShape = {
    kind: 'convex',
    vertices: [
      { x: 0, y: 0.3 },
      { x: -0.4, y: -0.2 },
      { x: 0.4, y: -0.2 },
    ],
  }

  it('pushOutOfShape expels a point inside a convex triangle', () => {
    const hit = pushOutOfShape(0, 0, 0.05, tri, 0, 0, 0)
    expect(hit).not.toBeNull()
    expect(Math.hypot(hit!.x, hit!.y)).toBeGreaterThan(0.04)
  })

  it('pushOutOfShape ignores a point far from a convex triangle', () => {
    expect(pushOutOfShape(4, 4, 0.05, tri, 0, 0, 0)).toBeNull()
  })

  it('pushOutOfShape recurses into compound parts', () => {
    const compound: PhysicsShape = {
      kind: 'compound',
      parts: [{ kind: 'box', hx: 0.25, hy: 0.25 }],
    }
    expect(pushOutOfShape(0, 0, 0.05, compound, 0, 0, 0)).not.toBeNull()
    expect(pushOutOfShape(3, 3, 0.05, compound, 0, 0, 0)).toBeNull()
  })

  it('estimates free surface as median of column maxes and ignores splash', () => {
    const xs: number[] = []
    const ys: number[] = []
    for (let x = -1; x <= 1.001; x += 0.1) {
      for (let y = 0; y <= 1.001; y += 0.1) {
        xs.push(x)
        ys.push(y)
      }
    }
    const args = {
      x: xs,
      y: ys,
      n: xs.length,
      nx: 0,
      ny: 1,
      tMin: -1,
      tMax: 1,
      sMin: -0.5,
      sMax: 5,
      columnWidth: 0.15,
    }
    const d = estimateFreeSurfaceD(args)
    expect(d).toBeCloseTo(1, 1)

    xs.push(0, 0.1)
    ys.push(3.2, 3.4)
    const dSplash = estimateFreeSurfaceD({ ...args, x: xs, y: ys, n: xs.length })
    expect(dSplash).toBeLessThan(1.4)
    expect(dSplash).toBeGreaterThan(0.7)
  })

  it('returns null when too few particles are in the band', () => {
    expect(
      estimateFreeSurfaceD({
        x: [0, 0.1],
        y: [0.5, 0.6],
        n: 2,
        nx: 0,
        ny: 1,
        tMin: -1,
        tMax: 1,
        sMin: 0,
        sMax: 2,
        columnWidth: 0.2,
      }),
    ).toBeNull()
  })

  it('segment: hit near the line, miss far away', () => {
    const seg: PhysicsShape = { kind: 'segment', a: { x: 0, y: -1 }, b: { x: 0, y: 1 } }
    const hit = pushOutOfShape(0.05, 0, 0.1, seg, 0, 0, 0)
    expect(hit).not.toBeNull()
    expect(Math.abs(hit!.x)).toBeCloseTo(0.1, 5)
    expect(pushOutOfShape(2, 0, 0.1, seg, 0, 0, 0)).toBeNull()
  })

  it('segment: fromX/fromY keeps a thin vertical wall from ejecting to the far side', () => {
    const seg: PhysicsShape = { kind: 'segment', a: { x: 0, y: -1 }, b: { x: 0, y: 1 } }
    const r = 0.1
    const fromLeft = pushOutOfShape(0.02, 0, r, seg, 0, 0, 0, -0.08, 0)
    expect(fromLeft).not.toBeNull()
    expect(fromLeft!.x).toBeLessThan(0)
    expect(fromLeft!.x).toBeCloseTo(-r, 5)

    const fromRight = pushOutOfShape(-0.02, 0, r, seg, 0, 0, 0, 0.08, 0)
    expect(fromRight).not.toBeNull()
    expect(fromRight!.x).toBeGreaterThan(0)
    expect(fromRight!.x).toBeCloseTo(r, 5)
  })

  it('polyline: hit near a vertex chain, miss far away', () => {
    const poly: PhysicsShape = {
      kind: 'polyline',
      vertices: [
        { x: -1, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 1 },
      ],
    }
    const hit = pushOutOfShape(0, 0.04, 0.1, poly, 0, 0, 0)
    expect(hit).not.toBeNull()
    expect(Math.abs(hit!.x)).toBeCloseTo(0.1, 4)
    expect(pushOutOfShape(5, 5, 0.1, poly, 0, 0, 0)).toBeNull()
  })
})

function poolSurfaceY(particles: { x: number; y: number }[], x0: number, halfW: number): number {
  const ys = particles.filter((p) => Math.abs(p.x - x0) < halfW).map((p) => p.y)
  if (ys.length === 0) return 0
  ys.sort((a, b) => a - b)
  return ys[Math.floor(ys.length * 0.85)] ?? ys[ys.length - 1]!
}

function particlePoolDoc(floater: SceneBody) {
  const doc = emptyScene()
  doc.bodies = [
    {
      id: 'body:ground',
      name: 'Suelo',
      type: 'fixed',
      x: 0,
      y: -0.2,
      angle: 0,
      vx: 0,
      vy: 0,
      omega: 0,
      massMode: 'density',
      density: 2600,
      friction: 0.2,
      restitution: 0,
      materialId: 'stone',
      gravityScale: 1,
      linearDamping: 0,
      angularDamping: 0,
      ccd: false,
      locked: true,
      lockRotation: true,
      shape: { kind: 'box', hx: 4, hy: 0.2 },
    },
    {
      id: 'body:left',
      name: 'Izq',
      type: 'fixed',
      x: -1.6,
      y: 1.0,
      angle: 0,
      vx: 0,
      vy: 0,
      omega: 0,
      massMode: 'density',
      density: 2600,
      friction: 0.2,
      restitution: 0,
      materialId: 'stone',
      gravityScale: 1,
      linearDamping: 0,
      angularDamping: 0,
      ccd: false,
      locked: true,
      lockRotation: true,
      shape: { kind: 'box', hx: 0.1, hy: 1.2 },
    },
    {
      id: 'body:right',
      name: 'Der',
      type: 'fixed',
      x: 1.6,
      y: 1.0,
      angle: 0,
      vx: 0,
      vy: 0,
      omega: 0,
      massMode: 'density',
      density: 2600,
      friction: 0.2,
      restitution: 0,
      materialId: 'stone',
      gravityScale: 1,
      linearDamping: 0,
      angularDamping: 0,
      ccd: false,
      locked: true,
      lockRotation: true,
      shape: { kind: 'box', hx: 0.1, hy: 1.2 },
    },
    floater,
  ]
  doc.fluidVolumes = [
    {
      id: 'fluid:pool',
      name: 'Piscina',
      polygon: [
        { x: -1.4, y: 0.05 },
        { x: 1.4, y: 0.05 },
        { x: 1.4, y: 1.35 },
        { x: -1.4, y: 1.35 },
      ],
      materialId: 'water',
      spacing: 0.11,
    },
  ]
  return doc
}
