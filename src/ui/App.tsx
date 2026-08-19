import { useEffect, useMemo, useRef, useState } from 'react'
import { LabContext } from '../app/lab-context.ts'
import { LabRuntime } from '../app/LabRuntime.ts'
import { useLabStore } from '../app/store.ts'
import { emptyScene } from '../scene/document.ts'
import { CanvasHost } from './CanvasHost.tsx'
import { GraphPanel } from './GraphPanel.tsx'
import { Inspector } from './Inspector.tsx'
import { TimeBar } from './TimeBar.tsx'
import { Toolbar } from './Toolbar.tsx'
import { Hud } from './Hud.tsx'

export function App() {
  const lab = useMemo(() => new LabRuntime(emptyScene()), [])
  const [ready, setReady] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    lab.attachStore(useLabStore)
    const canvas = canvasRef.current
    if (!canvas) return
    let cancelled = false
    lab.mount(canvas).then(() => {
      if (!cancelled) {
        setReady(true)
        lab.pushUi()
      }
    })
    return () => {
      cancelled = true
      lab.dispose()
    }
  }, [lab])

  return (
    <LabContext.Provider value={lab}>
      <div className="flex h-full min-h-0 flex-col bg-lab text-ink">
        <TimeBar />
        <div className="flex min-h-0 flex-1">
          <Toolbar />
          <div className="relative min-w-0 flex-1">
            <CanvasHost canvasRef={canvasRef} />
            {!ready && (
              <div className="pointer-events-none absolute inset-0 grid place-items-center text-muted">
                Cargando motor físico…
              </div>
            )}
            <Hud />
          </div>
          <Inspector />
        </div>
        <GraphPanel />
      </div>
    </LabContext.Provider>
  )
}
