import { beforeAll, describe, expect, it } from 'vitest'
import { PHYSICS_DT } from '../src/core/constants.ts'
import { dragToImpulse, IMPULSE_VELOCITY_PER_METER } from '../src/interaction/force.ts'
import { RapierWorld } from '../src/physics/adapters/rapier/RapierWorld.ts'
import { loadRapier } from '../src/physics/adapters/rapier/loadRapier.ts'
import { SimulationEngine } from '../src/sim/engine.ts'
import { emptyScene } from '../src/scene/document.ts'
import { getSolid } from '../src/materials/catalog.ts'
import { polygonArea } from '../src/core/math/polygon.ts'
import { AnalyticFluidSolver } from '../src/fluids/analytic/AnalyticFluid.ts'

beforeAll(async () => {
  await loadRapier()
})

describe('Rapier freefall', () => {
  it('matches ½ g t² within 0.5% after 2 seconds', async () => {
    const R = await loadRapier()
    const g = -9.81
    const world = new RapierWorld(R, { x: 0, y: g }, PHYSICS_DT)
    const y0 = 10
    world.addBody({
      id: 'ball',
      type: 'dynamic',
      translation: { x: 0, y: y0 },
      rotation: 0,
      gravityScale: 1,
      linearDamping: 0,
      angularDamping: 0,
      colliders: [{ shape: { kind: 'circle', radius: 0.2 }, density: 1, friction: 0, restitution: 0 }],
    })
    const t = 2
    const steps = Math.round(t / PHYSICS_DT)
    for (let i = 0; i < steps; i++) world.step()
    const body = world.getBody('ball')!
    const expected = y0 + 0.5 * g * t * t
    const err = Math.abs(body.y - expected) / Math.abs(y0 - expected)
    expect(err).toBeLessThan(0.005)
    world.destroy()
  })
})

describe('impulse', () => {
  it('J = m Δv on a free body', async () => {
    const R = await loadRapier()
    const world = new RapierWorld(R, { x: 0, y: 0 }, PHYSICS_DT)
    world.addBody({
      id: 'ball',
      type: 'dynamic',
      translation: { x: 0, y: 0 },
      rotation: 0,
      gravityScale: 0,
      linearDamping: 0,
      angularDamping: 0,
      colliders: [{ shape: { kind: 'circle', radius: 0.5 }, mass: 2, friction: 0, restitution: 0 }],
    })
    const mass = world.getBody('ball')!.mass
    world.applyImpulse('ball', 6, 0)
    world.step()
    const v = world.getBody('ball')!.vx
    expect(Math.abs(v - 6 / mass) / (6 / mass)).toBeLessThan(0.01)
    world.destroy()
  })

  it('a 1 m force-tool drag kicks a heavy wood body by ~4 m/s', async () => {
    const R = await loadRapier()
    const world = new RapierWorld(R, { x: 0, y: 0 }, PHYSICS_DT)
    world.addBody({
      id: 'block',
      type: 'dynamic',
      translation: { x: 0, y: 0 },
      rotation: 0,
      gravityScale: 0,
      linearDamping: 0,
      angularDamping: 0,
      colliders: [{ shape: { kind: 'box', hx: 0.5, hy: 0.5 }, density: 600, friction: 0, restitution: 0 }],
    })
    const mass = world.getBody('block')!.mass
    const j = dragToImpulse(mass, 1, 0)
    world.applyImpulse('block', j.x, j.y)
    world.step()
    expect(world.getBody('block')!.vx).toBeCloseTo(IMPULSE_VELOCITY_PER_METER, 1)
    world.destroy()
  })
})

describe('buoyancy', () => {
  it('a less-dense body floats with submerged fraction ≈ ρ_body/ρ_fluid', async () => {
    const engine = new SimulationEngine(emptyScene())
    await engine.init()
    engine.doc.bodies = [
      {
        id: 'floor',
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
        friction: 0,
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
        id: 'wood',
        name: 'Madera',
        type: 'dynamic',
        x: 0,
        y: 1.4,
        angle: 0,
        vx: 0,
        vy: 0,
        omega: 0,
        massMode: 'density',
        density: 600,
        friction: 0,
        restitution: 0,
        materialId: 'wood',
        gravityScale: 1,
        linearDamping: 0.8,
        angularDamping: 0.8,
        ccd: false,
        locked: false,
        lockRotation: true,
        shape: { kind: 'box', hx: 0.5, hy: 0.25 },
      },
    ]
    engine.doc.fluidRegions = [
      {
        id: 'water',
        name: 'Agua',
        polygon: [
          { x: -3, y: 0 },
          { x: 3, y: 0 },
          { x: 3, y: 2.5 },
          { x: -3, y: 2.5 },
        ],
        restSurfaceY: 2.5,
        materialId: 'water',
      },
    ]
    await engine.reload(engine.doc)
    let lastDebug = engine.fluids.debug[0]
    for (let i = 0; i < 360; i++) {
      engine.stepOnce()
      if (engine.fluids.debug.length) lastDebug = engine.fluids.debug[0]
    }
    const snap = engine.curr.find((b) => b.id === 'wood')!
    expect(snap.y).toBeGreaterThan(0.3)
    expect(snap.y).toBeLessThan(3.5)
    expect(lastDebug).toBeTruthy()
    expect(lastDebug!.area).toBeGreaterThan(0.05)
    const mass = snap.mass
    const expected = mass / (1000 * 1.0)
    const fraction = lastDebug!.area / 1.0
    expect(Math.abs(fraction - expected)).toBeLessThan(0.15)
    engine.world?.destroy()
  })
})

describe('analytic fluid helpers', () => {
  it('computes polygon area used for buoyancy', () => {
    const solver = new AnalyticFluidSolver()
    expect(solver).toBeTruthy()
    expect(polygonArea([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 0, y: 1 }])).toBeCloseTo(2)
    expect(getSolid('wood').density).toBe(600)
  })
})
