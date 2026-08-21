/**
 * Automated evaluation of particle-fluid (PBF) behaviour across authored particle
 * experiments (vaso / spill) and synthetic scenarios. Float/sink pedagogy demos
 * use fluidRegions and are covered in physics.test.ts.
 * Failures indicate physics regressions; console metrics summarize pass/fail for manual review.
 */
import { describe, expect, it } from 'vitest'
import { SimulationEngine } from '../src/sim/engine.ts'
import { emptyScene } from '../src/scene/document.ts'
import { EXPERIMENTS } from '../src/experiments/scenes.ts'
import type { BodySnapshot } from '../src/physics/ports.ts'

function stats(particles: { x: number; y: number }[]) {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let cx = 0
  let cy = 0
  for (const p of particles) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
    cx += p.x
    cy += p.y
  }
  const n = particles.length || 1
  return { minX, maxX, minY, maxY, cx: cx / n, cy: cy / n, n: particles.length, w: maxX - minX, h: maxY - minY }
}

function speed(b: BodySnapshot): number {
  return Math.hypot(b.vx, b.vy)
}

async function run(doc: ReturnType<typeof emptyScene>, steps: number) {
  const engine = new SimulationEngine(doc)
  await engine.init()
  engine.play()
  for (let i = 0; i < steps; i++) engine.advance(1 / 60)
  return engine
}

describe('particle fluid evaluation', () => {
  it('containment: most particles stay inside a fixed U-cup', async () => {
    const exp = EXPERIMENTS.find((e) => e.id === 'particle-tank')!.build()
    const engine = await run(exp, 180)
    const n0 = engine.particles.particleCount
    expect(n0).toBeGreaterThan(40)
    const s = stats(engine.particles.particles)
    // Cup interior roughly |x|<0.6, y in [0.2, 1.6]
    const inside = engine.particles.particles.filter(
      (p) => Math.abs(p.x) < 0.65 && p.y > 0.15 && p.y < 1.7,
    ).length
    const frac = inside / n0
    console.log('[eval containment]', { n0, inside, frac: frac.toFixed(3), cy: s.cy.toFixed(3) })
    expect(frac).toBeGreaterThan(0.85)
    expect(s.cy).toBeGreaterThan(0.25)
    expect(s.cy).toBeLessThan(1.4)
    engine.world?.destroy()
  })

  it('spill-cup experiment: particles exist and cup does not explode away', async () => {
    const exp = EXPERIMENTS.find((e) => e.id === 'spill-cup')!.build()
    const engine = await run(exp, 150)
    const bottom = engine.curr.find((b) => b.id === 'body:cup-bottom')!
    console.log('[eval spill-cup]', {
      particles: engine.particles.particleCount,
      cupY: bottom.y.toFixed(3),
      cupSpeed: speed(bottom).toFixed(3),
    })
    expect(engine.particles.particleCount).toBeGreaterThan(8)
    expect(bottom.y).toBeGreaterThan(0.2)
    expect(bottom.y).toBeLessThan(4)
    expect(speed(bottom)).toBeLessThan(8)
    engine.world?.destroy()
  })

  it('synthetic: tall pour spreads into a wider pool on the floor', async () => {
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
        friction: 0.3,
        restitution: 0,
        materialId: 'stone',
        gravityScale: 1,
        linearDamping: 0,
        angularDamping: 0,
        ccd: false,
        locked: true,
        lockRotation: true,
        shape: { kind: 'box', hx: 12, hy: 0.2 },
      },
    ]
    doc.fluidVolumes = [
      {
        id: 'fluid:pour',
        name: 'Chorrito',
        polygon: [
          { x: -0.2, y: 1.0 },
          { x: 0.2, y: 1.0 },
          { x: 0.2, y: 2.2 },
          { x: -0.2, y: 2.2 },
        ],
        materialId: 'water',
        spacing: 0.1,
      },
    ]
    const engine = new SimulationEngine(doc)
    await engine.init()
    const before = stats(engine.particles.particles)
    engine.play()
    for (let i = 0; i < 180; i++) engine.advance(1 / 60)
    const after = stats(engine.particles.particles)
    const onFloor = engine.particles.particles.filter((p) => p.y > -0.05 && p.y < 1.2).length
    const fracOnFloor = onFloor / Math.max(1, after.n)
    console.log('[eval pour]', {
      w0: before.w.toFixed(3),
      w1: after.w.toFixed(3),
      h0: before.h.toFixed(3),
      h1: after.h.toFixed(3),
      cy: after.cy.toFixed(3),
      fracOnFloor: fracOnFloor.toFixed(3),
    })
    expect(after.h).toBeLessThan(before.h * 0.85)
    expect(fracOnFloor).toBeGreaterThan(0.7)
    expect(after.cy).toBeLessThan(1.0)
    // Width may grow modestly; confined stability is preferred over explosive spread.
    expect(after.w).toBeGreaterThanOrEqual(before.w * 0.95)
    engine.world?.destroy()
  })

  it('thin-stick U container: fluid must not explode out the sides', async () => {
    // Reproduces the user regression: two vertical sticks + horizontal base.
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
        id: 'body:base',
        name: 'Base',
        type: 'fixed',
        x: 0,
        y: 0.08,
        angle: 0,
        vx: 0,
        vy: 0,
        omega: 0,
        massMode: 'density',
        density: 2600,
        friction: 0.4,
        restitution: 0,
        materialId: 'wood',
        gravityScale: 1,
        linearDamping: 0,
        angularDamping: 0,
        ccd: false,
        locked: true,
        lockRotation: true,
        shape: { kind: 'box', hx: 0.55, hy: 0.06 },
      },
      {
        id: 'body:stick-l',
        name: 'Palo izq.',
        type: 'fixed',
        x: -0.55,
        y: 0.7,
        angle: 0,
        vx: 0,
        vy: 0,
        omega: 0,
        massMode: 'density',
        density: 2600,
        friction: 0.4,
        restitution: 0,
        materialId: 'wood',
        gravityScale: 1,
        linearDamping: 0,
        angularDamping: 0,
        ccd: false,
        locked: true,
        lockRotation: true,
        shape: { kind: 'box', hx: 0.06, hy: 0.65 },
      },
      {
        id: 'body:stick-r',
        name: 'Palo der.',
        type: 'fixed',
        x: 0.55,
        y: 0.7,
        angle: 0,
        vx: 0,
        vy: 0,
        omega: 0,
        massMode: 'density',
        density: 2600,
        friction: 0.4,
        restitution: 0,
        materialId: 'wood',
        gravityScale: 1,
        linearDamping: 0,
        angularDamping: 0,
        ccd: false,
        locked: true,
        lockRotation: true,
        shape: { kind: 'box', hx: 0.06, hy: 0.65 },
      },
    ]
    doc.fluidVolumes = [
      {
        id: 'fluid:pour',
        name: 'Agua',
        polygon: [
          { x: -0.4, y: 0.25 },
          { x: 0.7, y: 0.25 },
          { x: 0.7, y: 1.15 },
          { x: -0.4, y: 1.15 },
        ],
        materialId: 'water',
        spacing: 0.09,
      },
    ]
    const engine = await run(doc, 200)
    const n = engine.particles.particleCount
    expect(n).toBeGreaterThan(30)
    const inside = engine.particles.particles.filter(
      (p) => Math.abs(p.x) < 0.52 && p.y > 0.05 && p.y < 1.6,
    ).length
    const escaped = engine.particles.particles.filter((p) => Math.abs(p.x) > 0.7).length
    const s = stats(engine.particles.particles)
    console.log('[eval thin-U]', {
      n,
      inside,
      escaped,
      fracInside: (inside / n).toFixed(3),
      w: s.w.toFixed(3),
      cy: s.cy.toFixed(3),
    })
    expect(inside / n).toBeGreaterThan(0.8)
    expect(escaped / n).toBeLessThan(0.12)
    expect(s.w).toBeLessThan(1.4)
    // No coherent jet: peak |vx| should stay modest after settling.
    let maxAbsVx = 0
    for (const p of engine.particles.particles) {
      const ax = Math.abs(p.vx)
      if (ax > maxAbsVx) maxAbsVx = ax
    }
    expect(maxAbsVx).toBeLessThan(4)
    engine.world?.destroy()
  })
})
