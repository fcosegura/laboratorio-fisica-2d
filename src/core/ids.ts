export type BodyId = string
export type ColliderId = string
export type JointId = string
export type FluidRegionId = string
export type MaterialId = string

export class IdFactory {
  private n: number

  constructor(start = 0) {
    this.n = start
  }

  next(prefix: string): string {
    this.n += 1
    return `${prefix}:${this.n}`
  }

  peek(): number {
    return this.n
  }

  reset(n = 0): void {
    this.n = n
  }
}

export function asBodyId(id: string): BodyId {
  return id
}
