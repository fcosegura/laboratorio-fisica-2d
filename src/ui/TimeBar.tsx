import { useLab } from '../app/lab-context.ts'
import { useLabStore } from '../app/store.ts'
import { emptyScene, GRAVITY_PRESETS, type GravityPreset } from '../scene/document.ts'
import { EXPERIMENTS } from '../experiments/scenes.ts'

export function TimeBar() {
  const lab = useLab()
  const playing = useLabStore((s) => s.playing)
  const timeScale = useLabStore((s) => s.timeScale)
  const simTime = useLabStore((s) => s.simTime)
  const gravityPreset = useLabStore((s) => s.gravityPreset)

  const setPreset = (p: GravityPreset) => {
    useLabStore.setState({ gravityPreset: p })
    if (p !== 'custom') lab.engine.setGravity(GRAVITY_PRESETS[p])
  }

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
      <div className="mr-2 font-semibold tracking-tight text-accent">Física 2D</div>
      <Btn onClick={() => { lab.engine.play(); lab.pushUi() }} active={playing} title="Reproducir">
        ▶
      </Btn>
      <Btn onClick={() => { lab.engine.pause(); lab.pushUi() }} active={!playing} title="Pausa">
        ⏸
      </Btn>
      <Btn onClick={() => { lab.engine.stepOnce(); lab.pushUi() }} title="Paso">
        ⏭
      </Btn>
      <Btn onClick={() => void lab.reset()} title="Reiniciar">
        ↺
      </Btn>
      <label className="ml-2 flex items-center gap-2 text-xs text-muted">
        ×{timeScale.toFixed(1)}
        <input
          type="range"
          min={0.1}
          max={2}
          step={0.1}
          value={timeScale}
          onChange={(e) => lab.setTimeScale(Number(e.target.value))}
          className="w-24"
        />
      </label>
      <select
        className="rounded-md border border-line bg-panel-2 px-2 py-1 text-xs"
        value={gravityPreset}
        onChange={(e) => setPreset(e.target.value as GravityPreset)}
      >
        <option value="earth">Tierra g</option>
        <option value="moon">Luna</option>
        <option value="mars">Marte</option>
        <option value="zero">Cero g</option>
      </select>
      <div className="font-mono text-xs text-muted">t = {simTime.toFixed(2)} s</div>
      <div className="ml-auto flex items-center gap-2">
        <Btn
          onClick={() => {
            if (confirm('¿Borrar toda la escena?')) void lab.loadDocument(emptyScene())
          }}
          title="Borrar todo"
        >
          🗑 Borrar todo
        </Btn>
        <select
          className="max-w-44 rounded-md border border-line bg-panel-2 px-2 py-1 text-xs"
          defaultValue=""
          onChange={(e) => {
            const exp = EXPERIMENTS.find((x) => x.id === e.target.value)
            if (exp) void lab.loadDocument(exp.build())
            e.currentTarget.value = ''
          }}
        >
          <option value="" disabled>
            Experimentos…
          </option>
          {EXPERIMENTS.map((e) => (
            <option key={e.id} value={e.id}>
              {e.title}
            </option>
          ))}
        </select>
        <Btn onClick={() => lab.fit()} title="Ajustar vista">
          ⤢
        </Btn>
        <Btn
          onClick={() => {
            const blob = new Blob([lab.exportJson()], { type: 'application/json' })
            const a = document.createElement('a')
            a.href = URL.createObjectURL(blob)
            a.download = `${lab.engine.doc.meta.name.replace(/\s+/g, '-')}.json`
            a.click()
          }}
        >
          Guardar
        </Btn>
        <label className="cursor-pointer rounded-md border border-line bg-panel-2 px-2 py-1 text-xs hover:border-accent">
          Abrir
          <input
            type="file"
            accept="application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (!file) return
              file.text().then((t) => lab.importJson(t))
              e.target.value = ''
            }}
          />
        </label>
      </div>
    </header>
  )
}

function Btn({
  children,
  onClick,
  active,
  title,
}: {
  children: React.ReactNode
  onClick: () => void
  active?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`rounded-md border px-2 py-1 text-sm ${
        active ? 'border-accent bg-accent/15 text-accent' : 'border-line bg-panel-2 hover:border-accent/50'
      }`}
    >
      {children}
    </button>
  )
}
