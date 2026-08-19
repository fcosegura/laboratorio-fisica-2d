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

  seedMax(ids: string[]): void {
    for (const id of ids) {
      const match = id.match(/:(\d+)$/)
      if (match && match[1]) {
        const num = Number.parseInt(match[1], 10)
        if (Number.isFinite(num) && num > this.n) {
          this.n = num
        }
      }
    }
  }
}

export function asBodyId(id: string): BodyId {
  return id
}
