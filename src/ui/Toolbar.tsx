import { FLUID_MATERIALS, LIQUID_MATERIALS, SOLID_MATERIALS } from '../materials/catalog.ts'
import { useLab } from '../app/lab-context.ts'
import { useLabStore } from '../app/store.ts'
import { TOOL_META, type Tool } from '../interaction/tools.ts'
import { JOINT_KIND_META } from '../scene/document.ts'

const FLUID_TOOLS: ReadonlySet<Tool> = new Set(['fluid', 'spill'])

export function Toolbar() {
  const lab = useLab()
  const tool = useLabStore((s) => s.tool)
  const jointKind = useLabStore((s) => s.jointKind)
  const materialId = useLabStore((s) => s.materialId)
  const fluidMaterialId = useLabStore((s) => s.fluidMaterialId)
  const spillSpacing = useLabStore((s) => s.spillSpacing)
  const particleCount = useLabStore((s) => s.particleCount)
  const viz = useLabStore((s) => s.viz)
  const canUndo = useLabStore((s) => s.canUndo)
  const canRedo = useLabStore((s) => s.canRedo)
  const fluidTool = FLUID_TOOLS.has(tool)

  return (
    <aside className="flex w-16 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-line bg-panel py-2">
      <button
        type="button"
        title="Deshacer (Ctrl+Z)"
        disabled={!canUndo}
        onClick={() => lab.undo()}
        className={`flex h-8 w-10 items-center justify-center rounded text-sm ${
          canUndo ? 'text-ink hover:bg-panel-2' : 'cursor-not-allowed text-muted opacity-40'
        }`}
      >
        ↩
      </button>
      <button
        type="button"
        title="Rehacer (Mayús+Ctrl+Z)"
        disabled={!canRedo}
        onClick={() => lab.redo()}
        className={`flex h-8 w-10 items-center justify-center rounded text-sm ${
          canRedo ? 'text-ink hover:bg-panel-2' : 'cursor-not-allowed text-muted opacity-40'
        }`}
      >
        ↪
      </button>
      <div className="my-1 h-px w-8 bg-line" />
      {TOOL_META.map((t) => (
        <button
          key={t.id}
          type="button"
          title={`${t.label} (${t.hint})`}
          onClick={() => useLabStore.setState({ tool: t.id })}
          className={`flex h-10 w-10 items-center justify-center rounded-lg text-lg ${
            tool === t.id
              ? 'bg-accent/20 text-accent'
              : 'text-muted hover:bg-panel-2 hover:text-ink'
          }`}
        >
          <ToolIcon id={t.id} />
        </button>
      ))}
      {tool === 'joint' && (
        <>
          <div className="my-1 h-px w-8 bg-line" />
          {JOINT_KIND_META.map((k) => (
            <button
              key={k.id}
              type="button"
              title={`${k.label} · ${k.hint}`}
              onClick={() => useLabStore.setState({ jointKind: k.id })}
              className={`flex h-7 w-10 items-center justify-center rounded text-[10px] font-semibold ${
                jointKind === k.id
                  ? 'bg-accent/20 text-accent'
                  : 'text-muted hover:bg-panel-2 hover:text-ink'
              }`}
            >
              {k.chip}
            </button>
          ))}
        </>
      )}
      <div className="my-1 h-px w-8 bg-line" />
      {fluidTool
        ? (tool === 'fluid' ? LIQUID_MATERIALS : FLUID_MATERIALS).map((m) => (
            <button
              key={m.id}
              type="button"
              title={m.name}
              onClick={() => useLabStore.setState({ fluidMaterialId: m.id })}
              className={`h-6 w-6 rounded-full border ${
                fluidMaterialId === m.id ? 'border-accent' : 'border-line'
              }`}
              style={{ background: `#${m.color.toString(16).padStart(6, '0')}` }}
            />
          ))
        : SOLID_MATERIALS.map((m) => (
            <button
              key={m.id}
              type="button"
              title={m.name}
              onClick={() => useLabStore.setState({ materialId: m.id })}
              className={`h-6 w-6 rounded-full border ${
                materialId === m.id ? 'border-accent' : 'border-line'
              }`}
              style={{ background: `#${m.color.toString(16).padStart(6, '0')}` }}
            />
          ))}
      {tool === 'spill' && (
        <>
          <div className="my-1 h-px w-8 bg-line" />
          {SPILL_RESOLUTIONS.map((r) => (
            <button
              key={r.spacing}
              type="button"
              title={
                particleCount > 0
                  ? `${r.title}. Ya hay partículas: el nuevo volumen usa su resolución`
                  : r.title
              }
              onClick={() => useLabStore.setState({ spillSpacing: r.spacing })}
              className={`h-6 w-10 rounded text-[9px] ${
                spillSpacing === r.spacing
                  ? 'bg-accent/20 text-accent'
                  : 'text-muted hover:bg-panel-2 hover:text-ink'
              }`}
            >
              {r.label}
            </button>
          ))}
        </>
      )}
      <div className="my-1 h-px w-8 bg-line" />
      {(
        [
          ['velocity', 'v', 'Velocidad'],
          ['force', 'F', 'Fuerzas aplicadas'],
          ['gravity', 'g', 'Gravedad'],
          ['contacts', 'n', 'Contactos (fuerza normal)'],
          ['com', 'cm', 'Centro de masas'],
          ['trajectories', 'tr', 'Trayectorias del centro de masas'],
          ['colliders', 'col', 'Colisionadores reales'],
        ] as const
      ).map(([key, label, title]) => (
        <button
          key={key}
          type="button"
          title={title}
          onClick={() => useLabStore.setState({ viz: { ...viz, [key]: !viz[key] } })}
          className={`h-7 w-10 rounded text-[10px] uppercase ${
            viz[key] ? 'bg-accent/20 text-accent' : 'text-muted'
          }`}
        >
          {label}
        </button>
      ))}
    </aside>
  )
}

/** Particle spacing of a new spill: coarser fits more water in the same particle budget. */
const SPILL_RESOLUTIONS = [
  { spacing: 0.07, label: 'fina', title: 'Resolución fina (0,07 m): detalle, poca agua' },
  { spacing: 0.1, label: 'media', title: 'Resolución media (0,1 m)' },
  { spacing: 0.15, label: 'gruesa', title: 'Resolución gruesa (0,15 m): ≈ 2× más agua' },
]

function ToolIcon({ id }: { id: Tool }) {
  const map: Record<Tool, string> = {
    select: '↖',
    pan: '✋',
    circle: '●',
    rect: '■',
    polygon: '⬠',
    line: '━',
    fluid: '💧',
    spill: '🌊',
    force: '↗',
    thruster: '🚀',
    fan: '🌀',
    measure: '📏',
    joint: '⚭',
  }
  return <span>{map[id]}</span>
}
