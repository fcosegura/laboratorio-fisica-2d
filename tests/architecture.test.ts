import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..', 'src')

/** layer → forbidden import targets (other layers or packages). */
const FORBIDDEN: Record<string, readonly string[]> = {
  core: [
    'physics',
    'fluids',
    'render',
    'ui',
    'sim',
    'scene',
    'interaction',
    'camera',
    'materials',
    'experiments',
    'app',
    'pixi',
    'react',
    'rapier',
  ],
  physics: [
    'fluids',
    'render',
    'ui',
    'sim',
    'scene',
    'interaction',
    'camera',
    'materials',
    'experiments',
    'app',
    'pixi',
    'react',
  ],
  sim: ['render', 'ui', 'app', 'interaction', 'camera', 'experiments', 'pixi', 'react'],
  render: ['rapier', 'react', 'ui', 'app', 'physics', 'fluids', 'experiments'],
  ui: ['rapier', 'pixi', 'physics', 'sim', 'render', 'fluids'],
  scene: [
    'rapier',
    'pixi',
    'react',
    'ui',
    'render',
    'sim',
    'app',
    'fluids',
    'interaction',
    'camera',
    'experiments',
  ],
  app: ['rapier', 'pixi'],
  interaction: [
    'rapier',
    'pixi',
    'react',
    'ui',
    'render',
    'sim',
    'app',
    'fluids',
    'physics',
    'camera',
    'materials',
    'experiments',
  ],
  fluids: [
    'rapier',
    'pixi',
    'react',
    'ui',
    'render',
    'sim',
    'app',
    'interaction',
    'camera',
    'experiments',
  ],
  camera: [
    'physics',
    'fluids',
    'render',
    'ui',
    'sim',
    'scene',
    'interaction',
    'materials',
    'experiments',
    'app',
    'pixi',
    'react',
    'rapier',
  ],
  materials: [
    'physics',
    'fluids',
    'render',
    'ui',
    'sim',
    'scene',
    'interaction',
    'camera',
    'experiments',
    'app',
    'pixi',
    'react',
    'rapier',
  ],
  experiments: [
    'rapier',
    'pixi',
    'react',
    'ui',
    'render',
    'sim',
    'app',
    'fluids',
    'physics',
    'interaction',
    'camera',
  ],
  assets: [
    'core',
    'physics',
    'fluids',
    'render',
    'ui',
    'sim',
    'scene',
    'interaction',
    'camera',
    'materials',
    'experiments',
    'app',
    'pixi',
    'react',
    'rapier',
  ],
}

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

function layerOf(file: string): string | null {
  const rel = relative(ROOT, file).replaceAll('\\', '/')
  const top = rel.split('/')[0] ?? ''
  if (!top || top.includes('.')) return null
  return top
}

function srcDirs(): string[] {
  return readdirSync(ROOT).filter((name) => statSync(join(ROOT, name)).isDirectory())
}

function importTargets(fromFile: string, spec: string): string[] {
  if (spec.startsWith('.')) {
    const resolved = resolve(dirname(fromFile), spec)
    const rel = relative(ROOT, resolved).replaceAll('\\', '/')
    if (rel.startsWith('..')) return []
    const top = rel.split('/')[0] ?? ''
    if (!top || top.includes('.')) return []
    return [top]
  }
  const hits: string[] = []
  if (
    spec === 'react' ||
    spec.startsWith('react/') ||
    spec === 'react-dom' ||
    spec.startsWith('react-dom/')
  ) {
    hits.push('react')
  }
  if (spec.includes('pixi')) hits.push('pixi')
  if (spec.includes('rapier')) hits.push('rapier')
  return hits
}

describe('architecture boundaries', () => {
  const files = walk(ROOT)

  it('has a rule for every directory under src/', () => {
    const extra = srcDirs().filter((d) => !(d in FORBIDDEN))
    expect(extra, 'carpeta src/ sin regla de arquitectura').toEqual([])
  })

  it('every layer respects its forbidden imports', () => {
    for (const file of files) {
      const layer = layerOf(file)
      if (!layer) continue
      const forbidden = FORBIDDEN[layer]
      if (!forbidden) continue
      const src = readFileSync(file, 'utf8')
      for (const spec of importsOf(src)) {
        for (const target of importTargets(file, spec)) {
          expect(
            forbidden.includes(target),
            `${relative(ROOT, file)} importa '${spec}' → ${target} (prohibido en ${layer}/)`,
          ).toBe(false)
        }
      }
    }
  })
})
