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

describe('float/sink pedagogical experiments (fluidRegions)', () => {
  function speed(b: { vx: number; vy: number }): number {
    return Math.hypot(b.vx, b.vy)
  }

  it('wood-splash: floats near the waterline after drop', async () => {
    const exp = EXPERIMENTS.find((e) => e.id === 'wood-splash')!.build()
    expect(exp.fluidRegions.length).toBe(1)
    expect(exp.fluidVolumes.length).toBe(0)
    const surfaceY = exp.fluidRegions[0]!.restSurfaceY
    const engine = new SimulationEngine(exp)
    await engine.init()
    engine.play()
    let maxSpeed = 0
    let hitFluid = false
    for (let i = 0; i < 300; i++) {
      engine.advance(1 / 60)
      const wood = engine.curr.find((b) => b.id === 'body:wood')!
      const sp = speed(wood)
      if (sp > maxSpeed) maxSpeed = sp
      if (engine.fluids.debug.some((d) => d.bodyId === 'body:wood')) hitFluid = true
    }
    const wood = engine.curr.find((b) => b.id === 'body:wood')!
    const finalSp = speed(wood)
    expect(hitFluid).toBe(true)
    // ρ_wood/ρ_water ≈ 0.6 → centro cerca de la superficie, no en el fondo.
    expect(wood.y).toBeGreaterThan(surfaceY - 0.5)
    expect(wood.y).toBeLessThan(surfaceY + 0.6)
    expect(finalSp).toBeLessThan(Math.max(2.0, maxSpeed * 0.6))
    engine.world?.destroy()
  })

  it('stone-sinks: dense body reaches near the pool floor', async () => {
    const exp = EXPERIMENTS.find((e) => e.id === 'stone-sinks')!.build()
    expect(exp.fluidRegions.length).toBe(1)
    expect(exp.fluidVolumes.length).toBe(0)
    const engine = new SimulationEngine(exp)
    await engine.init()
    engine.play()
    for (let i = 0; i < 300; i++) engine.advance(1 / 60)
    const rock = engine.curr.find((b) => b.id === 'body:rock')!
    expect(rock.y).toBeLessThan(0.7)
    expect(rock.y).toBeGreaterThan(0.15)
    engine.world?.destroy()
  })

  it('dual-drop: wood stays higher than stone', async () => {
    const exp = EXPERIMENTS.find((e) => e.id === 'dual-drop')!.build()
    expect(exp.fluidRegions.length).toBe(2)
    expect(exp.fluidVolumes.length).toBe(0)
    const engine = new SimulationEngine(exp)
    await engine.init()
    engine.play()
    for (let i = 0; i < 280; i++) engine.advance(1 / 60)
    const wood = engine.curr.find((b) => b.id === 'body:wood')!
    const rock = engine.curr.find((b) => b.id === 'body:rock')!
    expect(wood.y).toBeGreaterThan(rock.y + 0.25)
    expect(wood.y).toBeGreaterThan(0.45)
    expect(rock.y).toBeLessThan(0.85)
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

  it('applies no buoyant force when gravityScale is 0', async () => {
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
        y: 1.0,
        angle: 0,
        vx: 0,
        vy: 0,
        omega: 0,
        massMode: 'density',
        density: 600,
        friction: 0,
        restitution: 0,
        materialId: 'wood',
        gravityScale: 0,
        linearDamping: 0,
        angularDamping: 0,
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
    engine.stepOnce()
    const dbg = engine.fluids.debug.find((d) => d.bodyId === 'wood')
    expect(dbg).toBeTruthy()
    expect(dbg!.area).toBeGreaterThan(0.05)
    // At rest, drag ≈ 0; with gravityScale 0 Archimedes is 0 → net fluid force ≈ 0.
    expect(Math.hypot(dbg!.fx, dbg!.fy)).toBeLessThan(1e-6)
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

describe('Rapier coefficient combine rules', () => {
  type ColliderProbe = {
    frictionCombineRule(): number
    restitutionCombineRule(): number
  }
  type WorldColliders = { colliders: Map<string, ColliderProbe[]> }

  it('sets friction Min and restitution Max on every collider', async () => {
    const R = await loadRapier()
    const world = new RapierWorld(R, { x: 0, y: 0 }, PHYSICS_DT)
    const ice = getSolid('ice')
    const stone = getSolid('stone')
    world.addBody({
      id: 'ice',
      type: 'dynamic',
      translation: { x: 0, y: 1 },
      rotation: 0,
      colliders: [
        { shape: { kind: 'box', hx: 0.2, hy: 0.2 }, density: ice.density, friction: ice.friction, restitution: ice.restitution },
      ],
    })
    world.addBody({
      id: 'stone',
      type: 'fixed',
      translation: { x: 0, y: 0 },
      rotation: 0,
      colliders: [
        {
          shape: { kind: 'box', hx: 2, hy: 0.1 },
          density: stone.density,
          friction: stone.friction,
          restitution: stone.restitution,
        },
      ],
    })
    const cols = (world as unknown as WorldColliders).colliders
    for (const id of ['ice', 'stone'] as const) {
      const list = cols.get(id)!
      expect(list.length).toBeGreaterThan(0)
      for (const c of list) {
        expect(c.frictionCombineRule()).toBe(R.CoefficientCombineRule.Min)
        expect(c.restitutionCombineRule()).toBe(R.CoefficientCombineRule.Max)
      }
    }
    world.destroy()
  })

  it('ice vs stone slides like μ = min (not average)', async () => {
    const R = await loadRapier()
    const ice = getSolid('ice')
    const stone = getSolid('stone')
    const muMin = Math.min(ice.friction, stone.friction)
    const muAvg = (ice.friction + stone.friction) / 2
    expect(muMin).toBeLessThan(muAvg * 0.5)

    async function travelAfterSlide(muFloor: number, muBlock: number): Promise<number> {
      const world = new RapierWorld(R, { x: 0, y: -9.81 }, PHYSICS_DT)
      world.addBody({
        id: 'floor',
        type: 'fixed',
        translation: { x: 0, y: -0.1 },
        rotation: 0,
        colliders: [{ shape: { kind: 'box', hx: 20, hy: 0.1 }, density: 1, friction: muFloor, restitution: 0 }],
      })
      world.addBody({
        id: 'block',
        type: 'dynamic',
        translation: { x: 0, y: 0.25 },
        rotation: 0,
        lockRotation: true,
        linearDamping: 0,
        angularDamping: 0,
        colliders: [{ shape: { kind: 'box', hx: 0.25, hy: 0.25 }, density: 900, friction: muBlock, restitution: 0 }],
      })
      for (let i = 0; i < 30; i++) world.step()
      world.setVelocity('block', 5, 0, 0)
      const steps = Math.round(1.5 / PHYSICS_DT)
      for (let i = 0; i < steps; i++) world.step()
      const x = world.getBody('block')!.x
      world.destroy()
      return x
    }

    const withMaterials = await travelAfterSlide(stone.friction, ice.friction)
    const withAverage = await travelAfterSlide(muAvg, muAvg)
    // Min → μ_eff ≈ 0.05 slides much farther than Average → μ_eff ≈ 0.375.
    expect(withMaterials).toBeGreaterThan(withAverage * 1.5)
  })

  it('rubber vs metal bounces like e = max (not average)', async () => {
    const R = await loadRapier()
    const rubber = getSolid('rubber')
    const metal = getSolid('metal')
    const eMax = Math.max(rubber.restitution, metal.restitution)
    const eAvg = (rubber.restitution + metal.restitution) / 2
    expect(eMax).toBeGreaterThan(eAvg * 1.3)

    async function peakBounce(eFloor: number, eBall: number): Promise<number> {
      const dropY = 2
      const world = new RapierWorld(R, { x: 0, y: -9.81 }, PHYSICS_DT)
      world.addBody({
        id: 'floor',
        type: 'fixed',
        translation: { x: 0, y: -0.1 },
        rotation: 0,
        colliders: [{ shape: { kind: 'box', hx: 5, hy: 0.1 }, density: 1, friction: 0, restitution: eFloor }],
      })
      world.addBody({
        id: 'ball',
        type: 'dynamic',
        translation: { x: 0, y: dropY },
        rotation: 0,
        linearDamping: 0,
        angularDamping: 0,
        colliders: [{ shape: { kind: 'circle', radius: 0.2 }, density: 1100, friction: 0, restitution: eBall }],
      })
      let peak = 0
      let seenContact = false
      const steps = Math.round(3 / PHYSICS_DT)
      for (let i = 0; i < steps; i++) {
        world.step()
        const b = world.getBody('ball')!
        if (b.y < 0.4) seenContact = true
        if (seenContact && b.vy > 0) peak = Math.max(peak, b.y)
      }
      world.destroy()
      return peak
    }

    const withMaterials = await peakBounce(metal.restitution, rubber.restitution)
    const withAverage = await peakBounce(eAvg, eAvg)
    // Max → e_eff ≈ 0.75 reaches higher than Average → e_eff ≈ 0.475.
    expect(withMaterials).toBeGreaterThan(withAverage * 1.3)
    // Ideal rebound height scales ~ e²; Max should clear ~0.35 of drop height.
    expect(withMaterials).toBeGreaterThan(0.35 * 2)
  })
})
