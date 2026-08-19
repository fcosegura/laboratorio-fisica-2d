import { describe, expect, it } from 'vitest'
import { panCamera, screenToWorld, worldToScreen, zoomAt, type Camera } from './coords.ts'

const view = { width: 800, height: 600, dpr: 2 }

describe('coordinate transforms', () => {
  it('round-trips screen → world → screen for random cameras', () => {
    for (let i = 0; i < 200; i++) {
      const cam: Camera = {
        x: (Math.random() - 0.5) * 40,
        y: (Math.random() - 0.5) * 40,
        pixelsPerMeter: 4 + Math.random() * 500,
      }
      const screen = { x: Math.random() * view.width, y: Math.random() * view.height }
      const world = screenToWorld(screen, cam, view)
      const back = worldToScreen(world, cam, view)
      expect(Math.abs(back.x - screen.x)).toBeLessThan(1e-6)
      expect(Math.abs(back.y - screen.y)).toBeLessThan(1e-6)
    }
  })

  it('keeps the world point under the cursor fixed when zooming', () => {
    const cam: Camera = { x: 1.2, y: -0.4, pixelsPerMeter: 64 }
    const screen = { x: 220, y: 310 }
    const worldBefore = screenToWorld(screen, cam, view)
    const zoomed = zoomAt(cam, screen, view, 1.37)
    const worldAfter = screenToWorld(screen, zoomed, view)
    expect(Math.abs(worldAfter.x - worldBefore.x)).toBeLessThan(1e-6)
    expect(Math.abs(worldAfter.y - worldBefore.y)).toBeLessThan(1e-6)
  })

  it('panning by screen pixels moves the camera in world units', () => {
    const cam: Camera = { x: 0, y: 0, pixelsPerMeter: 50 }
    const panned = panCamera(cam, 100, 0)
    expect(panned.x).toBeCloseTo(-2, 10)
  })
})
