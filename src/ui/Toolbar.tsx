import { FLUID_MATERIALS, SOLID_MATERIALS } from '../materials/catalog.ts'
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
        ? FLUID_MATERIALS.map((m) => (
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
      <div className="my-1 h-px w-8 bg-line" />
      {(
        [
          ['velocity', 'v'],
          ['force', 'F'],
          ['gravity', 'g'],
          ['contacts', 'n'],
          ['com', 'cm'],
        ] as const
      ).map(([key, label]) => (
        <button
          key={key}
          type="button"
          title={key}
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
    measure: '📏',
    joint: '⚭',
  }
  return <span>{map[id]}</span>
}
