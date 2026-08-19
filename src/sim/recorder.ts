import type { BodyId } from '../core/ids.ts'
import { RingBuffer } from '../core/ringBuffer.ts'
import { DEFAULT_RECORDER_HZ, DEFAULT_RECORDER_SECONDS } from '../core/constants.ts'
import type { BodySnapshot } from '../physics/ports.ts'

export const RecorderChannel = {
  time: 'time',
  x: 'x',
  y: 'y',
  vx: 'vx',
  vy: 'vy',
  ax: 'ax',
  ay: 'ay',
  speed: 'speed',
  kinetic: 'kinetic',
  potential: 'potential',
  energy: 'energy',
  px: 'px',
  py: 'py',
} as const
export type RecorderChannel = (typeof RecorderChannel)[keyof typeof RecorderChannel]

export const CHANNEL_LABELS: Record<RecorderChannel, string> = {
  time: 't (s)',
  x: 'x (m)',
  y: 'y (m)',
  vx: 'vx (m/s)',
  vy: 'vy (m/s)',
  ax: 'ax (m/s²)',
  ay: 'ay (m/s²)',
  speed: '|v| (m/s)',
  kinetic: 'Ec (J)',
  potential: 'Ep (J)',
  energy: 'E (J)',
  px: 'px (kg·m/s)',
  py: 'py (kg·m/s)',
}

type Track = {
  id: BodyId
  prevVx: number
  prevVy: number
  buffers: Record<RecorderChannel, RingBuffer>
}

export class DataRecorder {
  private tracks = new Map<BodyId, Track>()
  private sampleEvery: number
  private tick = 0
  readonly capacity: number

  constructor(seconds = DEFAULT_RECORDER_SECONDS, hz = DEFAULT_RECORDER_HZ) {
    this.capacity = seconds * hz
    this.sampleEvery = 1
  }

  observe(id: BodyId): void {
    if (this.tracks.has(id)) return
    const buffers = {} as Record<RecorderChannel, RingBuffer>
    for (const key of Object.keys(CHANNEL_LABELS) as RecorderChannel[]) {
      buffers[key] = new RingBuffer(this.capacity)
    }
    this.tracks.set(id, { id, prevVx: 0, prevVy: 0, buffers })
  }

  unobserve(id: BodyId): void {
    this.tracks.delete(id)
  }

  clear(): void {
    for (const t of this.tracks.values()) {
      for (const b of Object.values(t.buffers)) b.clear()
      t.prevVx = 0
      t.prevVy = 0
    }
    this.tick = 0
  }

  ids(): BodyId[] {
    return [...this.tracks.keys()]
  }

  sample(time: number, dt: number, gy: number, bodies: Iterable<BodySnapshot>): void {
    this.tick++
    if (this.tick % this.sampleEvery !== 0) return
    for (const body of bodies) {
      const track = this.tracks.get(body.id)
      if (!track) continue
      const ax = (body.vx - track.prevVx) / dt
      const ay = (body.vy - track.prevVy) / dt
      track.prevVx = body.vx
      track.prevVy = body.vy
      const kinetic = 0.5 * body.mass * (body.vx * body.vx + body.vy * body.vy) + 0.5 * body.inertia * body.omega * body.omega
      const potential = body.mass * Math.abs(gy) * body.y
      const push = (ch: RecorderChannel, v: number) => track.buffers[ch].push(v)
      push('time', time)
      push('x', body.x)
      push('y', body.y)
      push('vx', body.vx)
      push('vy', body.vy)
      push('ax', ax)
      push('ay', ay)
      push('speed', Math.hypot(body.vx, body.vy))
      push('kinetic', kinetic)
      push('potential', potential)
      push('energy', kinetic + potential)
      push('px', body.mass * body.vx)
      push('py', body.mass * body.vy)
    }
  }

  series(id: BodyId, channel: RecorderChannel): { t: Float32Array; y: Float32Array; n: number } {
    const track = this.tracks.get(id)
    if (!track) return { t: new Float32Array(), y: new Float32Array(), n: 0 }
    const n = track.buffers.time.length
    const t = new Float32Array(n)
    const y = new Float32Array(n)
    track.buffers.time.copyChronological(t)
    track.buffers[channel].copyChronological(y)
    return { t, y, n }
  }
}
