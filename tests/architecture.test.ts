import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..', 'src')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p)
  }
  return out
}

function importsOf(src: string): string[] {
  const re = /from\s+['"]([^'"]+)['"]/g
  const found: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) found.push(m[1]!)
  return found
}

function layer(file: string): string {
  const rel = relative(ROOT, file).replaceAll('\\', '/')
  return rel.split('/')[0] ?? ''
}

describe('architecture boundaries', () => {
  const files = walk(ROOT)

  it('core does not import other layers', () => {
    for (const file of files.filter((f) => layer(f) === 'core')) {
      for (const spec of importsOf(readFileSync(file, 'utf8'))) {
        expect(spec, file).not.toMatch(/physics|fluids|render|ui|sim|scene|pixi|react|rapier/)
      }
    }
  })

  it('physics does not import render, ui, sim, pixi or react', () => {
    for (const file of files.filter((f) => layer(f) === 'physics')) {
      for (const spec of importsOf(readFileSync(file, 'utf8'))) {
        expect(spec, file).not.toMatch(/render|\/ui\/|pixi\.js|react/)
        expect(spec, file).not.toMatch(/\/sim\//)
      }
    }
  })

  it('sim does not import pixi, react or render', () => {
    for (const file of files.filter((f) => layer(f) === 'sim')) {
      for (const spec of importsOf(readFileSync(file, 'utf8'))) {
        expect(spec, file).not.toMatch(/pixi\.js|react|\/render\//)
      }
    }
  })

  it('render does not import rapier or react', () => {
    for (const file of files.filter((f) => layer(f) === 'render')) {
      for (const spec of importsOf(readFileSync(file, 'utf8'))) {
        expect(spec, file).not.toMatch(/rapier|react/)
      }
    }
  })

  it('ui does not import rapier or pixi', () => {
    for (const file of files.filter((f) => layer(f) === 'ui')) {
      for (const spec of importsOf(readFileSync(file, 'utf8'))) {
        expect(spec, file).not.toMatch(/rapier|pixi\.js/)
      }
    }
  })
})
