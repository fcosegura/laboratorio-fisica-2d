import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('LabRuntime interaction wiring', () => {
  it('reduceDown receives poseOf from the live interpolated snapshot', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'app', 'LabRuntime.ts'), 'utf8')
    // Pointer input lives in LabInput and reaches the runtime's poseOf through `this.lab`.
    const input = readFileSync(join(import.meta.dirname, '..', 'src', 'app', 'LabInput.ts'), 'utf8')
    expect(input).toMatch(/poseOf:\s*\(id\)\s*=>\s*this\.lab\.poseOf\(id\)/)
    expect(src).toMatch(/this\.engine\.interpolated\(id\)/)
    expect(src).not.toMatch(/patchBody/)
    expect(input).not.toMatch(/patchBody/)
  })

  it('pushUi syncs fluid selection, options and AABB overlap warning to the store', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'app', 'LabRuntime.ts'), 'utf8')
    expect(src).toMatch(/selectedFluidRegion:\s*selectedFluid\s*\?\s*structuredClone\(selectedFluid\)/)
    expect(src).toMatch(/fluidRegionOptions:\s*this\.engine\.doc\.fluidRegions\.map/)
    expect(src).toMatch(/fluidOverlapWarning:\s*fluidOverlapWarning\(/)
    expect(src).toMatch(/from '\.\.\/scene\/fluidOverlap\.ts'/)
  })
})
