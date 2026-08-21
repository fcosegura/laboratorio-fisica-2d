import { beforeAll, describe, expect, it } from 'vitest'
import { PHYSICS_DT } from '../src/core/constants.ts'
import { dragToImpulse, IMPULSE_VELOCITY_PER_METER } from '../src/interaction/force.ts'
import { RapierWorld } from '../src/physics/adapters/rapier/RapierWorld.ts'
import { loadRapier } from '../src/physics/adapters/rapier/loadRapier.ts'
import { SimulationEngine } from '../src/sim/engine.ts'
import { emptyScene } from '../src/scene/document.ts'
import { EXPERIMENTS } from '../src/experiments/scenes.ts'
import { inverseTransformPoint, transformPoint } from '../src/core/math/transform.ts'
import type { BodyDesc } from '../src/physics/ports.ts'
import { reducedMass, springParamsForMasses } from '../src/scene/joints.ts'
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

function ball(id: string, x: number, y: number, extra: Partial<BodyDesc> = {}): BodyDesc {
  return {
    id,
    type: extra.type ?? 'dynamic',
    translation: { x, y },
    rotation: 0,
    gravityScale: extra.gravityScale ?? 0,
    linearDamping: 0,
    angularDamping: 0,
    colliders: [{ shape: { kind: 'circle', radius: 0.2 }, density: 1, friction: 0, restitution: 0 }],
    ...extra,
  }
}

describe('spring defaults', () => {
  it('uses reduced mass and scales stiffness ~400 μ', () => {
    expect(reducedMass(10, 10)).toBeCloseTo(5)
    expect(reducedMass(0, 8)).toBeCloseTo(8)
    expect(reducedMass(12, Infinity)).toBeCloseTo(12)
    const two = springParamsForMasses(10, 10)
    expect(two.stiffness).toBeCloseTo(400 * 5)
    expect(two.damping).toBeCloseTo(2 * Math.sqrt(two.stiffness * 5))
    const vsFixed = springParamsForMasses(0, 150)
    expect(vsFixed.stiffness).toBeCloseTo(400 * 150)
  })
})

describe('joints', () => {
  it('fixed keeps relative pose', async () => {
    const R = await loadRapier()
    const world = new RapierWorld(R, { x: 0, y: 0 }, PHYSICS_DT)
    world.addBody(ball('a', 0, 0))
    world.addBody(ball('b', 1, 0))
    world.addJoint({
      id: 'j',
      kind: 'fixed',
      bodyA: 'a',
      bodyB: 'b',
      anchorA: { x: 0.5, y: 0 },
      anchorB: { x: -0.5, y: 0 },
    })
    world.applyImpulse('a', 0, 4)
    for (let i = 0; i < 60; i++) world.step()
    const a = world.getBody('a')!
    const b = world.getBody('b')!
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(1, 1)
    expect(a.angle).toBeCloseTo(b.angle, 1)
    world.destroy()
  })

  it('revolute keeps anchors coincident', async () => {
    const exp = EXPERIMENTS.find((e) => e.id === 'pendulum')!.build()
    const engine = new SimulationEngine(exp)
    await engine.init()
    for (let i = 0; i < 90; i++) engine.stepOnce()
    const joint = engine.doc.joints[0]!
    const a = engine.curr.find((b) => b.id === joint.bodyA)!
    const b = engine.curr.find((c) => c.id === joint.bodyB)!
    const wa = transformPoint({ x: 0, y: 0 }, joint.anchorA, a)
    const wb = transformPoint({ x: 0, y: 0 }, joint.anchorB, b)
    expect(Math.hypot(wb.x - wa.x, wb.y - wa.y)).toBeLessThan(0.08)
    engine.world?.destroy()
  })

  it('rope does not exceed rest length', async () => {
    const R = await loadRapier()
    const world = new RapierWorld(R, { x: 0, y: 0 }, PHYSICS_DT)
    world.addBody(ball('a', 0, 0, { type: 'fixed' }))
    world.addBody(ball('b', 0.4, 0))
    world.addJoint({
      id: 'j',
      kind: 'rope',
      bodyA: 'a',
      bodyB: 'b',
      anchorA: { x: 0, y: 0 },
      anchorB: { x: 0, y: 0 },
      restLength: 1,
    })
    world.applyImpulse('b', 12, 0)
    for (let i = 0; i < 120; i++) world.step()
    const b = world.getBody('b')!
    expect(Math.hypot(b.x, b.y)).toBeLessThan(1.12)
    world.destroy()
  })

  it('spring pulls toward rest length', async () => {
    const R = await loadRapier()
    const world = new RapierWorld(R, { x: 0, y: 0 }, PHYSICS_DT)
    world.addBody(ball('a', 0, 0, { type: 'fixed' }))
    world.addBody(ball('b', 2, 0))
    const params = springParamsForMasses(0, world.getBody('b')!.mass)
    world.addJoint({
      id: 'j',
      kind: 'spring',
      bodyA: 'a',
      bodyB: 'b',
      anchorA: { x: 0, y: 0 },
      anchorB: { x: 0, y: 0 },
      restLength: 1,
      stiffness: params.stiffness,
      damping: params.damping,
    })
    for (let i = 0; i < 30; i++) world.step()
    const b = world.getBody('b')!
    expect(b.x).toBeLessThan(1.9)
    world.destroy()
  })

  it('in-place revolute between separated bodies does not collapse centers', async () => {
    const R = await loadRapier()
    const world = new RapierWorld(R, { x: 0, y: 0 }, PHYSICS_DT)
    world.addBody(ball('a', 0, 0))
    world.addBody(ball('b', 3, 0))
    const poseA = { x: 0, y: 0, angle: 0 }
    const poseB = { x: 3, y: 0, angle: 0 }
    const shared = transformPoint({ x: 0, y: 0 }, { x: 0, y: 0 }, poseA)
    const anchorB = inverseTransformPoint({ x: 0, y: 0 }, shared, poseB)
    world.addJoint({
      id: 'j',
      kind: 'revolute',
      bodyA: 'a',
      bodyB: 'b',
      anchorA: { x: 0, y: 0 },
      anchorB,
    })
    for (let i = 0; i < 60; i++) world.step()
    const a = world.getBody('a')!
    const b = world.getBody('b')!
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThan(2.5)
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(3, 1)
    const wa = transformPoint({ x: 0, y: 0 }, { x: 0, y: 0 }, a)
    const wb = transformPoint({ x: 0, y: 0 }, anchorB, b)
    expect(Math.hypot(wb.x - wa.x, wb.y - wa.y)).toBeLessThan(0.08)
    world.destroy()
  })

  it('in-place weld between separated, rotated bodies does not yank them together', async () => {
    const R = await loadRapier()
    const world = new RapierWorld(R, { x: 0, y: 0 }, PHYSICS_DT)
    const angleB = Math.PI / 2
    world.addBody({ ...ball('a', 0, 0), rotation: 0 })
    world.addBody({ ...ball('b', 2, 0), rotation: angleB })
    const poseA = { x: 0, y: 0, angle: 0 }
    const poseB = { x: 2, y: 0, angle: angleB }
    const shared = transformPoint({ x: 0, y: 0 }, { x: 0, y: 0 }, poseA)
    const anchorB = inverseTransformPoint({ x: 0, y: 0 }, shared, poseB)
    world.addJoint({
      id: 'j',
      kind: 'fixed',
      bodyA: 'a',
      bodyB: 'b',
      anchorA: { x: 0, y: 0 },
      anchorB,
      frameA: 0,
      frameB: poseA.angle - poseB.angle,
    })
    world.applyImpulse('a', 0, 3)
    for (let i = 0; i < 60; i++) world.step()
    const a = world.getBody('a')!
    const b = world.getBody('b')!
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThan(1.5)
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(2, 1)
    let d = b.angle - a.angle
    while (d > Math.PI) d -= Math.PI * 2
    while (d < -Math.PI) d += Math.PI * 2
    expect(d).toBeCloseTo(angleB, 1)
    world.destroy()
  })

  it('mass-scaled spring does not hang infinitely under gravity', async () => {
    const R = await loadRapier()
    const world = new RapierWorld(R, { x: 0, y: -9.81 }, PHYSICS_DT)
    world.addBody(ball('a', 0, 4, { type: 'fixed' }))
    world.addBody({
      ...ball('b', 0, 2),
      gravityScale: 1,
      colliders: [{ shape: { kind: 'box', hx: 0.25, hy: 0.25 }, mass: 150, friction: 0, restitution: 0 }],
    })
    const params = springParamsForMasses(0, world.getBody('b')!.mass)
    world.addJoint({
      id: 'j',
      kind: 'spring',
      bodyA: 'a',
      bodyB: 'b',
      anchorA: { x: 0, y: 0 },
      anchorB: { x: 0, y: 0 },
      restLength: 2,
      stiffness: params.stiffness,
      damping: params.damping,
    })
    for (let i = 0; i < 180; i++) world.step()
    const b = world.getBody('b')!
    expect(b.y).toBeGreaterThan(1.5)
    expect(b.y).toBeLessThan(2.3)
    world.destroy()
  })

  it('addJoint ignores missing bodies and duplicate ids', async () => {
    const R = await loadRapier()
    const world = new RapierWorld(R, { x: 0, y: 0 }, PHYSICS_DT)
    world.addBody(ball('a', 0, 0))
    world.addJoint({
      id: 'j',
      kind: 'rope',
      bodyA: 'a',
      bodyB: 'missing',
      anchorA: { x: 0, y: 0 },
      anchorB: { x: 0, y: 0 },
      restLength: 1,
    })
    world.applyImpulse('a', 3, 0)
    world.step()
    expect(world.getBody('a')!.vx).toBeGreaterThan(1)
    world.setVelocity('a', 0, 0, 0)
    world.setTransform('a', 0, 0, 0)
    world.addBody(ball('b', 1, 0))
    const desc = {
      id: 'j',
      kind: 'fixed' as const,
      bodyA: 'a',
      bodyB: 'b',
      anchorA: { x: 0.5, y: 0 },
      anchorB: { x: -0.5, y: 0 },
    }
    world.addJoint(desc)
    world.addJoint(desc)
    world.applyImpulse('a', 0, 3)
    for (let i = 0; i < 30; i++) world.step()
    const a = world.getBody('a')!
    const b = world.getBody('b')!
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(1, 1)
    world.destroy()
  })
})

describe('storm-boat experiment', () => {
  it('keeps the hull near the waterline under buoyancy', async () => {
    const exp = EXPERIMENTS.find((e) => e.id === 'storm-boat')!.build()
    const engine = new SimulationEngine(exp)
    await engine.init()
    for (let i = 0; i < 180; i++) engine.stepOnce()
    const hull = engine.curr.find((b) => b.id === 'body:hull')!
    const surfaceY = exp.fluidRegions[0]!.restSurfaceY
    // Densidad 450 vs agua 1000 → debe flotar, no hundirse al fondo.
    expect(hull.y).toBeGreaterThan(surfaceY - 0.8)
    expect(hull.y).toBeLessThan(surfaceY + 1.2)
    expect(engine.world?.hasBody('body:cabin')).toBe(true)
    engine.world?.destroy()
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

describe('picking while paused', () => {
  it('hits the ground before any physics step', async () => {
    const engine = new SimulationEngine(emptyScene())
    await engine.init()
    expect(engine.clock.playing).toBe(false)
    expect(engine.bodyAt(0, -0.25)).toBe('body:ground')
    engine.world?.destroy()
  })

  it('still hits a sleeping body after the sim has run and paused', async () => {
    const engine = new SimulationEngine(emptyScene())
    await engine.init()
    for (let i = 0; i < 60; i++) engine.stepOnce()
    expect(engine.clock.playing).toBe(false)
    expect(engine.bodyAt(0, -0.25)).toBe('body:ground')
    engine.world?.destroy()
  })
})

describe('init session guard', () => {
  it('skips rebuild when isCurrent returns false after WASM load', async () => {
    const engine = new SimulationEngine(emptyScene())
    await engine.init(() => false)
    expect(engine.world).toBeNull()
  })

  it('does not destroy an existing world when a stale init finishes', async () => {
    const engine = new SimulationEngine(emptyScene())
    await engine.init()
    const live = engine.world
    expect(live).toBeTruthy()
    await engine.init(() => false)
    expect(engine.world).toBe(live)
    expect(engine.world?.hasBody('body:ground')).toBe(true)
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
