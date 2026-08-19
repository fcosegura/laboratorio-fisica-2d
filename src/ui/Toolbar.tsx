import { SOLID_MATERIALS } from '../materials/catalog.ts'
import { useLabStore } from '../app/store.ts'
import { TOOL_META, type Tool } from '../interaction/tools.ts'

export function Toolbar() {
  const tool = useLabStore((s) => s.tool)
  const materialId = useLabStore((s) => s.materialId)
  const viz = useLabStore((s) => s.viz)

  return (
    <aside className="flex w-16 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-line bg-panel py-2">
      {TOOL_META.map((t) => (
        <button
          key={t.id}
          type="button"
          title={`${t.label} (${t.hint})`}
          onClick={() => useLabStore.setState({ tool: t.id })}
          className={`flex h-10 w-10 items-center justify-center rounded-lg text-lg ${
            tool === t.id ? 'bg-accent/20 text-accent' : 'text-muted hover:bg-panel-2 hover:text-ink'
          }`}
        >
          <ToolIcon id={t.id} />
        </button>
      ))}
      <div className="my-1 h-px w-8 bg-line" />
      {SOLID_MATERIALS.map((m) => (
        <button
          key={m.id}
          type="button"
          title={m.name}
          onClick={() => useLabStore.setState({ materialId: m.id })}
          className={`h-6 w-6 rounded-full border ${materialId === m.id ? 'border-accent' : 'border-line'}`}
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
    force: '↗',
    measure: '📏',
  }
  return <span>{map[id]}</span>
}
