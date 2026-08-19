import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('LabRuntime interaction wiring', () => {
  it('reduceDown receives poseOf from the live interpolated snapshot', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'app', 'LabRuntime.ts'), 'utf8')
    expect(src).toMatch(/poseOf:\s*\(id\)\s*=>\s*this\.poseOf\(id\)/)
    expect(src).toMatch(/this\.engine\.interpolated\(id\)/)
    expect(src).not.toMatch(/patchBody/)
  })
})
