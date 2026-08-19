export class RingBuffer {
  readonly data: Float32Array
  readonly capacity: number
  length = 0
  private head = 0

  constructor(capacity: number) {
    this.capacity = capacity
    this.data = new Float32Array(capacity)
  }

  push(value: number): void {
    this.data[this.head] = value
    this.head = (this.head + 1) % this.capacity
    if (this.length < this.capacity) this.length += 1
  }

  /** Oldest → newest copy into `out` (must have length >= this.length). */
  copyChronological(out: Float32Array): number {
    const n = this.length
    if (n === 0) return 0
    const start = this.length === this.capacity ? this.head : 0
    for (let i = 0; i < n; i++) {
      out[i] = this.data[(start + i) % this.capacity]!
    }
    return n
  }

  last(): number | undefined {
    if (this.length === 0) return undefined
    const i = (this.head - 1 + this.capacity) % this.capacity
    return this.data[i]
  }

  clear(): void {
    this.length = 0
    this.head = 0
  }
}
