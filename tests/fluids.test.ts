import { describe, expect, it } from 'vitest'
import {
  capsuleToPolygon,
  clipHalfPlane,
  polygonArea,
  polygonCentroid,
} from '../src/core/math/polygon.ts'
import {
  DEFAULT_DRAG_CD,
  STOKES_DRAG_K,
  TORQUE_DRAG_C,
  fluidDragForce,
  fluidTorqueDamp,
  planeSpan,
  projectedSpan,
  restPlaneD,
} from '../src/fluids/analytic/AnalyticFluid.ts'
import { getFluid } from '../src/materials/catalog.ts'

describe('hydrostatic clipping', () => {
  it('submerged rectangle of height h has area w*h and centroid at h/2', () => {
    const rect = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 3 },
      { x: 0, y: 3 },
    ]
    const clipped = clipHalfPlane(rect, 0, 1, 1.2)
    expect(polygonArea(clipped)).toBeCloseTo(2.4, 6)
    const c = polygonCentroid(clipped)
    expect(c.x).toBeCloseTo(1, 6)
    expect(c.y).toBeCloseTo(0.6, 6)
  })

  it('clips along −g, not a hardcoded horizontal plane', () => {
    const rect = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
    ]
    const gx = 1
    const gy = 0
    const nx = -gx
    const ny = -gy
    const clipped = clipHalfPlane(rect, nx, ny, nx * 1)
    expect(polygonArea(clipped)).toBeCloseTo(2, 5)
  })
})

describe('capsule stadium', () => {
  it('approximates 2 r (2 h) + π r², not a circle of max(h, r)', () => {
    const h = 1
    const r = 0.25
    const poly = capsuleToPolygon(0, 0, h, r, 0, 24)
    const area = polygonArea(poly)
    const stadium = 4 * h * r + Math.PI * r * r
    const circleMax = Math.PI * Math.max(h, r) ** 2
    expect(Math.abs(area - stadium) / stadium).toBeLessThan(0.05)
    expect(Math.abs(area - circleMax) / circleMax).toBeGreaterThan(0.5)
  })
})

describe('planeSpan', () => {
  it('matches the x-span of a horizontal free surface', () => {
    const tank = [
      { x: -3, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 2.5 },
      { x: -3, y: 2.5 },
    ]
    expect(planeSpan(tank, 0, 1, 2.5)).toBeCloseTo(6, 6)
  })
})

describe('restPlaneD (C4)', () => {
  const tank = [
    { x: -3, y: 0 },
    { x: 3, y: 0 },
    { x: 3, y: 2.5 },
    { x: -3, y: 2.5 },
  ]

  it('preserves restSurfaceY when g ∥ −Y (n̂ = +Y)', () => {
    expect(restPlaneD(tank, 0, 1, 2.2)).toBeCloseTo(2.2, 6)
    expect(restPlaneD(tank, 0, 1, 1.0)).toBeCloseTo(1.0, 6)
  })

  it('maps fill fraction along n̂ when gravity is horizontal', () => {
    // g = (+|g|, 0) → n̂ = (−1, 0). Fill 2.2/2.5 of tank along n̂.
    const d = restPlaneD(tank, -1, 0, 2.2)
    const fillFrac = 2.2 / 2.5
    // s = −x ∈ [−3, 3]; d = sMin + fillFrac*(sMax−sMin)
    expect(d).toBeCloseTo(-3 + fillFrac * 6, 6)
    // Fluid half-plane −x ≤ d ⇒ x ≥ −d occupies the +X (downstream) side.
    const fluidArea = polygonArea(clipHalfPlane(tank, -1, 0, d))
    expect(fluidArea).toBeGreaterThan(0.5 * 6 * 2.5)
    expect(fluidArea).toBeLessThan(0.95 * 6 * 2.5)
  })

  it('keeps free-surface normal aligned with −g for tilted gravity', () => {
    const nx = -Math.SQRT1_2
    const ny = Math.SQRT1_2
    const d = restPlaneD(tank, nx, ny, 2.0)
    const clipped = clipHalfPlane(tank, nx, ny, d)
    expect(polygonArea(clipped)).toBeGreaterThan(1)
    // Every kept vertex satisfies n·p ≤ d + eps (semiplane coherent with n̂).
    for (const p of clipped) {
      expect(nx * p.x + ny * p.y).toBeLessThanOrEqual(d + 1e-6)
    }
  })
})

describe('projectedSpan / fluidDragForce (C3)', () => {
  it('projects box width perpendicular to flow', () => {
    const box = [
      { x: -0.5, y: -0.25 },
      { x: 0.5, y: -0.25 },
      { x: 0.5, y: 0.25 },
      { x: -0.5, y: 0.25 },
    ]
    // Flow +X → ⊥ is +Y → height 0.5
    expect(projectedSpan(box, 0, 1)).toBeCloseTo(0.5, 6)
    // Flow +Y → ⊥ is +X → width 1.0
    expect(projectedSpan(box, 1, 0)).toBeCloseTo(1.0, 6)
  })

  it('quadratic term uses Cd ρ A_proj; Stokes does not dominate water at lab scale', () => {
    const water = getFluid('water')
    const poly = [
      { x: -0.4, y: -0.3 },
      { x: 0.4, y: -0.3 },
      { x: 0.4, y: 0.3 },
      { x: -0.4, y: 0.3 },
    ]
    const area = 0.8 * 0.6
    const v = 1
    const f = fluidDragForce(v, 0, water.density, water.viscosity, poly, area)
    const aProj = 0.6
    const L = Math.sqrt(area)
    const quad = 0.5 * DEFAULT_DRAG_CD * water.density * aProj * v * v
    const stokes = STOKES_DRAG_K * water.viscosity * L * v
    expect(Math.abs(f.x)).toBeCloseTo(quad + stokes, 4)
    expect(stokes / quad).toBeLessThan(0.01)
  })

  it('honey linear drag dwarfs water at the same pose and speed', () => {
    const water = getFluid('water')
    const honey = getFluid('honey')
    const poly = [
      { x: -0.4, y: -0.3 },
      { x: 0.4, y: -0.3 },
      { x: 0.4, y: 0.3 },
      { x: -0.4, y: 0.3 },
    ]
    const area = 0.8 * 0.6
    const fw = fluidDragForce(1, 0, water.density, water.viscosity, poly, area)
    const fh = fluidDragForce(1, 0, honey.density, honey.viscosity, poly, area)
    expect(Math.abs(fh.x)).toBeGreaterThan(Math.abs(fw.x) * 1.2)
  })
})

describe('fluidTorqueDamp (C5)', () => {
  it('scales as ρ A R² with R² := A (≈ L⁴ for similar shapes)', () => {
    const rho = 1000
    const omega = 2
    const smallA = 0.25
    const largeA = 1.0 // 2× linear → 4× area
    const tSmall = fluidTorqueDamp(rho, smallA, omega)
    const tLarge = fluidTorqueDamp(rho, largeA, omega)
    expect(tSmall).toBeCloseTo(-TORQUE_DRAG_C * rho * smallA * smallA * omega, 10)
    // A·R² = A² → ratio (4)² = 16; acceptance is order-of-magnitude (~4× or more).
    expect(Math.abs(tLarge / tSmall)).toBeGreaterThan(8)
    expect(Math.abs(tLarge / tSmall)).toBeCloseTo(16, 8)
  })
})

describe('zero gravity fluid', () => {
  it('applies drag but no buoyancy when |g| ≈ 0', async () => {
    const { SimulationEngine } = await import('../src/sim/engine.ts')
    const { emptyScene, GRAVITY_PRESETS } = await import('../src/scene/document.ts')
    const doc = emptyScene()
    doc.world.gravity = { ...GRAVITY_PRESETS.zero }
    doc.world.gravityPreset = 'zero'
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
        id: 'body:slug',
        name: 'Slug',
        type: 'dynamic',
        x: 0,
        y: 1.0,
        angle: 0,
        vx: 4,
        vy: 0,
        omega: 0,
        massMode: 'density',
        density: 600,
        friction: 0,
        restitution: 0,
        materialId: 'wood',
        gravityScale: 1,
        linearDamping: 0,
        angularDamping: 0,
        ccd: false,
        locked: false,
        lockRotation: false,
        shape: { kind: 'box', hx: 0.4, hy: 0.3 },
      },
    ]
    doc.fluidRegions = [
      {
        id: 'fluid:1',
        name: 'Agua',
        polygon: [
          { x: -3, y: 0 },
          { x: 3, y: 0 },
          { x: 3, y: 2.2 },
          { x: -3, y: 2.2 },
        ],
        restSurfaceY: 2.2,
        materialId: 'water',
      },
    ]
    const engine = new SimulationEngine(doc)
    await engine.init()
    engine.play()
    for (let i = 0; i < 90; i++) engine.advance(1 / 60)
    const slug = engine.curr.find((b) => b.id === 'body:slug')!
    expect(engine.fluids.samples.length).toBe(1)
    expect(engine.fluids.debug.some((d) => d.bodyId === 'body:slug')).toBe(true)
    // Drag should have slowed the slug; without fluid it would still be ≈ 4 m/s.
    expect(Math.abs(slug.vx)).toBeLessThan(3.2)
    // No net buoyancy in zero-g → y should stay near the start (tiny numerical drift only).
    expect(Math.abs(slug.y - 1.0)).toBeLessThan(0.15)
    engine.world?.destroy()
  })
})

describe('viscosity drag across fluids (C3)', () => {
  async function coastSpeed(materialId: 'water' | 'oil' | 'honey'): Promise<number> {
    const { SimulationEngine } = await import('../src/sim/engine.ts')
    const { emptyScene, GRAVITY_PRESETS } = await import('../src/scene/document.ts')
    const doc = emptyScene()
    // Zero-g: isolate drag (no buoyancy / no terminal from weight).
    doc.world.gravity = { ...GRAVITY_PRESETS.zero }
    doc.world.gravityPreset = 'zero'
    doc.bodies = [
      {
        id: 'body:slug',
        name: 'Slug',
        type: 'dynamic',
        x: 0,
        y: 1.0,
        angle: 0,
        vx: 3,
        vy: 0,
        omega: 0,
        massMode: 'density',
        density: 600,
        friction: 0,
        restitution: 0,
        materialId: 'wood',
        gravityScale: 1,
        linearDamping: 0,
        angularDamping: 0,
        ccd: false,
        locked: false,
        lockRotation: true,
        shape: { kind: 'box', hx: 0.35, hy: 0.25 },
      },
    ]
    doc.fluidRegions = [
      {
        id: 'fluid:1',
        name: materialId,
        polygon: [
          { x: -4, y: 0 },
          { x: 4, y: 0 },
          { x: 4, y: 2.2 },
          { x: -4, y: 2.2 },
        ],
        restSurfaceY: 2.0,
        materialId,
      },
    ]
    const engine = new SimulationEngine(doc)
    await engine.init()
    engine.play()
    for (let i = 0; i < 90; i++) engine.advance(1 / 60)
    const slug = engine.curr.find((b) => b.id === 'body:slug')!
    const speed = Math.hypot(slug.vx, slug.vy)
    engine.world?.destroy()
    return speed
  }

  it('honey slows a coasting body clearly vs water; oil drag ≥ water at equal speed', async () => {
    const vWater = await coastSpeed('water')
    const vHoney = await coastSpeed('honey')
    expect(vWater).toBeGreaterThan(0.05)
    expect(vHoney).toBeLessThan(vWater * 0.55)

    // Thin plate ⊥ flow: small A_proj so Stokes (μ) wins over ρ at moderate lab speeds.
    const water = getFluid('water')
    const oil = getFluid('oil')
    const poly = [
      { x: -0.4, y: -0.05 },
      { x: 0.4, y: -0.05 },
      { x: 0.4, y: 0.05 },
      { x: -0.4, y: 0.05 },
    ]
    const area = 0.8 * 0.1
    const fw = fluidDragForce(0.03, 0, water.density, water.viscosity, poly, area)
    const fo = fluidDragForce(0.03, 0, oil.density, oil.viscosity, poly, area)
    expect(Math.abs(fo.x)).toBeGreaterThan(Math.abs(fw.x))
  })
})

describe('tilted gravity free surface (C4)', () => {
  it('clips fluid with n̂ = −ĝ when gravity is horizontal', async () => {
    const { SimulationEngine } = await import('../src/sim/engine.ts')
    const { emptyScene } = await import('../src/scene/document.ts')
    const doc = emptyScene()
    doc.world.gravity = { x: 9.81, y: 0 }
    doc.world.gravityPreset = 'custom'
    doc.bodies = [
      {
        id: 'body:slug',
        name: 'Slug',
        type: 'dynamic',
        x: 1.5,
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
        gravityScale: 1,
        linearDamping: 0,
        angularDamping: 0,
        ccd: false,
        locked: false,
        lockRotation: true,
        shape: { kind: 'box', hx: 0.3, hy: 0.3 },
      },
    ]
    doc.fluidRegions = [
      {
        id: 'fluid:1',
        name: 'Agua',
        polygon: [
          { x: -3, y: 0 },
          { x: 3, y: 0 },
          { x: 3, y: 2.5 },
          { x: -3, y: 2.5 },
        ],
        restSurfaceY: 2.0,
        materialId: 'water',
      },
    ]
    const engine = new SimulationEngine(doc)
    await engine.init()
    engine.stepOnce()
    const sample = engine.fluids.samples[0]!
    expect(sample.clipNx).toBeCloseTo(-1, 5)
    expect(sample.clipNy).toBeCloseTo(0, 5)
    // Old bug dRest = ny*restSurfaceY = 0 would put the plane at x=0; fill 2/2.5 ≠ half.
    const expectedD = restPlaneD(doc.fluidRegions[0]!.polygon, -1, 0, 2.0)
    expect(sample.clipD).toBeGreaterThan(expectedD - 0.5)
    expect(Math.abs(sample.clipD - 0)).toBeGreaterThan(0.5)
    expect(engine.fluids.debug.some((d) => d.bodyId === 'body:slug')).toBe(true)
    engine.world?.destroy()
  })
})
