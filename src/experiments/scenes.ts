import { applySolidPreset } from '../materials/applyPreset.ts'
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
    gravityScale: 1,
    ccd: false,
    locked: false,
    lockRotation: false,
    ...applySolidPreset(materialId),
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
    gravityScale: extra.gravityScale ?? 1,
    ccd: extra.ccd ?? false,
    locked: extra.locked ?? extra.type === 'fixed',
    lockRotation: extra.lockRotation ?? extra.type === 'fixed',
    ...applySolidPreset(materialId),
    ...extra,
    shape: extra.shape ?? { kind: 'box', hx, hy },
  }
}

function convex(
  id: string,
  name: string,
  x: number,
  y: number,
  vertices: { x: number; y: number }[],
  materialId: string,
  extra: Partial<SceneBody> = {},
): SceneBody {
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
    gravityScale: extra.gravityScale ?? 1,
    ccd: extra.ccd ?? true,
    locked: extra.locked ?? false,
    lockRotation: extra.lockRotation ?? false,
    ...applySolidPreset(materialId),
    ...extra,
    shape: { kind: 'convex', vertices },
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
      const doc = base(
        'Caída libre',
        'Una bola cae desde 5 m sin amortiguación. Observa y = ½ g t².',
      )
      doc.bodies = [
        box('body:ground', 'Suelo', 0, -0.25, 6, 0.25, 'stone', { type: 'fixed' }),
        ball('body:ball', 'Bola', 0, 5, 0.3, 'wood', { linearDamping: 0, angularDamping: 0 }),
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
      const doc = base('Tiro parabólico', 'Velocidad inicial 8 m/s a 45°, sin amortiguación.')
      doc.bodies = [
        box('body:ground', 'Suelo', 4, -0.25, 10, 0.25, 'stone', { type: 'fixed' }),
        ball('body:ball', 'Proyectil', 0, 0.4, 0.25, 'plastic', {
          vx: 8 * Math.cos(Math.PI / 4),
          vy: 8 * Math.sin(Math.PI / 4),
          linearDamping: 0,
          angularDamping: 0,
        }),
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
      const doc = base(
        'Colisiones',
        'Dos bolas de goma sin amortiguación: una en reposo, otra con 4 m/s.',
      )
      doc.world.gravity = { ...GRAVITY_PRESETS.zero }
      doc.world.gravityPreset = 'zero'
      doc.bodies = [
        ball('body:a', 'Incidente', -2, 2, 0.4, 'rubber', {
          vx: 4,
          gravityScale: 0,
          linearDamping: 0,
          angularDamping: 0,
        }),
        ball('body:b', 'Blanco', 1, 2, 0.4, 'rubber', {
          gravityScale: 0,
          linearDamping: 0,
          angularDamping: 0,
        }),
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
      const doc = base(
        'Péndulo',
        'Una masa unida a un anclaje fijo con una bisagra (joint revolute).',
      )
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
      const doc = base(
        'Flotación',
        'Empuje 2D con superficie plana (sin oleaje). Arquímedes: la fracción sumergida ≈ ρ_cuerpo / ρ_agua.',
      )
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
  {
    id: 'storm-boat',
    title: 'Barco en tormenta',
    build: () => {
      // Fluido analítico = superficie plana (sin oleaje). La «tormenta» es
      // basculación + ráfaga + granizo/escombros para probar flotación e impactos.
      const doc = base(
        'Barco en tormenta',
        'Casco de madera en agua (Arquímedes 2D, superficie plana). Play: el barco ya va escorado; ' +
          'granizo y cajas llegan con velocidad. Usa la herramienta Fuerza para soplar más viento.',
      )
      const surfaceY = 2.4
      const hullX = 0
      const hullY = surfaceY + 0.15
      const hullAngle = (-18 * Math.PI) / 180
      const c = Math.cos(hullAngle)
      const s = Math.sin(hullAngle)
      const place = (lx: number, ly: number) => ({
        x: hullX + lx * c - ly * s,
        y: hullY + lx * s + ly * c,
      })
      const cabinLocal = { x: -0.35, y: 0.52 }
      const mastLocal = { x: 0.35, y: 0.95 }
      const crateLocal = { x: 0.55, y: 0.42 }
      const cabinPos = place(cabinLocal.x, cabinLocal.y)
      const mastPos = place(mastLocal.x, mastLocal.y)
      const cratePos = place(crateLocal.x, crateLocal.y)
      const boatMotion = {
        angle: hullAngle,
        omega: -1.2,
        vx: 0.6,
        linearDamping: 0.35,
        angularDamping: 0.45,
        restitution: 0.05,
      }
      doc.bodies = [
        box('body:ground', 'Fondo', 0, -0.25, 7, 0.25, 'stone', { type: 'fixed' }),
        box('body:left', 'Muelle izq.', -6.6, 2.2, 0.2, 2.4, 'stone', { type: 'fixed' }),
        box('body:right', 'Muelle der.', 6.6, 2.2, 0.2, 2.4, 'stone', { type: 'fixed' }),
        convex(
          'body:hull',
          'Casco',
          hullX,
          hullY,
          [
            { x: -1.35, y: 0.22 },
            { x: 1.45, y: 0.22 },
            { x: 1.15, y: -0.12 },
            { x: 0.35, y: -0.42 },
            { x: -0.55, y: -0.42 },
            { x: -1.25, y: -0.08 },
          ],
          'wood',
          {
            density: 450,
            ...boatMotion,
            friction: 0.4,
            color: 0x8b5a2b,
          },
        ),
        box('body:cabin', 'Cabina', cabinPos.x, cabinPos.y, 0.45, 0.28, 'wood', {
          density: 350,
          ...boatMotion,
          color: 0xa67c52,
        }),
        box('body:mast', 'Mástil', mastPos.x, mastPos.y, 0.06, 0.7, 'wood', {
          density: 400,
          ...boatMotion,
          color: 0x6b4423,
        }),
        box('body:crate', 'Caja de cubierta', cratePos.x, cratePos.y, 0.22, 0.18, 'wood', {
          density: 700,
          angle: hullAngle,
          vx: 0.4,
          friction: 0.35,
          restitution: 0.1,
        }),
        box('body:debris-a', 'Restos A', -4.2, surfaceY + 0.35, 0.28, 0.2, 'wood', {
          density: 500,
          vx: 3.5,
          vy: 0.2,
          omega: 2,
        }),
        box('body:debris-b', 'Restos B', -5.2, surfaceY + 0.8, 0.2, 0.2, 'plastic', {
          density: 800,
          vx: 4.2,
          vy: -0.5,
          omega: -1.5,
        }),
        ball('body:hail-1', 'Granizo 1', -2.5, 5.2, 0.16, 'ice', {
          vx: 2.5,
          vy: -1,
          restitution: 0.35,
          ccd: true,
        }),
        ball('body:hail-2', 'Granizo 2', -1.2, 5.8, 0.12, 'ice', {
          vx: 1.8,
          vy: -0.5,
          restitution: 0.35,
          ccd: true,
        }),
        ball('body:hail-3', 'Granizo 3', 1.5, 5.5, 0.14, 'ice', {
          vx: -0.8,
          vy: -1.2,
          restitution: 0.35,
          ccd: true,
        }),
        ball('body:hail-4', 'Granizo 4', 3.2, 6.1, 0.18, 'stone', {
          density: 1800,
          vx: -2.2,
          vy: -2,
          restitution: 0.2,
          ccd: true,
        }),
      ]
      doc.joints = [
        {
          id: 'joint:cabin',
          kind: 'fixed',
          bodyA: 'body:hull',
          bodyB: 'body:cabin',
          anchorA: { x: cabinLocal.x, y: cabinLocal.y - 0.28 },
          anchorB: { x: 0, y: -0.28 },
          frameA: 0,
          frameB: 0,
        },
        {
          id: 'joint:mast',
          kind: 'fixed',
          bodyA: 'body:hull',
          bodyB: 'body:mast',
          anchorA: { x: mastLocal.x, y: mastLocal.y - 0.7 },
          anchorB: { x: 0, y: -0.7 },
          frameA: 0,
          frameB: 0,
        },
      ]
      doc.fluidRegions = [
        {
          id: 'fluid:sea',
          name: 'Mar',
          polygon: [
            { x: -6.4, y: 0 },
            { x: 6.4, y: 0 },
            { x: 6.4, y: surfaceY },
            { x: -6.4, y: surfaceY },
          ],
          restSurfaceY: surfaceY,
          materialId: 'water',
        },
      ]
      doc.camera = { x: 0, y: 2.4, pixelsPerMeter: 42 }
      doc.visualization.velocity = true
      doc.visualization.contacts = true
      doc.visualization.gravity = false
      return doc
    },
  },
  {
    id: 'spill-cup',
    title: 'Vaso que se derrama',
    build: () => {
      const doc = base(
        'Vaso que se derrama',
        'Fluido de partículas (PBF): el agua se contiene entre sólidos y puede derramarse. ' +
          'Play: el vaso ya va inclinándose. Usa Fuerza para empujar más.',
      )
      const cupX = 0
      const cupY = 1.4
      const cupAngle = (-25 * Math.PI) / 180
      const wall = (id: string, name: string, lx: number, ly: number, hx: number, hy: number) => {
        const c = Math.cos(cupAngle)
        const s = Math.sin(cupAngle)
        return box(id, name, cupX + lx * c - ly * s, cupY + lx * s + ly * c, hx, hy, 'stone', {
          type: 'dynamic',
          angle: cupAngle,
          omega: -0.8,
          density: 1200,
          friction: 0.5,
          restitution: 0.05,
        })
      }
      doc.bodies = [
        box('body:ground', 'Suelo', 0, -0.25, 8, 0.25, 'stone', { type: 'fixed' }),
        box('body:table', 'Mesa', 0, 0.4, 2.2, 0.12, 'wood', { type: 'fixed' }),
        wall('body:cup-bottom', 'Fondo vaso', 0, 0, 0.55, 0.08),
        wall('body:cup-left', 'Pared izq.', -0.5, 0.45, 0.08, 0.5),
        wall('body:cup-right', 'Pared der.', 0.5, 0.45, 0.08, 0.5),
        ball('body:cork', 'Corcho', 1.8, 2.2, 0.18, 'wood', {
          density: 400,
          vx: -1.5,
          vy: 0.5,
        }),
      ]
      doc.joints = [
        {
          id: 'joint:cup-l',
          kind: 'fixed',
          bodyA: 'body:cup-bottom',
          bodyB: 'body:cup-left',
          anchorA: { x: -0.5, y: 0.08 },
          anchorB: { x: 0, y: -0.5 },
          frameA: 0,
          frameB: 0,
        },
        {
          id: 'joint:cup-r',
          kind: 'fixed',
          bodyA: 'body:cup-bottom',
          bodyB: 'body:cup-right',
          anchorA: { x: 0.5, y: 0.08 },
          anchorB: { x: 0, y: -0.5 },
          frameA: 0,
          frameB: 0,
        },
      ]
      // Seed water inside the cup (local AABB transformed roughly to world).
      const c = Math.cos(cupAngle)
      const s = Math.sin(cupAngle)
      const corners = [
        { x: -0.35, y: 0.15 },
        { x: 0.35, y: 0.15 },
        { x: 0.35, y: 0.75 },
        { x: -0.35, y: 0.75 },
      ].map((p) => ({
        x: cupX + p.x * c - p.y * s,
        y: cupY + p.x * s + p.y * c,
      }))
      doc.fluidVolumes = [
        {
          id: 'fluid:cup',
          name: 'Agua del vaso',
          polygon: corners,
          materialId: 'water',
          spacing: 0.1,
        },
      ]
      doc.camera = { x: 0, y: 1.6, pixelsPerMeter: 70 }
      doc.visualization.fluidParticles = true
      doc.visualization.contacts = true
      return doc
    },
  },
  {
    id: 'particle-tank',
    title: 'Contención en vaso',
    build: () => {
      const doc = base(
        'Contención en vaso',
        'Fluido libre en un vaso fijo en U. El agua debe quedarse dentro sin atravesar las paredes. ' +
          'Puedes echar más fluido (E) o empujar con Fuerza.',
      )
      doc.bodies = [
        box('body:ground', 'Suelo', 0, -0.25, 6, 0.25, 'stone', { type: 'fixed' }),
        box('body:cup-bottom', 'Fondo', 0, 0.15, 0.7, 0.1, 'stone', { type: 'fixed' }),
        box('body:cup-left', 'Pared izq.', -0.7, 0.85, 0.1, 0.7, 'stone', { type: 'fixed' }),
        box('body:cup-right', 'Pared der.', 0.7, 0.85, 0.1, 0.7, 'stone', { type: 'fixed' }),
      ]
      doc.fluidVolumes = [
        {
          id: 'fluid:cup',
          name: 'Agua',
          polygon: [
            { x: -0.55, y: 0.3 },
            { x: 0.55, y: 0.3 },
            { x: 0.55, y: 1.2 },
            { x: -0.55, y: 1.2 },
          ],
          materialId: 'water',
          spacing: 0.09,
        },
      ]
      doc.camera = { x: 0, y: 1.0, pixelsPerMeter: 90 }
      doc.visualization.fluidParticles = true
      return doc
    },
  },
  {
    id: 'wood-splash',
    title: 'Madera al agua',
    build: () => {
      const surfaceY = 1.6
      const doc = base(
        'Madera al agua',
        'Bloque de madera (ρ≈600) cae sobre agua analítica (Arquímedes, superficie plana). ' +
          'Flota con fracción sumergida ≈ ρ_madera / ρ_agua. Misma física que «Flotación».',
      )
      doc.bodies = [
        box('body:ground', 'Suelo', 0, -0.25, 7, 0.25, 'stone', { type: 'fixed' }),
        box('body:left', 'Pared izq.', -2.2, 1.1, 0.12, 1.2, 'stone', { type: 'fixed' }),
        box('body:right', 'Pared der.', 2.2, 1.1, 0.12, 1.2, 'stone', { type: 'fixed' }),
        box('body:wood', 'Madera', 0, 2.6, 0.4, 0.22, 'wood', {
          linearDamping: 0.15,
          angularDamping: 0.2,
          restitution: 0.1,
          lockRotation: true,
        }),
      ]
      doc.fluidRegions = [
        {
          id: 'fluid:pool',
          name: 'Piscina',
          polygon: [
            { x: -2.0, y: 0 },
            { x: 2.0, y: 0 },
            { x: 2.0, y: surfaceY },
            { x: -2.0, y: surfaceY },
          ],
          restSurfaceY: surfaceY,
          materialId: 'water',
        },
      ]
      doc.camera = { x: 0, y: 1.8, pixelsPerMeter: 55 }
      doc.visualization.gravity = true
      doc.visualization.velocity = true
      return doc
    },
  },
  {
    id: 'stone-sinks',
    title: 'Piedra que se hunde',
    build: () => {
      const surfaceY = 1.6
      const doc = base(
        'Piedra que se hunde',
        'Piedra (ρ≈2600) cae en el mismo tanque analítico. Como ρ > ρ_agua, se hunde hasta el fondo; ' +
          'el arrastre amortigua la caída. Contrasta con «Madera al agua».',
      )
      doc.bodies = [
        box('body:ground', 'Suelo', 0, -0.25, 7, 0.25, 'stone', { type: 'fixed' }),
        box('body:left', 'Pared izq.', -2.2, 1.1, 0.12, 1.2, 'stone', { type: 'fixed' }),
        box('body:right', 'Pared der.', 2.2, 1.1, 0.12, 1.2, 'stone', { type: 'fixed' }),
        box('body:rock', 'Piedra', 0, 3.0, 0.28, 0.28, 'stone', {
          linearDamping: 0.05,
          restitution: 0.05,
          lockRotation: true,
        }),
      ]
      doc.fluidRegions = [
        {
          id: 'fluid:pool',
          name: 'Piscina',
          polygon: [
            { x: -2.0, y: 0 },
            { x: 2.0, y: 0 },
            { x: 2.0, y: surfaceY },
            { x: -2.0, y: surfaceY },
          ],
          restSurfaceY: surfaceY,
          materialId: 'water',
        },
      ]
      doc.camera = { x: 0, y: 1.6, pixelsPerMeter: 55 }
      doc.visualization.gravity = true
      return doc
    },
  },
  {
    id: 'dual-drop',
    title: 'Flota vs hunde',
    build: () => {
      const surfaceY = 1.5
      const doc = base(
        'Flota vs hunde',
        'Madera (izq., ρ≈600) y piedra (der., ρ≈2600) caen a la vez en agua analítica (Arquímedes). ' +
          'Compara flotación vs hundimiento con la misma física que «Flotación».',
      )
      doc.bodies = [
        box('body:ground', 'Suelo', 0, -0.25, 8, 0.25, 'stone', { type: 'fixed' }),
        box('body:left', 'Pared izq.', -3.0, 1.1, 0.12, 1.2, 'stone', { type: 'fixed' }),
        box('body:mid', 'Separador', 0, 0.7, 0.08, 0.8, 'stone', { type: 'fixed' }),
        box('body:right', 'Pared der.', 3.0, 1.1, 0.12, 1.2, 'stone', { type: 'fixed' }),
        box('body:wood', 'Madera', -1.4, 3.0, 0.35, 0.2, 'wood', {
          lockRotation: true,
          linearDamping: 0.1,
        }),
        box('body:rock', 'Piedra', 1.4, 3.0, 0.28, 0.28, 'stone', {
          lockRotation: true,
          linearDamping: 0.05,
        }),
      ]
      doc.fluidRegions = [
        {
          id: 'fluid:left',
          name: 'Piscina izq.',
          polygon: [
            { x: -2.8, y: 0 },
            { x: -0.15, y: 0 },
            { x: -0.15, y: surfaceY },
            { x: -2.8, y: surfaceY },
          ],
          restSurfaceY: surfaceY,
          materialId: 'water',
        },
        {
          id: 'fluid:right',
          name: 'Piscina der.',
          polygon: [
            { x: 0.15, y: 0 },
            { x: 2.8, y: 0 },
            { x: 2.8, y: surfaceY },
            { x: 0.15, y: surfaceY },
          ],
          restSurfaceY: surfaceY,
          materialId: 'water',
        },
      ]
      doc.camera = { x: 0, y: 1.6, pixelsPerMeter: 48 }
      doc.visualization.gravity = true
      doc.visualization.velocity = true
      return doc
    },
  },
]

export function experimentById(id: string): SceneDocument | null {
  return EXPERIMENTS.find((e) => e.id === id)?.build() ?? null
}
