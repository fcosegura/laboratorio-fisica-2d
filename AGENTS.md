# Guía para agentes — Laboratorio de Física 2D

Sandbox de física 2D en el navegador. React no calcula física. El bucle vive en `LabRuntime`.

```
SceneDocument (autoría)
  → History / Command
  → SimulationEngine
  → Rapier 2D + fluido analítico / partículas PBF
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
- `appliedForces` se vacía al inicio de cada `physicsStep`. La fuerza sostenida va en `persistentForces`. El arrastre en Play va en `engine.grab`: muelle críticamente amortiguado hacia el cursor + compensación de gravedad, recalculado en cada paso con la velocidad viva (no lo congeles en `pointermove`).
- Propulsor y viento (`src/sim/forces.ts`), leídos del documento en cada `physicsStep` desde la pose viva al inicio del paso, y empujados a `appliedForces`:
  - `SceneBody.thruster` (opcional): fuerza constante en N, dirección en el marco del cuerpo (`followsBody`, cohete) o del mundo, punto de aplicación local (fuera del CM da par). Herramienta 🚀 (T) o inspector.
  - `world.wind` (opcional): sin él, vacío como antes. Con él, arrastre `½ρC_dA|u|u`, `u = viento − v_CM`, aplicado en el CM; `A` = anchura proyectada de la forma perpendicular a `u`. Con viento 0 queda el rozamiento del aire. Tope `c ≤ m/dt` (como `stableDamping`). Ráfagas: tres senos inconmensurables que viajan con el viento.
  - `doc.fans` (opcional): ventiladores, chorro rectangular (anchura × alcance) desde (x, y) hacia `angle`; perfil de velocidad pleno en el 70 % central con caída coseno a los bordes y `1 − (s/alcance)²` a lo largo; `period > 0` pulsa la velocidad (0 → v → 0). No son cuerpos: nada choca con ellos. Sobre cuerpos: arrastre de aire solo con la anchura del cuerpo que cae dentro del chorro. Sobre partículas (`PbfFluidSolver.applyVelocityChange`, antes de `step`): relaja hacia la velocidad del chorro la componente axial a `FAN_WATER_RATE` = 6/s, en un solo sentido (no frena agua más rápida ni toca la transversal, así no amortigua las olas). Herramienta 🌀 (A); con Seleccionar se arrastra el cuerpo para moverlo y el punto del extremo para orientarlo. Comandos `Add/Remove/UpdateFanCommand`.
- Undo / redo: `engine.syncWorld(prev, next)` aplica solo el diff (altas, bajas, campos). `applyBodyChange` es el único sitio que decide qué campo reconstruye el cuerpo (`REBUILD_KEYS`) y cuál se aplica en vivo; `commitPatch` lo usa también.
- `History.begin()` / `commit()` / `abort()`: varias mutaciones = un solo Ctrl+Z.
- Picking: `engine.bodyAt` usa `pointHit` de Rapier y, si falla (pausa, sensores), `pickBody` sobre la geometría de la escena.
- Fluido: tanques analíticos (Arquímedes + arrastre Stokes/cuadrático; superficie plana, no se derrama) y volúmenes de partículas PBF (`PbfFluid`, Position Based Fluids de Macklin & Müller, incompresible). Cápsula = estadio; el recorte de superficie es el semiplano alineado con `−g`. Flotación didáctica → `fluidRegions`. Derrame / charco → `fluidVolumes`. No mezclar ambos modelos sobre el mismo cuerpo.
- Centro de masas: `BodySnapshot.x/y` es el **origen** del cuerpo; `comX/comY` es el centro de masas y `vx/vy` es su velocidad. Registrador (x, y, Ep), trayectorias y vectores de velocidad / gravedad / CM usan `comX/comY`. Los polígonos dibujados se centran en el centroide de área.
- Arrastre del fluido: `stableDamping` limita `c ≤ m/dt` (nunca invierte ni amplifica v). Por debajo del límite es el explícito sin cambios: las calibraciones de partículas y tanques dependen de ello.
- Polígono hidrostático de círculo / cápsula: escalado para conservar el área exacta (umbral de flotación = ρ_fluido).
- Partículas, solver: PBF. Por subpaso (2 por paso): predicción, colisión, una lista de pares y `PBF_ITERATIONS = 3` iteraciones Jacobi de la restricción de densidad `C_i = ρ_i/ρ0 − 1`, solo `C > 0` (una partícula de superficie con pocos vecinos no tira de nadie). `λ_i = −C_i / (Σ|∇C|² + ε)`, `Δp_i = Σ (λ_i + λ_j + s_corr) ∇W / ρ0`. Velocidad = posiciones / dt, luego XSPH por material. Kernel `W = (1 − r/h)²` (el de Clavet), `ρ0` medido en la red de siembra (`clavetRestDensity`), `ε = PBF_RELAX · Σ|∇C|²` de esa red (`pbfRestGradSq`).
- PBF, `PBF_RELAX = 1.5`: Jacobi sobrecorrige. Con 0,1 un depósito de 5 m hierve y escupe agua por encima de las paredes; con 1 quedan partículas sueltas en un ciclo de periodo 2 (±0,4 m/s sin moverse). A 1,5 la compresión es ≈ 1 % a 5 m de hondo.
- Partículas: un solo kernel (`h`, `ρ0`) para todas; un segundo volumen reutiliza el espaciado vivo. Un volumen dibujado sobre agua viva solo rellena el hueco: las semillas encima de una partícula viva se descartan (el agua incompresible haría estallar la densidad doble).
- Partículas, rendimiento: una lista de pares por subpaso (`CountingSortGrid.collectPairs` → `PairList`) alimenta todas las iteraciones y XSPH; cada iteración guarda `W` y `∇W` por par para la pasada de `Δp`. Jacobi no depende del orden de los pares. ~2,8 µs/partícula/paso (escena del depósito en V a 3000 partículas: 8,4 ms de media, p95 9,4 ms en navegador; Clavet: 8,6 ms).
- Partículas, contorno sólido: densidad de partículas fantasma tras la superficie (`clavetWallTables`: `rho` y `push`, tabulados por distancia) dentro de la restricción de cada partícula; su gradiente solo entra en el `λ` propio (las fantasmas no se mueven). `forEachNearSurface` se muestrea una vez por subpaso y en las iteraciones la distancia sigue a la partícula, `d = d0 + (p − p0)·n`. Para cajas usa el punto más cercano real (`nearBoxSurface`): con `pushOutOfShape` y alcance `h` el agua junto al costado de una caja plana recibía la normal del fondo. Sin fantasmas una partícula junto a la pared tiene falta de vecinos y el agua la aprieta contra la pared: filas apiladas en paredes inclinadas. No escales la contribución en vértices convexos: medido con Clavet, empeora.
- Partículas, límite: `PBF_MAX_PARTICLES = 3000`. Lo que no cabe se descarta y el HUD lo avisa (`particlesTruncated`).
- Partículas → sólidos (`applyBuoyancy`), modelo híbrido:
  - **Agua en ambos flancos** (flotador o sumergido; con histéresis `FLOAT_HOLD_STEPS` para el oleaje): Arquímedes recortado en la superficie estimada en los flancos (`applyArchimedes`), aplicado en el centro de carena. Sin retraso en la fuerza; cabeceo y balanceo amortiguados por radiación de olas (`SPH_HEAVE_DAMPING`, `SPH_ROLL_DAMPING`), que solo ven velocidades y no mueven el calado.
  - **El resto** (recipientes, paredes con agua a un lado, cuerpos secos junto al agua): presión hidrostática integrada solo sobre el contorno **mojado**. El vaso soporta el peso de su agua; un cuerpo seco tras una pared no recibe nada. Las columnas de cada tramo solo cuentan partículas del lado exterior de su cara. La columna de un flanco puede empezar en cualquier altura del cuerpo (un tablón inclinado con un extremo contra la pared tiene el agua del otro flanco encima de lo que lo sostiene). Si el empuje supera 1,2·mg se despierta el cuerpo: uno dormido bajo el agua no subía nunca.
  - **Reacción del contacto**: lo que un sólido que avanza da al agua en el suelo de velocidad de contacto (`m_p · min(u_n − v_n, u_n)`) vuelve al sólido como fuerza (`applyContactReaction`), con tope para no invertir su velocidad. Sin ella el agua incompresible empujada por un flotador era energía gratis: un tablón ancho cabeceaba sin parar y lanzaba el agua a 8 m/s.
- Partículas ↔ colisión: una corrección de posición contra un sólido nunca se convierte en velocidad (eso lanzaba chorros desde las esquinas). Una partícula en contacto toma como mínimo la velocidad normal del punto del sólido (`ContactVelocity`), así un cuerpo en movimiento sigue empujando el agua.

### Simplificaciones deliberadas (documentadas, no son bugs)

- Partículas: velocidad limitada a 8 m/s (`V_MAX`); el agua cae más despacio que un sólido desde más de ~3 m.
- Partículas: el acoplamiento de salpicadura partícula → cuerpo usa `COUPLING = 0.1` con tope `MAX_BODY_IMPULSE`; no conserva momento. La sustentación viene de Arquímedes / presión hidrostática, no de `λ`; la reacción del contacto solo devuelve el momento que el sólido da al agua al avanzar.
- PBF: 3 iteraciones Jacobi con `ε` alto no convergen del todo: ρ/ρ0 ≈ 1,01 a 5 m de hondo (Clavet: ~2,4 de media, ~3,5 en el fondo). Más hondo comprime más; cada iteración extra encarece el paso.
- PBF: agua encerrada en una cavidad sellada por un cuerpo encajado (tablón apoyado en el bloque y la pared) puede quedar circulando: la restricción no se puede satisfacer y las esquinas fantasma empujan de lado. Visto una vez en un barrido con `ε = 2`, no con 1,5.
- Flotadores (tanque analítico y partículas): el amortiguamiento por radiación de olas es un modelo, no ondas simuladas.
- El empuje se multiplica por el `gravityScale` del cuerpo (en rigor depende de la gravedad del fluido). Elección pedagógica: la fracción sumergida en equilibrio no depende de `gravityScale`.
- Combinación de contacto: rozamiento `Min`, restitución `Max` (el hielo desliza, la goma rebota), no la media geométrica habitual.
- La amortiguación lineal / angular del cuerpo es «aire», no propiedad del material: los cuerpos dibujados nacen con 0 y cambiar de material no la toca. Los experimentos con fluido la fijan a mano.
- Viento: `C_d = 1,2` para toda forma; fuerza en el CM (sin par aerodinámico, sin sombra entre cuerpos); actúa también sobre cuerpos sumergidos; no actúa sobre las partículas de fluido.
- Ventilador: sobre los cuerpos siempre sopla aire (también si el cuerpo está sumergido); el agua lo empuja solo a través del acoplamiento partícula → sólido. Los tanques analíticos no ven los ventiladores (superficie plana, no hay olas que hacer).
- La Ep del registrador usa la gravedad global; con `gravityScale ≠ 1` la energía total mostrada no se conserva.

## Interacción y UI

- `reduceDown` / `reduceMove` en `src/interaction/machine.ts` son los reductores puros. Extiéndelos ahí; no dupliques la máquina en tests.
- Entrada (puntero, rueda, teclado y gestos de creación) vive en `src/app/LabInput.ts`; `LabRuntime` conserva ciclo de vida, API de edición (todo por `History`) y `pushUi`.
- Asas (`src/interaction/handles.ts`): rotar / escalar el cuerpo seleccionado y vértices del tanque seleccionado. Solo en pausa con la herramienta Seleccionar. Rotar persiste solo `angle`; escalar persiste `shape`; el tanque debe seguir convexo o el cambio se descarta.
- Inspector: `Num` confirma en `blur` / `Enter` con `parseAndClamp`. Nunca escribas `Number(input)` en cada tecla al documento.
- Play / pausa: Espacio. Paso: `.`. Zoom anclado al cursor. Unidades de ángulo en el inspector: grados; en el documento: radianes.
- Textos de UI en español. Identificadores de código en inglés.

## Estilo de código

- TypeScript estricto, `verbatimModuleSyntax`, imports con extensión `.ts` / `.tsx`.
- Prettier: sin punto y coma, comillas simples, `trailingComma: 'all'`, `printWidth: 100`.
- `oxlint` en `src` y `tests`.

## Qué no reabrir como si estuviera roto

Ya está corregido (no reviertas): arrastre en pausa con `orig` de la pose viva; `bodyToDesc` unificado; cola de `reload`; guardias `freed`; AABBs de cápsula/convex/polyline; picking por geometría; `appliedForces` por paso; `Num` con confirmación; `syncWorld` incremental en undo/redo; transacciones de historial; `LabInput` separado de `LabRuntime`; edición de vértices de tanques; capas `trajectories` / `colliders` reales; asas de rotar / escalar; cinemático por velocidad (`kinematicVelocityBased`); contactos leídos por punto del manifold (no por índice del solver); `clipPolygon` acepta cualquier sentido de giro; solver PBF incompresible (sustituye a Clavet); reacción del contacto en sólidos que avanzan; semillas que no pisan agua viva; distancia real a cajas en el contorno fantasma.

Sigue abierto: tests para lo anterior (aplazados a propósito); orden de las uniones restauradas por undo (se añaden al final, no en su índice); cavidades selladas con agua bajo un cuerpo encajado (ver PBF arriba); el servidor de desarrollo se cuelga a veces al recargar en caliente con la app abierta.

## Pruebas

- Física: `tests/physics.test.ts`, `tests/fluids.test.ts` — tolerancias deliberadas; no las aflojes para hacer pasar un cambio.
- Esquema e historial: `tests/schema.test.ts`, `tests/commands.test.ts` (el undo restaura el **índice** del array).
- Interacción: `src/interaction/fsm.test.ts` contra `reduceDown`, no contra una copia.
- No añadas tests que importen Rapier desde `ui/` o Pixi desde `sim/`.
