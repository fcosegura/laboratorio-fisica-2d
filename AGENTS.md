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

1. **Toda mutación persistente de `SceneDocument` pasa por `History`.** Crear, borrar, duplicar, unir, gravedad, escala de tiempo y confirmar un campo del inspector usan un `Command`. El arrastre en pausa mueve solo Rapier y, al soltar, aplica un `UpdateBodyCommand` con el `orig` vivo del gesto (`poseOf`). No mutes el documento en el sitio.
2. **`bodyToDesc` es la única traducción `SceneBody` → física.** Vive en `src/scene/builder.ts`. `buildWorld` y cualquier `world.addBody(...)` deben usarla. `jointToDesc` es el equivalente para uniones. No copies descriptores a mano en `LabRuntime` ni en el motor.
3. **Nada de `void x` para silenciar `noUnusedLocals`.** O se usa, o se borra. `void promise` en manejadores de UI (fire-and-forget de `reset` / `loadDocument`) sí está bien.

## Capas (`src/`)

Comprobadas en `tests/architecture.test.ts` (tabla declarativa; falla si aparece una carpeta nueva en `src/` sin regla):

| Capa           | Puede importar                                         | No puede importar                                                                                              |
| -------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `core/`        | nada de otras capas                                    | physics, fluids, render, ui, sim, scene, interaction, camera, materials, experiments, app, pixi, react, rapier |
| `physics/`     | core; Rapier solo en `adapters/rapier/`                | fluids, render, ui, sim, scene, interaction, camera, materials, experiments, app, pixi, react                  |
| `sim/`         | physics, scene, fluids, core, materials                | render, ui, app, interaction, camera, experiments, pixi, react                                                 |
| `render/`      | sim, scene, core, camera, interaction, materials       | rapier, react, ui, app, physics, fluids, experiments                                                           |
| `ui/`          | app, scene, materials, interaction, experiments, store | rapier, pixi, physics, sim, render, fluids                                                                     |
| `scene/`       | physics/ports (tipos), core, materials                 | rapier, pixi, react, ui, render, sim, app, fluids, interaction, camera, experiments                            |
| `app/`         | el resto de capas; orquesta                            | rapier, pixi (pasan por physics/render)                                                                        |
| `interaction/` | core, scene                                            | rapier, pixi, react, ui, render, sim, app, fluids, physics, camera, materials, experiments                     |
| `fluids/`      | core, scene, materials, physics/ports                  | rapier, pixi, react, ui, render, sim, app, interaction, camera, experiments                                    |
| `camera/`      | core                                                   | el resto de capas, pixi, react, rapier                                                                         |
| `materials/`   | core                                                   | el resto de capas, pixi, react, rapier                                                                         |
| `experiments/` | scene, materials, core                                 | rapier, pixi, react, ui, render, sim, app, fluids, physics, interaction, camera                                |
| `assets/`      | (estáticos; no código)                                 | cualquier capa de código, pixi, react, rapier                                                                  |

Contratos:

- `physics/ports.ts` es el puerto. Rapier solo vive en `physics/adapters/rapier/`.
- El store de Zustand (`src/app/store.ts`) es **solo UI**. No es dueño del documento.
- `pushUi()` envía copias / datos planos (`structuredClone` o DTOs). No expongas objetos del documento para que React los mute.

## Documento, historial y esquema

- Tipos en `src/scene/document.ts`. Versión: `SCHEMA_VERSION = 1`.
- **`SceneDocument` es siempre condiciones iniciales / autoría**, no la pose viva de Rapier. El arrastre en pausa toma `orig` y el ancla local de `poseOf` (snapshot interpolado / `engine.curr`), no de `bodyOf`. `bodyOf` es solo para propiedades no cinemáticas. Al soltar, `UpdateBodyCommand` usa esa `orig` viva. El inspector, al confirmar un campo de pose o velocidad, persiste el spawn y aplica **solo ese campo** al mundo vivo: editar `x` durante Play no restaura `y`/ángulo de autoría.
- Comandos en `src/scene/commands.ts`. El historial clona con `cloneDocument` (`structuredClone`) antes de `apply` / `invert`. Gravedad y escala de tiempo van por `SetWorldCommand`.
- Rangos editables: un solo descriptor en `src/scene/properties.ts`, consumido por el inspector **y** por Zod.
- Carga: `parseDocument` → `migrateDocument` → `sceneDocumentSchema`. Rechaza NaN, ids duplicados, uniones huérfanas, `massMode: 'explicit'` sin masa, materiales desconocidos, `schemaVersion` futura.
- `IdFactory.seedMax` al cargar, para no reutilizar ids.
- Densidad y masa explícita no son dos fuentes de verdad a la vez.

## Motor y ciclo de vida

- Reloj: `src/sim/clock.ts`. Máximo 5 subpasos por frame; el exceso se cuenta en `stepsDropped` y el acumulador queda `< dt` (si el resto es 0, `α = 1`; no se anula el acumulador a 0 para no interpolar hacia atrás).
- `reload` / `reset` van en `reloadQueue` (una promesa en serie). No lances dos reconstrucciones a la vez.
- `RapierWorld`: guarda `freed`; todos los métodos públicos deben no-op o devolver vacío tras `destroy()`. `addBody` con id existente elimina antes.
- `PixiRenderer.init()` crea los contenedores. Tras `destroy()`, `draw()` no debe tocar nodos destruidos.
- `appliedForces` se vacía al inicio de cada `physicsStep`. Fuerza sostenida / agarre van en `persistentForces`.
- Picking: `engine.bodyAt` usa `pointHit` de Rapier y, si falla (pausa, sensores), `pickBody` sobre la geometría de la escena.
- Fluido: regiones analíticas (Arquímedes + arrastre Stokes/cuadrático), no partículas ni SPH. Cápsula = estadio; el recorte de superficie es el semiplano alineado con `−g`.

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

Ya está corregido (no reviertas): arrastre en pausa con `orig` de la pose viva; `bodyToDesc` unificado; cola de `reload`; guardias `freed`; AABBs de cápsula/convex/polyline; picking por geometría; `appliedForces` por paso; `Num` con confirmación.

Sigue abierto (el plan en `docs/plan-de-mejora.md`): `syncWorld` incremental en undo/redo (hoy hay `reload` completo); transacciones `history.begin/commit`; extraer `LabRuntime`; inspector de regiones de fluido; capas `trajectories` / `colliders` reales; asas de rotar/escalar.

## Pruebas

- Física: `tests/physics.test.ts`, `tests/fluids.test.ts` — tolerancias deliberadas; no las aflojes para hacer pasar un cambio.
- Esquema e historial: `tests/schema.test.ts`, `tests/commands.test.ts` (el undo restaura el **índice** del array).
- Interacción: `src/interaction/fsm.test.ts` contra `reduceDown`, no contra una copia.
- No añadas tests que importen Rapier desde `ui/` o Pixi desde `sim/`.
