import { BatchCommand, type Command } from './commands.ts'
import type { SceneDocument } from './document.ts'
import { cloneDocument } from './document.ts'

export class History {
  private undoStack: Command[] = []
  private redoStack: Command[] = []
  /** Commands applied since `begin()`; folded into one undo entry by `commit()`. */
  private pending: Command[] | null = null
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
    if (this.pending) {
      this.pending.push(cmd)
      return
    }
    this.push(cmd)
  }

  /** Start a transaction: every `apply` until `commit` is a single Ctrl+Z. Not reentrant. */
  begin(): void {
    if (this.pending) throw new Error('History: transacción ya abierta')
    this.pending = []
  }

  inTransaction(): boolean {
    return this.pending !== null
  }

  commit(): void {
    const cmds = this.pending
    this.pending = null
    if (!cmds?.length) return
    this.push(cmds.length === 1 ? cmds[0]! : new BatchCommand(cmds))
  }

  /** Revert everything applied since `begin()` and leave no undo entry. */
  abort(): void {
    const cmds = this.pending
    this.pending = null
    if (!cmds?.length) return
    const doc = cloneDocument(this.getDoc())
    for (let i = cmds.length - 1; i >= 0; i--) cmds[i]!.invert(doc)
    this.setDoc(doc)
  }

  undo(): boolean {
    if (this.pending) this.commit()
    const cmd = this.undoStack.pop()
    if (!cmd) return false
    const doc = cloneDocument(this.getDoc())
    cmd.invert(doc)
    this.setDoc(doc)
    this.redoStack.push(cmd)
    return true
  }

  redo(): boolean {
    if (this.pending) this.commit()
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
    this.pending = null
  }

  private push(cmd: Command): void {
    this.undoStack.push(cmd)
    if (this.undoStack.length > this.max) this.undoStack.shift()
    this.redoStack.length = 0
  }
}
