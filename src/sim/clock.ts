import { MAX_FRAME_DT, MAX_STEPS_PER_FRAME, PHYSICS_DT } from '../core/constants.ts'

export type ClockState = {
  playing: boolean
  timeScale: number
  accumulator: number
  simTime: number
  alpha: number
  stepsTaken: number
  stepsDropped: number
}

export class Clock {
  playing = false
  timeScale = 1
  accumulator = 0
  simTime = 0
  alpha = 1
  stepsDropped = 0
  readonly dt = PHYSICS_DT

  reset(): void {
    this.accumulator = 0
    this.simTime = 0
    this.alpha = 1
    this.stepsDropped = 0
  }

  /** Consume real frame dt; returns how many physics steps to run. */
  advance(frameDt: number): number {
    if (!this.playing) {
      this.alpha = 1
      return 0
    }
    let dt = Math.min(Math.max(frameDt, 0), MAX_FRAME_DT) * this.timeScale
    this.accumulator += dt
    let steps = 0
    while (this.accumulator >= this.dt && steps < MAX_STEPS_PER_FRAME) {
      this.accumulator -= this.dt
      this.simTime += this.dt
      steps += 1
    }
    if (this.accumulator >= this.dt) {
      this.stepsDropped += 1
      this.accumulator = 0
    }
    this.alpha = this.accumulator / this.dt
    return steps
  }

  stepOnce(): number {
    this.simTime += this.dt
    this.accumulator = 0
    this.alpha = 1
    return 1
  }
}
