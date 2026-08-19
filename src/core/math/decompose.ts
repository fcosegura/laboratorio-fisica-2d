import earcut from 'earcut'
import type { Vec2 } from './vec2.ts'
import { vec2 } from './vec2.ts'
import { ensureCCW, isConvex, polygonArea, removeDuplicateVertices } from './polygon.ts'

const EPS = 1e-9

function key(a: Vec2, b: Vec2): string {
  const ax = a.x < b.x || (a.x === b.x && a.y < b.y) ? a : b
  const bx = ax === a ? b : a
  return `${ax.x.toFixed(8)},${ax.y.toFixed(8)}|${bx.x.toFixed(8)},${bx.y.toFixed(8)}`
}

function samePoint(a: Vec2, b: Vec2): boolean {
  return Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS
}

function mergeTwo(a: Vec2[], b: Vec2[]): Vec2[] | null {
  // Find shared edge.
  const n = a.length
  const m = b.length
  let ai = -1
  let bi = -1
  for (let i = 0; i < n; i++) {
    const a0 = a[i]!
    const a1 = a[(i + 1) % n]!
    for (let j = 0; j < m; j++) {
      const b0 = b[j]!
      const b1 = b[(j + 1) % m]!
      if (samePoint(a0, b1) && samePoint(a1, b0)) {
        ai = i
        bi = j
        break
      }
    }
    if (ai >= 0) break
  }
  if (ai < 0) return null

  const out: Vec2[] = []
  for (let k = 1; k < n; k++) out.push(a[(ai + k) % n]!)
  for (let k = 1; k < m; k++) out.push(b[(bi + k) % m]!)
  const cleaned = removeDuplicateVertices(out)
  if (cleaned.length < 3 || !isConvex(cleaned) || polygonArea(cleaned) < EPS) return null
  return ensureCCW(cleaned)
}

function mergeConvexParts(parts: Vec2[][]): Vec2[][] {
  let changed = true
  const current = parts.map((p) => ensureCCW(p))
  while (changed) {
    changed = false
    outer: for (let i = 0; i < current.length; i++) {
      for (let j = i + 1; j < current.length; j++) {
        const merged = mergeTwo(current[i]!, current[j]!)
        if (merged) {
          current.splice(j, 1)
          current.splice(i, 1, merged)
          changed = true
          break outer
        }
      }
    }
  }
  return current
}

/**
 * Decompose a simple polygon into convex pieces (earcut triangulation + Hertel–Mehlhorn merges).
 */
export function decomposePolygon(input: readonly Vec2[]): Vec2[][] {
  const poly = ensureCCW(removeDuplicateVertices(input))
  if (poly.length < 3) return []
  if (isConvex(poly)) return [poly]

  const flat: number[] = []
  for (const p of poly) {
    flat.push(p.x, p.y)
  }
  const indices = earcut(flat)
  const triangles: Vec2[][] = []
  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i]
    const ib = indices[i + 1]
    const ic = indices[i + 2]
    if (ia === undefined || ib === undefined || ic === undefined) continue
    const tri = [vec2(poly[ia]!.x, poly[ia]!.y), vec2(poly[ib]!.x, poly[ib]!.y), vec2(poly[ic]!.x, poly[ic]!.y)]
    if (polygonArea(tri) > EPS) triangles.push(ensureCCW(tri))
  }
  if (triangles.length === 0) return [poly]
  void key
  return mergeConvexParts(triangles)
}

export function toXYArray(poly: readonly Vec2[]): Float32Array {
  const arr = new Float32Array(poly.length * 2)
  for (let i = 0; i < poly.length; i++) {
    arr[i * 2] = poly[i]!.x
    arr[i * 2 + 1] = poly[i]!.y
  }
  return arr
}
