# Plan de mejora — Laboratorio de Física 2D

Plan derivado de [`docs/revision-estatica.md`](./revision-estatica.md), sobre `320a865`. Las fases están
ordenadas por dependencia técnica, no por calendario: cada una deja el repositorio en un estado coherente
y las siguientes se apoyan en las invariantes que la anterior establece.

## El problema de fondo

Los ocho defectos de severidad alta no son ocho errores independientes. Salen de tres decisiones de
arquitectura que hoy no se sostienen:

1. **El documento de escena tiene tres dueños.** El historial de comandos clona y sustituye
   (`History.apply` → `cloneDocument`), `patchBody` muta en el sitio, y el inspector escribe por un
   tercer camino. De ahí A5 (el undo del arrastre no deshace), M11 (un comando por tecla) y la
   fragilidad de las referencias que viajan al store de React.
2. **La traducción autoría → física está duplicada cuatro veces.** `bodyToDesc` es la versión correcta y
   `LabRuntime` no la usa (A7). Cada copia olvidó campos distintos, así que el estado del motor depende
   del camino por el que se creó el cuerpo.
3. **Nadie es dueño del ciclo de vida.** `mount`/`dispose`/`reload` compiten entre sí y con el bucle de
   animación, sin serializar y sin guardias completas: A2 (renderizador irreutilizable), A6 (reload
   solapado), M13 (uso después de liberar).

El plan ataca las tres antes de tocar funcionalidad nueva. Corregir los síntomas uno a uno sin cerrar
estas grietas garantiza que vuelvan por otra vía.

---

## Fase 0 — Cortar la corrupción de datos

Objetivo: que sea imposible que la interfaz produzca una escena que el cargador rechace, y que el motor
no reciba números no finitos. Es lo primero porque A1 destruye trabajo del usuario de forma silenciosa.

| Tarea | Corrige | Tocar |
| --- | --- | --- |
| Descriptor de propiedades único (mín, máx, paso, unidad) por campo editable, consumido por el inspector y por el esquema zod | A1, M8 | nuevo `scene/properties.ts`, `ui/Inspector.tsx`, `scene/schema.ts` |
| Campo numérico que rechaza entradas no finitas, acota al rango y confirma en `blur`/`Enter` | A1, M11 | `ui/Inspector.tsx` |
| Sembrar `mass` con la masa real del snapshot al cambiar a modo explícito; validar `massMode: 'explicit' ⇒ mass` en el esquema | M7 | `ui/Inspector.tsx`, `scene/schema.ts` |
| Mensaje de error visible al importar un JSON inválido | M9 | `ui/TimeBar.tsx` |
| Guardia de versión futura y migración desde documentos sin `schemaVersion` | B9 | `scene/schema.ts` |
| Validación cruzada al cargar: ids únicos, uniones que referencian cuerpos existentes, `materialId` conocido | B10, A8 | `scene/schema.ts` |

Verificación: round-trip de una escena con valores en los límites de cada rango; una escena con un campo
vacío o a medio escribir debe seguir guardándose y abriéndose.

## Fase 1 — Un solo dueño del documento

Objetivo: que toda mutación de `SceneDocument` pase por el historial y que el motor se sincronice de forma
incremental, sin reconstruir el mundo.

- **Prohibir la mutación directa.** Retirar `patchBody` como escritura pública; durante un arrastre mover
  únicamente el cuerpo de Rapier y dibujar desde el snapshot. Al soltar, aplicar un `UpdateBodyCommand`
  construido con el `orig` que la máquina de estados ya guarda (corrige **A5**).
- **Transacciones de historial.** `history.begin()` / `commit()` / `abort()`, con coalescencia por
  (id, propiedad) mientras el foco no cambie y por gesto en el caso del arrastre. Un arrastre y un número
  escrito a mano deben ser un solo Ctrl+Z (corrige **M11**, **B14**).
- **Sincronización incremental.** Sustituir `void this.engine.reload(this.engine.doc)` en undo/redo por un
  `syncWorld(prevDoc, nextDoc)` que aplique altas, bajas y parches al mundo existente: conserva `simTime`,
  las series de las gráficas y las velocidades de los cuerpos no afectados (corrige **A6**).
- **Serializar las reconstrucciones** que sigan siendo necesarias (cargar, reiniciar, cambiar de forma):
  una única promesa en curso, sin solapamiento.
- **Snapshots inmutables hacia React.** `pushUi` debe enviar copias planas de lo que la interfaz necesita,
  no referencias a objetos del documento que se mutan por detrás.

Verificación: prueba de propiedad sobre una secuencia aleatoria de comandos (añadir, borrar, mover,
editar, unir) comprobando que deshacer todo devuelve exactamente el documento inicial, incluido el orden
de los arrays (corrige también **B2**).

## Fase 2 — Ciclo de vida del renderizador y del mundo físico

Objetivo: que montar, desmontar y remontar sea una operación segura y repetible.

- **`PixiRenderer` reconstruible.** Crear los contenedores dentro de `init()` en lugar de como campos de
  instancia, y dejar el objeto explícitamente inutilizable tras `destroy()` (corrige **A2**).
- **Reserva de etiquetas.** Reutilizar objetos `Text` indexados por clave, o destruir los hijos retirados;
  nunca crear `TextStyle` en el bucle de dibujo (corrige **A3**).
- **Vaciar `appliedForces`** al inicio de cada paso físico, o mantener una ventana temporal explícita si se
  quiere que la flecha de impulso persista unos frames (corrige **A4**).
- **Guardias `freed` en todos los métodos públicos de `RapierWorld`** (corrige **M13**).
- **`addBody` idempotente:** si el id existe, eliminar antes o fallar con un error explícito
  (corrige **M14**).
- **Resembrar `IdFactory`** al cargar un documento con el máximo sufijo presente (corrige **A8**).

Verificación: montar, desmontar y volver a montar el lienzo debe dejar la escena dibujándose; el bucle no
debe registrar nada en `console.error`. Conviene que el `catch` del bucle deje de tragar errores en
silencio y los cuente en el HUD.

## Fase 3 — Corrección física y de datos

Objetivo: que los números que el laboratorio muestra sean los que dice mostrar.

| Tarea | Corrige |
| --- | --- |
| Iterar `numSolverContacts()` para la geometría del solver (o transformar `localContactPoint1`), en vez de mezclar índices | M2 |
| Repartir la masa explícita entre las piezas convexas por área, o fijarla en el cuerpo rígido | M1 |
| Guardar el polígono del cuerpo sin recortar y aplicar el segundo recorte con `surfaceY` para que el ascenso de nivel afecte al empuje | M3 |
| Muestrear el registrador con el instante real de cada subpaso | M6 |
| `unobserve` al deseleccionar y al cargar escena; límite de pistas vivas | M15 |
| Índice `Map<BodyId, BodySnapshot>` por paso para `interpolated` | B1 |
| Documentar o corregir las limitaciones del fluido (gravedad no vertical, cápsula aproximada por círculo) y la energía potencial con datum implícito | B6, B13 |

Verificación: caída libre y tiro parabólico contra la solución analítica (ya existen); añadir conservación
de energía en colisión elástica, fracción sumergida frente a ρ_cuerpo/ρ_fluido con el nivel ascendido, y
una prueba de que las marcas de tiempo del registrador son estrictamente crecientes con varios subpasos
por frame.

## Fase 4 — Interacción: cerrar lo que ya está a medias

Objetivo: que las funciones que aparentan existir funcionen. Todas son visibles al primer uso.

- **Máquina de estados real.** Extraer `onDown`/`onMove`/`onUp` a un reductor puro en
  `interaction/machine.ts` y reescribir `fsm.test.ts` contra él. Hoy el test prueba una copia privada y
  por eso la marquesina pudo quedarse sin implementar (corrige **B8**).
- **Marquesina funcional:** al soltar, seleccionar los cuerpos cuyo AABB intersecte el rectángulo
  (corrige **M4**).
- **Sincronizar `visualization`** entre documento y store al cargar y al exportar, para que experimentos y
  archivos guardados apliquen sus capas (corrige **M5**).
- **Pinza correcta:** aplicar `clampPpm` y anclar el zoom al punto medio de los dos punteros reutilizando
  `zoomAt` (corrige **M10**).
- **Paneo con espacio:** implementar `keydown`/`keyup` sobre `spaceHeld` resolviendo el conflicto con
  play/pausa, o retirar el estado y la línea del README (corrige **M12**).
- **Rotar y escalar en el lienzo** con asas, usando el estado `rotating` ya declarado (corrige **B17**).
- **Selección múltiple coherente:** contador en el inspector, edición de propiedades comunes, y un único
  comando de historial para borrar o duplicar el conjunto (corrige **B14**).
- **Cierre del polígono sin vértices espurios** (corrige **B16**) y **picking determinista** por
  profundidad, excluyendo sensores (corrige **B15**).

## Fase 5 — Deuda declarada: implementar o retirar

Cada elemento aquí es una promesa del código o del README que hoy no se cumple. La decisión por elemento
es binaria; lo que no se implemente debe salir del tipo, del esquema y del README, no quedarse silenciado
con un `void`.

- Regiones de fluido borrables y editables: `RemoveFluidCommand` está escrito y nunca se llama; falta
  inspector de región (material, nivel, polígono) (**B5**).
- Formas sin herramienta de creación: cápsula, polilínea, segmento; y sin rama de dibujo: polilínea y
  compuesta (**B3**, **B4**).
- Capas de visualización declaradas y no implementadas: `trajectories` (que un experimento activa),
  `fluidParticles`, y `colliders`, que hoy dibuja un circulito en el centro en lugar de los
  colisionadores reales (**B4**).
- Paneles colapsables: `inspectorOpen`, `graphsOpen` y `debugHud` existen en el store sin ningún control
  en la interfaz (**B4**).
- `particleCount` siempre a 0 en el HUD (**B4**).
- Limpieza de los nueve `void X` y de la API pública sin consumidores (`hasBody`, `setCcd`, `clearForces`,
  `projectPoint`, `getColliders`, `forEachBody`, `experimentById`, `asBodyId`, `resetCamera`,
  `RingBuffer.last`, `ShapeKind`, `Pointer`, `InteractionEvent`, estados `hovering`/`pinching`) (**B7**).
- Detalles de recursos: `revokeObjectURL` al guardar, `profilerEnabled` sólo cuando el HUD lo pida, hoja
  de estilos del inspector fuera del render, `manifold.normal()` fuera del bucle interno (**B11**).
- Gráfica con `devicePixelRatio` y tamaño real del lienzo (**B12**).

## Fase 6 — Estructura y red de seguridad

Objetivo: que el repositorio resista la siguiente ronda de cambios.

- **Partir `LabRuntime` (843 líneas, 6 responsabilidades).** Separar entrada de puntero y teclado, edición
  de la escena, bucle de frame y puente con el store. Es el archivo donde se concentran cinco de los ocho
  defectos altos, y ninguna prueba lo toca.
- **Acciones en el store.** Hoy hay `useLabStore.setState({...})` disperso por cuatro componentes y por el
  runtime; con acciones nombradas el flujo de estado de interfaz se puede seguir y probar.
- **Cobertura donde hoy no hay nada:** el reductor de interacción, el historial como propiedad, el
  round-trip del esquema en los límites de los rangos, y una prueba que afirme que ningún camino de
  edición puede introducir un valor no finito en el documento.
- **Un `AGENTS.md`/`CONTRIBUTING.md` corto** con las tres invariantes que este plan establece: toda
  mutación del documento pasa por el historial; `bodyToDesc` es la única traducción a física; nada de
  `void X` para silenciar `noUnusedLocals` — o se usa, o se borra. (Hecho: ver raíz del repo y
  `.cursor/rules/`.)

---

## Orden recomendado y dependencias

```
Fase 0 (datos)  ──┬─▶ Fase 1 (dueño del documento) ──┬─▶ Fase 4 (interacción)
                  │                                   │
                  └─▶ Fase 2 (ciclo de vida) ─────────┴─▶ Fase 5 (deuda declarada)
                                │
                                └─▶ Fase 3 (física y datos) ──▶ Fase 6 (estructura y pruebas)
```

Las fases 0 y 2 son independientes entre sí y pueden avanzar en paralelo. La fase 1 debe cerrarse antes de
la 4, porque la marquesina, la multiselección y las asas de rotación generan mutaciones nuevas y sin
transacciones de historial multiplicarían el problema de M11. La fase 6 se apoya en que la 1 y la 4 hayan
dejado la lógica extraída y con contratos claros.

## Riesgos

- **La sincronización incremental (fase 1) es la parte delicada.** Sustituir un `reload` completo por
  altas/bajas/parches puede introducir divergencias entre documento y mundo si algún campo se olvida. Es
  exactamente el fallo que ya existe (A7), así que la mitigación es la misma que la corrección: una única
  función de traducción y una comprobación de coherencia en modo depuración.
- **Cambiar el modelo de eventos del inspector (confirmar en `blur`) altera el flujo de trabajo.** Merece
  la pena mantener la respuesta inmediata en el lienzo mientras se escribe, pero sin escribir en el
  documento hasta confirmar.
- **Corregir M1, M2, M3 y M6 cambia números que hoy alguien podría haber tomado como referencia.** Las
  pruebas de física existentes tienen tolerancias amplias y probablemente sigan pasando; conviene apretar
  esas tolerancias en la fase 3 para que el cambio quede fijado.
- **Las fases 0 y 4 tocan el esquema.** Cualquier restricción nueva debe entrar como validación tolerante
  (avisar y acotar al cargar) antes de volverse un rechazo, o las escenas guardadas con la versión actual
  dejarán de abrirse.
