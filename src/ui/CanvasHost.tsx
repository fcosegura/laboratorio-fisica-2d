import type { RefObject } from 'react'

export function CanvasHost({ canvasRef }: { canvasRef: RefObject<HTMLCanvasElement | null> }) {
  return (
    <canvas
      ref={canvasRef}
      className="block h-full w-full touch-none"
      onContextMenu={(e) => e.preventDefault()}
    />
  )
}
