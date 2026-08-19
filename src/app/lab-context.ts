import { createContext, useContext } from 'react'
import type { LabRuntime } from './LabRuntime.ts'

export const LabContext = createContext<LabRuntime | null>(null)

export function useLab(): LabRuntime {
  const lab = useContext(LabContext)
  if (!lab) throw new Error('LabRuntime no está en el árbol')
  return lab
}
