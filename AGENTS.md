# Guía para agentes — Laboratorio de Física 2D

Sandbox de física 2D en el navegador. React no calcula física. El bucle vive en `LabRuntime`.

```
SceneDocument (autoría)
  → History / Command
  → SimulationEngine
  → Rapier 2D + fluido analítico
  → snapshot interpolado
  → PixiJS
```

Unidades: **metros**. Eje Y **hacia arriba**. Paso fijo: `PHYSICS_DT = 1/60`.

Este repo está conectado a [Lovable](https://lovable.dev). No reescribas historial publicado (`push --force`, rebase, amend, squash de commits ya empujados).

## Verificar siempre

```bash
npm test
npm run typecheck
npm run lint
```

Tras un cambio de capas o imports, `tests/architecture.test.ts` debe seguir pasando.

## Tres invariantes

1. **Toda mutación persistente de `SceneDocument` pasa por `History`.** Crear, borrar, duplicar, unir y confirmar un campo del inspector usan un `Command`. El arrastre en pausa mueve solo Rapier y, al soltar, aplica un `UpdateBodyCommand` con el `orig` del gesto. No mutes el documento en el sitio (no uses `patchBody` para escritura pública).
2. **`bodyToDesc` es la única traducción `SceneBody` → física.** Vive en `src/scene/builder.ts`. `buildWorld` y cualquier `world.addBody(...)` deben usarla. `jointToDesc` es el equivalente para uniones. No copies descriptores a mano en `LabRuntime` ni en el motor.
3. **Nada de `void x` para silenciar `noUnusedLocals`.** O se usa, o se borra. `void promise` en manejadores de UI (fire-and-forget de `reset` / `loadDocument`) sí está bien.

## Capas (`src/`)

Comprobadas en `tests/architecture.test.ts`:

| Capa | Puede importar | No puede importar |
| --- | --- | --- |
| `core/` | nada de otras capas | physics, fluids, render, ui, sim, scene, pixi, react, rapier |
| `physics/` | core | render, ui, sim, pixi, react |
| `sim/` | physics, scene, fluids, core | pixi, react, render |
| `render/` | sim, scene, core, camera | rapier, react |
| `ui/` | app, scene, store | rapier, pixi |
| `scene/` | physics/ports (tipos), core, materials | rapier, pixi, react |
| `app/` | todo lo anterior; orquesta | — |

Contratos:

- `physics/ports.ts` es el puerto. Rapier solo vive en `physics/adapters/rapier/`.
- El store de Zustand (`src/app/store.ts`) es **solo UI**. No es dueño del documento.
- `pushUi()` envía copias / datos planos. No expongas objetos del documento para que React los mute.

## Documento, historial y esquema

- Tipos en `src/scene/document.ts`. Versión: `SCHEMA_VERSION = 1`.
- Comandos en `src/scene/commands.ts`. El historial clona con `cloneDocument` (`structuredClone`) antes de `apply` / `invert`.
- Rangos editables: un solo descriptor en `src/scene/properties.ts`, consumido por el inspector **y** por Zod.
- Carga: `parseDocument` → `migrateDocument` → `sceneDocumentSchema`. Rechaza NaN, ids duplicados, uniones huérfanas, `massMode: 'explicit'` sin masa, materiales desconocidos, `schemaVersion` futura.
- `IdFactory.seedMax` al cargar, para no reutilizar ids.
- Densidad y masa explícita no son dos fuentes de verdad a la vez.

## Motor y ciclo de vida

- Reloj: `src/sim/clock.ts`. Máximo 5 subpasos por frame; el resto se descarta.
- `reload` / `reset` van en `reloadQueue` (una promesa en serie). No lances dos reconstrucciones a la vez.
- `RapierWorld`: guarda `freed`; todos los métodos públicos deben no-op o devolver vacío tras `destroy()`. `addBody` con id existente elimina antes.
- `PixiRenderer.init()` crea los contenedores. Tras `destroy()`, `draw()` no debe tocar nodos destruidos.
- `appliedForces` se vacía al inicio de cada `physicsStep`. Fuerza sostenida / agarre van en `persistentForces`.
- Picking: `engine.bodyAt` usa `pointHit` de Rapier y, si falla (pausa, sensores), `pickBody` sobre la geometría de la escena.
- Fluido: regiones analíticas (Arquímedes + arrastre), no partículas. Cápsula ≈ círculo; gravedad no vertical está soportada en el solver pero es un caso raro.

## Interacción y UI

- `reduceDown` en `src/interaction/machine.ts` es el reductor puro de pointer-down. Extiéndelo ahí; no dupliques la máquina en tests.
- Inspector: `Num` confirma en `blur` / `Enter` con `parseAndClamp`. Nunca escribas `Number(input)` en cada tecla al documento.
- Play / pausa: Espacio. Paso: `.`. Zoom anclado al cursor. Unidades de ángulo en el inspector: grados; en el documento: radianes.
- Textos de UI en español. Identificadores de código en inglés.

## Estilo de código

- TypeScript estricto, `verbatimModuleSyntax`, imports con extensión `.ts` / `.tsx`.
- Prettier: sin punto y coma, comillas simples, `trailingComma: 'all'`, `printWidth: 100`.
- `oxlint` en `src` y `tests`.

## Qué no reabrir como si estuviera roto

Ya está corregido (no reviertas): arrastre en pausa con `orig` explícito; `bodyToDesc` unificado; cola de `reload`; guardias `freed`; AABBs de cápsula/convex/polyline; picking por geometría; `appliedForces` por paso; `Num` con confirmación.

Sigue abierto (el plan en `docs/plan-de-mejora.md`): `syncWorld` incremental en undo/redo (hoy hay `reload` completo); transacciones `history.begin/commit`; extraer `LabRuntime`; inspector de regiones de fluido; capas `trajectories` / `colliders` reales; asas de rotar/escalar.

## Pruebas

- Física: `tests/physics.test.ts`, `tests/fluids.test.ts` — tolerancias deliberadas; no las aflojes para hacer pasar un cambio.
- Esquema e historial: `tests/schema.test.ts`, `tests/commands.test.ts` (el undo restaura el **índice** del array).
- Interacción: `src/interaction/fsm.test.ts` contra `reduceDown`, no contra una copia.
- No añadas tests que importen Rapier desde `ui/` o Pixi desde `sim/`.
