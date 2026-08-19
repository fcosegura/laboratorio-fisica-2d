import { useLab } from '../app/lab-context.ts'
import { useLabStore } from '../app/store.ts'
import { SOLID_MATERIALS } from '../materials/catalog.ts'
import { JOINT_KIND_META, type SceneJoint } from '../scene/document.ts'
import { DEFAULT_SPRING_DAMPING, DEFAULT_SPRING_STIFFNESS } from '../scene/joints.ts'
import type { BodyType, MassMode } from '../physics/ports.ts'

export function Inspector() {
  const lab = useLab()
  const body = useLabStore((s) => s.selectedBody)
  const joints = useLabStore((s) => s.selectedJoints)
  const live = useLabStore((s) => s.live)
  const open = useLabStore((s) => s.inspectorOpen)

  if (!open) return null

  return (
    <aside className="w-72 shrink-0 overflow-y-auto border-l border-line bg-panel p-3 text-sm">
      <div className="mb-3 text-xs uppercase tracking-wide text-muted">Inspector</div>
      {!body && <p className="text-muted">Selecciona un objeto para editar sus propiedades.</p>}
      {body && (
        <div className="flex flex-col gap-3">
          <Field label="Nombre">
            <input
              className="field"
              value={body.name}
              onChange={(e) => lab.commitPatch(body.id, { name: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Num
              label="x (m)"
              value={live?.x ?? body.x}
              onChange={(v) => lab.commitPatch(body.id, { x: v })}
            />
            <Num
              label="y (m)"
              value={live?.y ?? body.y}
              onChange={(v) => lab.commitPatch(body.id, { y: v })}
            />
            <Num
              label="θ (°)"
              value={((live?.angle ?? body.angle) * 180) / Math.PI}
              onChange={(v) => lab.commitPatch(body.id, { angle: (v * Math.PI) / 180 })}
            />
            <Field label="Tipo">
              <select
                className="field"
                value={body.type}
                onChange={(e) => lab.commitPatch(body.id, { type: e.target.value as BodyType })}
              >
                <option value="dynamic">Dinámico</option>
                <option value="fixed">Estático</option>
                <option value="kinematic">Cinemático</option>
              </select>
            </Field>
          </div>
          <Field label="Material">
            <select
              className="field"
              value={body.materialId}
              onChange={(e) => {
                const mat = SOLID_MATERIALS.find((m) => m.id === e.target.value)
                if (!mat) return
                lab.commitPatch(body.id, {
                  materialId: mat.id,
                  density: mat.density,
                  friction: mat.friction,
                  restitution: mat.restitution,
                })
              }}
            >
              {SOLID_MATERIALS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Masa">
            <select
              className="field mb-1"
              value={body.massMode}
              onChange={(e) => lab.commitPatch(body.id, { massMode: e.target.value as MassMode })}
            >
              <option value="density">Desde densidad</option>
              <option value="explicit">Explícita</option>
            </select>
            {body.massMode === 'density' ? (
              <Num
                label="Densidad (kg/m²)"
                value={body.density}
                onChange={(v) => lab.commitPatch(body.id, { density: v, massMode: 'density' })}
              />
            ) : (
              <Num
                label="Masa (kg)"
                value={body.mass ?? live?.mass ?? 1}
                onChange={(v) => lab.commitPatch(body.id, { mass: v, massMode: 'explicit' })}
              />
            )}
            <div className="mt-1 text-xs text-muted">
              masa actual {live?.mass?.toFixed(3) ?? '—'} kg
              {body.massMode === 'density' ? ' (derivada)' : ''}
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Num label="Fricción" value={body.friction} onChange={(v) => lab.commitPatch(body.id, { friction: v })} />
            <Num
              label="Restitución"
              value={body.restitution}
              onChange={(v) => lab.commitPatch(body.id, { restitution: v })}
            />
            <Num
              label="vx (m/s)"
              value={live?.vx ?? body.vx}
              onChange={(v) => lab.commitPatch(body.id, { vx: v })}
            />
            <Num
              label="vy (m/s)"
              value={live?.vy ?? body.vy}
              onChange={(v) => lab.commitPatch(body.id, { vy: v })}
            />
            <Num
              label="ω (rad/s)"
              value={live?.omega ?? body.omega}
              onChange={(v) => lab.commitPatch(body.id, { omega: v })}
            />
            <Num
              label="Escala g"
              value={body.gravityScale}
              onChange={(v) => lab.commitPatch(body.id, { gravityScale: v })}
            />
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={body.ccd}
              onChange={(e) => lab.commitPatch(body.id, { ccd: e.target.checked })}
            />
            CCD (anti-túnel)
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={body.lockRotation}
              onChange={(e) => lab.commitPatch(body.id, { lockRotation: e.target.checked })}
            />
            Bloquear rotación
          </label>
          {joints.length > 0 && (
            <div className="flex flex-col gap-2 border-t border-line pt-3">
              <div className="text-[11px] uppercase tracking-wide text-muted">Uniones</div>
              {joints.map((joint) => (
                <JointCard key={joint.id} joint={joint} bodyId={body.id} />
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-md border border-line px-2 py-1 text-xs hover:border-accent"
              onClick={() => lab.duplicateSelected()}
            >
              Duplicar
            </button>
            <button
              type="button"
              className="rounded-md border border-danger/40 px-2 py-1 text-xs text-danger hover:bg-danger/10"
              onClick={() => lab.deleteSelected()}
            >
              Eliminar
            </button>
          </div>
        </div>
      )}
      <style>{`
        .field { width: 100%; border-radius: 6px; border: 1px solid #2a364c; background: #1b2536; padding: 4px 8px; font-size: 12px; }
      `}</style>
    </aside>
  )
}

function JointCard({ joint, bodyId }: { joint: SceneJoint; bodyId: string }) {
  const lab = useLab()
  const otherId = joint.bodyA === bodyId ? joint.bodyB : joint.bodyA
  const other = lab.engine.doc.bodies.find((b) => b.id === otherId)
  const kindLabel = JOINT_KIND_META.find((k) => k.id === (joint.kind === 'distance' ? 'rope' : joint.kind))?.label ?? joint.kind
  const stretchy = joint.kind === 'spring' || joint.kind === 'rope' || joint.kind === 'distance'
  return (
    <div className="rounded-md border border-line bg-panel-2 p-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="text-xs">
          <span className="font-medium">{kindLabel}</span>
          <span className="text-muted"> · {other?.name ?? otherId}</span>
        </div>
        <button
          type="button"
          className="rounded border border-danger/40 px-1.5 py-0.5 text-[10px] text-danger hover:bg-danger/10"
          onClick={() => lab.removeJoint(joint.id)}
        >
          Quitar
        </button>
      </div>
      {stretchy && (
        <Num
          label="Longitud (m)"
          value={joint.restLength ?? 0}
          onChange={(v) => lab.commitJointPatch(joint.id, { restLength: v })}
        />
      )}
      {joint.kind === 'spring' && (
        <div className="mt-1 grid grid-cols-2 gap-2">
          <Num
            label="Rigidez"
            value={joint.stiffness ?? DEFAULT_SPRING_STIFFNESS}
            onChange={(v) => lab.commitJointPatch(joint.id, { stiffness: v })}
          />
          <Num
            label="Amortiguación"
            value={joint.damping ?? DEFAULT_SPRING_DAMPING}
            onChange={(v) => lab.commitJointPatch(joint.id, { damping: v })}
          />
        </div>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-[11px] text-muted">{label}</div>
      {children}
    </label>
  )
}

function Num({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <Field label={label}>
      <input
        className="field"
        type="number"
        step="any"
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </Field>
  )
}
