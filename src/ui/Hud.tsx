import { useLabStore } from '../app/store.ts'

export function Hud() {
  const t = useLabStore((s) => s.timings)
  const bodies = useLabStore((s) => s.bodyCount)
  const particles = useLabStore((s) => s.particleCount)
  const truncated = useLabStore((s) => s.particlesTruncated)
  const limit = useLabStore((s) => s.particleLimit)
  const debug = useLabStore((s) => s.debugHud)
  if (!debug && truncated === 0) return null
  return (
    <div className="pointer-events-none absolute right-3 top-3 flex flex-col items-end gap-1">
      {truncated > 0 && (
        <div className="rounded-md bg-amber-500/15 px-2 py-1 text-[11px] text-amber-300">
          Límite de {limit} partículas: se descartaron {truncated} de agua libre
        </div>
      )}
      {debug && (
        <div className="rounded-md bg-black/40 px-2 py-1 font-mono text-[10px] leading-4 text-muted">
          <div>frame {t.frame.toFixed(1)} ms</div>
          <div>
            phys {t.physics.toFixed(1)} ms · fluid {t.fluids.toFixed(1)} ms
          </div>
          <div>
            draw {t.render.toFixed(1)} ms · steps {t.steps}
          </div>
          <div>
            bodies {bodies} · particles {particles} · dropped {t.dropped}
          </div>
        </div>
      )}
    </div>
  )
}
