import { describe, expect, it } from 'vitest'
import { SimulationEngine } from '../src/sim/engine.ts'
import { emptyScene } from '../src/scene/document.ts'
import { EXPERIMENTS } from '../src/experiments/scenes.ts'
import { PBF_MAX_PARTICLES } from '../src/fluids/pbf/PbfFluid.ts'

describe('PBF particle fluid', () => {
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
        y: 1.5,
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
        shape: { kind: 'box', hx: 0.35, hy: 0.2 },
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
        spacing: 0.11,
      },
    ]
    const engine = new SimulationEngine(doc)
    await engine.init()
    engine.play()
    for (let i = 0; i < 240; i++) engine.advance(1 / 60)
    const wood = engine.curr.find((b) => b.id === 'body:wood')!
    expect(wood.y).toBeGreaterThan(0.35)
    expect(wood.y).toBeLessThan(2.6)
    expect(engine.particles.buoyancyDebug.some((d) => d.bodyId === 'body:wood')).toBe(true)
    engine.world?.destroy()
  })
})
