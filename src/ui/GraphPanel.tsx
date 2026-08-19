import { useEffect, useRef } from 'react'
import { useLab } from '../app/lab-context.ts'
import { useLabStore } from '../app/store.ts'
import { CHANNEL_LABELS, type RecorderChannel } from '../sim/recorder.ts'

export function GraphPanel() {
  const lab = useLab()
  const open = useLabStore((s) => s.graphsOpen)
  const channel = useLabStore((s) => s.graphChannel)
  const selectedId = useLabStore((s) => s.selectedId)
  const simTime = useLabStore((s) => s.simTime)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (selectedId) {
      lab.engine.recorder.observe(selectedId)
      return () => {
        lab.engine.recorder.unobserve(selectedId)
      }
    }
  }, [selectedId, lab])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !open) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const displayWidth = canvas.clientWidth || 900
    const displayHeight = canvas.clientHeight || 140

    if (canvas.width !== Math.floor(displayWidth * dpr) || canvas.height !== Math.floor(displayHeight * dpr)) {
      canvas.width = Math.floor(displayWidth * dpr)
      canvas.height = Math.floor(displayHeight * dpr)
    }

    ctx.save()
    ctx.scale(dpr, dpr)
    const w = displayWidth
    const h = displayHeight

    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#101826'
    ctx.fillRect(0, 0, w, h)

    ctx.font = '11px ui-monospace, monospace'

    if (!selectedId) {
      ctx.fillStyle = '#8b9bb4'
      ctx.fillText('Selecciona un cuerpo para graficar.', 12, 22)
      ctx.restore()
      return
    }
    const { t, y, n } = lab.engine.recorder.series(selectedId, channel as RecorderChannel)
    if (n < 2) {
      ctx.fillStyle = '#8b9bb4'
      ctx.fillText('Pulsa Play para registrar datos.', 12, 22)
      ctx.restore()
      return
    }
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < n; i++) {
      const v = y[i]!
      if (v < min) min = v
      if (v > max) max = v
    }
    if (min === max) {
      min -= 1
      max += 1
    }
    ctx.strokeStyle = '#3ee0c5'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let i = 0; i < n; i++) {
      const x = ((t[i]! - t[0]!) / Math.max(1e-6, t[n - 1]! - t[0]!)) * (w - 16) + 8
      const py = h - 10 - ((y[i]! - min) / (max - min)) * (h - 24)
      if (i === 0) ctx.moveTo(x, py)
      else ctx.lineTo(x, py)
    }
    ctx.stroke()
    ctx.fillStyle = '#8b9bb4'
    ctx.fillText(`${CHANNEL_LABELS[channel as RecorderChannel]}  min ${min.toFixed(2)}  max ${max.toFixed(2)}`, 8, 14)
    ctx.restore()
  }, [lab, selectedId, channel, simTime, open])

  if (!open) return null

  return (
    <footer className="flex h-36 shrink-0 border-t border-line bg-panel">
      <div className="flex w-40 flex-col gap-1 border-r border-line p-2 text-xs">
        <div className="text-muted">Gráfica</div>
        {(['y', 'x', 'vx', 'vy', 'speed', 'energy', 'kinetic'] as const).map((ch) => (
          <button
            key={ch}
            type="button"
            className={`rounded px-2 py-1 text-left ${channel === ch ? 'bg-accent/15 text-accent' : 'text-muted'}`}
            onClick={() => useLabStore.setState({ graphChannel: ch })}
          >
            {CHANNEL_LABELS[ch]}
          </button>
        ))}
      </div>
      <canvas ref={canvasRef} className="h-full min-w-0 flex-1" />
    </footer>
  )
}

