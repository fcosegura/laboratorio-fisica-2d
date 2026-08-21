import { describe, expect, it } from 'vitest'
import {
  capsuleToPolygon,
  clipHalfPlane,
  polygonArea,
  polygonCentroid,
} from '../src/core/math/polygon.ts'
import { planeSpan } from '../src/fluids/analytic/AnalyticFluid.ts'

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
