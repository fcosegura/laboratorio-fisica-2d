import type { SceneBody, SceneDocument, SceneFluidRegion } from './document.ts'

export interface Command {
  apply(doc: SceneDocument): void
  invert(doc: SceneDocument): void
}

export class AddBodyCommand implements Command {
  body: SceneBody
  constructor(body: SceneBody) {
    this.body = body
  }
  apply(doc: SceneDocument): void {
    doc.bodies.push(structuredClone(this.body))
  }
  invert(doc: SceneDocument): void {
    doc.bodies = doc.bodies.filter((b) => b.id !== this.body.id)
  }
}

export class RemoveBodyCommand implements Command {
  id: string
  stored: SceneBody | null = null
  constructor(id: string) {
    this.id = id
  }
  apply(doc: SceneDocument): void {
    const i = doc.bodies.findIndex((b) => b.id === this.id)
    this.stored = i >= 0 ? structuredClone(doc.bodies[i]!) : null
    if (i >= 0) doc.bodies.splice(i, 1)
  }
  invert(doc: SceneDocument): void {
    if (this.stored) doc.bodies.push(structuredClone(this.stored))
  }
}

export class UpdateBodyCommand implements Command {
  id: string
  patch: Partial<SceneBody>
  prev: SceneBody | null = null
  constructor(id: string, patch: Partial<SceneBody>) {
    this.id = id
    this.patch = patch
  }
  apply(doc: SceneDocument): void {
    const body = doc.bodies.find((b) => b.id === this.id)
    if (!body) return
    this.prev = structuredClone(body)
    Object.assign(body, this.patch)
  }
  invert(doc: SceneDocument): void {
    const i = doc.bodies.findIndex((b) => b.id === this.id)
    if (i >= 0 && this.prev) doc.bodies[i] = structuredClone(this.prev)
  }
}

export class AddFluidCommand implements Command {
  region: SceneFluidRegion
  constructor(region: SceneFluidRegion) {
    this.region = region
  }
  apply(doc: SceneDocument): void {
    doc.fluidRegions.push(structuredClone(this.region))
  }
  invert(doc: SceneDocument): void {
    doc.fluidRegions = doc.fluidRegions.filter((r) => r.id !== this.region.id)
  }
}

export class RemoveFluidCommand implements Command {
  id: string
  stored: SceneFluidRegion | null = null
  constructor(id: string) {
    this.id = id
  }
  apply(doc: SceneDocument): void {
    const i = doc.fluidRegions.findIndex((r) => r.id === this.id)
    this.stored = i >= 0 ? structuredClone(doc.fluidRegions[i]!) : null
    if (i >= 0) doc.fluidRegions.splice(i, 1)
  }
  invert(doc: SceneDocument): void {
    if (this.stored) doc.fluidRegions.push(structuredClone(this.stored))
  }
}

export class DuplicateBodyCommand implements Command {
  newBody: SceneBody
  constructor(_sourceId: string, newBody: SceneBody) {
    this.newBody = newBody
  }
  apply(doc: SceneDocument): void {
    doc.bodies.push(structuredClone(this.newBody))
  }
  invert(doc: SceneDocument): void {
    doc.bodies = doc.bodies.filter((b) => b.id !== this.newBody.id)
  }
}
