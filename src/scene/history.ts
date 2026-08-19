import type { Command } from './commands.ts'
import type { SceneDocument } from './document.ts'
import { cloneDocument } from './document.ts'

export class History {
  private undoStack: Command[] = []
  private redoStack: Command[] = []
  readonly max = 200
  private getDoc: () => SceneDocument
  private setDoc: (doc: SceneDocument) => void

  constructor(getDoc: () => SceneDocument, setDoc: (doc: SceneDocument) => void) {
    this.getDoc = getDoc
    this.setDoc = setDoc
  }

  apply(cmd: Command): void {
    const doc = cloneDocument(this.getDoc())
    cmd.apply(doc)
    this.setDoc(doc)
    this.undoStack.push(cmd)
    if (this.undoStack.length > this.max) this.undoStack.shift()
    this.redoStack.length = 0
  }

  undo(): boolean {
    const cmd = this.undoStack.pop()
    if (!cmd) return false
    const doc = cloneDocument(this.getDoc())
    cmd.invert(doc)
    this.setDoc(doc)
    this.redoStack.push(cmd)
    return true
  }

  redo(): boolean {
    const cmd = this.redoStack.pop()
    if (!cmd) return false
    const doc = cloneDocument(this.getDoc())
    cmd.apply(doc)
    this.setDoc(doc)
    this.undoStack.push(cmd)
    return true
  }

  canUndo(): boolean {
    return this.undoStack.length > 0
  }

  canRedo(): boolean {
    return this.redoStack.length > 0
  }

  clear(): void {
    this.undoStack.length = 0
    this.redoStack.length = 0
  }
}
