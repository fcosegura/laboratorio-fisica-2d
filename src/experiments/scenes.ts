import { IdFactory } from '../core/ids.ts'
import { getSolid } from '../materials/catalog.ts'
import {
  DEFAULT_VIZ,
  emptyScene,
  GRAVITY_PRESETS,
  type SceneBody,
  type SceneDocument,
} from '../scene/document.ts'

function ball(
  id: string,
  name: string,
  x: number,
  y: number,
  radius: number,
  materialId: string,
  extra: Partial<SceneBody> = {},
): SceneBody {
  const mat = getSolid(materialId)
  return {
    id,
    name,
    type: 'dynamic',
    x,
    y,
    angle: 0,
    vx: 0,
    vy: 0,
    omega: 0,
    massMode: 'density',
    density: mat.density,
    friction: mat.friction,
    restitution: mat.restitution,
    materialId,
    gravityScale: 1,
    linearDamping: mat.linearDamping,
    angularDamping: mat.angularDamping,
    ccd: false,
    locked: false,
    lockRotation: false,
    shape: { kind: 'circle', radius },
    ...extra,
  }
}

function box(
  id: string,
  name: string,
  x: number,
  y: number,
  hx: number,
  hy: number,
  materialId: string,
  extra: Partial<SceneBody> = {},
): SceneBody {
  const mat = getSolid(materialId)
  return {
    id,
    name,
    type: extra.type ?? 'dynamic',
    x,
    y,
    angle: extra.angle ?? 0,
    vx: extra.vx ?? 0,
    vy: extra.vy ?? 0,
    omega: extra.omega ?? 0,
    massMode: 'density',
    density: extra.density ?? mat.density,
    friction: extra.friction ?? mat.friction,
    restitution: extra.restitution ?? mat.restitution,
    materialId,
    gravityScale: extra.gravityScale ?? 1,
    linearDamping: extra.linearDamping ?? mat.linearDamping,
    angularDamping: extra.angularDamping ?? mat.angularDamping,
    ccd: extra.ccd ?? false,
    locked: extra.locked ?? extra.type === 'fixed',
    lockRotation: extra.lockRotation ?? extra.type === 'fixed',
    ...extra,
    shape: extra.shape ?? { kind: 'box', hx, hy },
  }
}

function base(name: string, description: string): SceneDocument {
  const doc = emptyScene(name)
  doc.meta.description = description
  doc.visualization = { ...DEFAULT_VIZ, velocity: true }
  return doc
}

export const EXPERIMENTS: { id: string; title: string; build: () => SceneDocument }[] = [
  {
    id: 'freefall',
    title: 'Caída libre',
    build: () => {
      const doc = base('Caída libre', 'Una bola de madera cae desde 5 m. Observa y = ½ g t².')
      doc.bodies = [
        box('body:ground', 'Suelo', 0, -0.25, 6, 0.25, 'stone', { type: 'fixed' }),
        ball('body:ball', 'Bola', 0, 5, 0.3, 'wood'),
      ]
      doc.camera = { x: 0, y: 2.4, pixelsPerMeter: 70 }
      doc.visualization.velocity = true
      return doc
    },
  },
  {
    id: 'projectile',
    title: 'Tiro parabólico',
    build: () => {
      const doc = base('Tiro parabólico', 'Velocidad inicial 8 m/s a 45°.')
      doc.bodies = [
        box('body:ground', 'Suelo', 4, -0.25, 10, 0.25, 'stone', { type: 'fixed' }),
        ball('body:ball', 'Proyectil', 0, 0.4, 0.25, 'plastic', { vx: 8 * Math.cos(Math.PI / 4), vy: 8 * Math.sin(Math.PI / 4) }),
      ]
      doc.camera = { x: 4, y: 2, pixelsPerMeter: 48 }
      doc.visualization.trajectories = true
      doc.visualization.velocity = true
      return doc
    },
  },
  {
    id: 'collision',
    title: 'Colisiones',
    build: () => {
      const doc = base('Colisiones', 'Dos bolas de goma: una en reposo, otra con 4 m/s.')
      doc.world.gravity = { ...GRAVITY_PRESETS.zero }
      doc.world.gravityPreset = 'zero'
      doc.bodies = [
        ball('body:a', 'Incidente', -2, 2, 0.4, 'rubber', { vx: 4, gravityScale: 0 }),
        ball('body:b', 'Blanco', 1, 2, 0.4, 'rubber', { gravityScale: 0 }),
      ]
      doc.camera = { x: 0, y: 2, pixelsPerMeter: 64 }
      return doc
    },
  },
  {
    id: 'incline',
    title: 'Plano inclinado',
    build: () => {
      const doc = base('Plano inclinado', 'Caja de madera sobre un plano de 25°.')
      const angle = (-25 * Math.PI) / 180
      doc.bodies = [
        box('body:ramp', 'Rampa', 0, 1, 4, 0.15, 'stone', { type: 'fixed', angle, friction: 0.25 }),
        box('body:block', 'Caja', -1.6, 2.3, 0.35, 0.25, 'wood', { angle, friction: 0.25 }),
        box('body:ground', 'Suelo', 2, -0.2, 6, 0.2, 'stone', { type: 'fixed' }),
      ]
      doc.camera = { x: 0.5, y: 1.6, pixelsPerMeter: 70 }
      return doc
    },
  },
  {
    id: 'pendulum',
    title: 'Péndulo',
    build: () => {
      const doc = base('Péndulo', 'Una masa unida a un anclaje fijo con una bisagra (joint revolute).')
      doc.bodies = [
        box('body:anchor', 'Anclaje', 0, 4, 0.15, 0.15, 'metal', { type: 'fixed' }),
        ball('body:bob', 'Masa', 1.6, 3.2, 0.28, 'metal', { restitution: 0 }),
      ]
      doc.joints = [
        {
          id: 'joint:1',
          kind: 'revolute',
          bodyA: 'body:anchor',
          bodyB: 'body:bob',
          anchorA: { x: 0, y: 0 },
          anchorB: { x: -1.6, y: 0.8 },
        },
      ]
      doc.camera = { x: 0, y: 2.4, pixelsPerMeter: 70 }
      return doc
    },
  },
  {
    id: 'buoyancy',
    title: 'Flotación',
    build: () => {
      const doc = base('Flotación', 'Madera, plástico y piedra en agua. Arquímedes: la fracción sumergida ≈ ρ_cuerpo / ρ_agua.')
      doc.bodies = [
        box('body:ground', 'Suelo', 0, -0.2, 5, 0.2, 'stone', { type: 'fixed' }),
        box('body:left', 'Pared izq.', -4.8, 1.5, 0.15, 1.7, 'stone', { type: 'fixed' }),
        box('body:right', 'Pared der.', 4.8, 1.5, 0.15, 1.7, 'stone', { type: 'fixed' }),
        box('body:wood', 'Madera', -2, 2.8, 0.4, 0.3, 'wood'),
        box('body:plastic', 'Plástico', 0, 2.8, 0.4, 0.3, 'plastic'),
        box('body:stone', 'Piedra', 2, 2.8, 0.35, 0.25, 'stone'),
      ]
      doc.fluidRegions = [
        {
          id: 'fluid:1',
          name: 'Agua',
          polygon: [
            { x: -4.65, y: 0 },
            { x: 4.65, y: 0 },
            { x: 4.65, y: 2.2 },
            { x: -4.65, y: 2.2 },
          ],
          restSurfaceY: 2.2,
          materialId: 'water',
        },
      ]
      doc.camera = { x: 0, y: 1.6, pixelsPerMeter: 55 }
      doc.visualization.gravity = true
      return doc
    },
  },
]

void IdFactory

export function experimentById(id: string): SceneDocument | null {
  return EXPERIMENTS.find((e) => e.id === id)?.build() ?? null
}
