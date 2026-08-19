# Revisión estática — Laboratorio de Física 2D

Revisión de lectura de código sobre `320a865`, sin ejecutar la aplicación ni la suite de pruebas.
Herramientas estáticas ejecutadas: `tsc -b --force` y `oxlint src tests`. **Ambas pasan sin errores**,
así que todo lo que sigue son defectos de lógica, de ciclo de vida o de contrato que el compilador no ve.

Alcance: 50 archivos TypeScript, 5 799 líneas en `src/` y `tests/`.

## Resumen

| Severidad | Nº | Naturaleza dominante |
| --- | --- | --- |
| Alta | 8 | Corrupción de datos por NaN, fugas de memoria, ciclo de vida del renderizador, undo que no deshace |
| Media | 15 | Física incorrecta en casos concretos, funciones que no hacen nada, contratos de guardado frágiles |
| Baja | 17 | Rendimiento, código muerto, promesas del README sin implementar |

La causa raíz de la mayoría de los defectos altos es una sola: **el documento de escena se muta por tres
caminos distintos** (el historial de comandos, `patchBody` directo y las escrituras del inspector), y la
traducción de `SceneBody` a descriptor de física está duplicada en cuatro sitios que ya divergieron.

Lo que está bien resuelto y conviene no romper al arreglar el resto: el paso fijo con acumulador
(`sim/clock.ts`), la separación puerto/adaptador de física (`physics/ports.ts` frente a `RapierWorld`),
las pruebas de frontera de capas (`tests/architecture.test.ts`), el manejo de marcos de rotación en la
soldadura (`frameA`/`frameB`), los muelles dimensionados por masa reducida y el recorte hidrostático
por semiplanos.

---

## Severidad alta

### A1. Un campo numérico a medio escribir corrompe la escena y el archivo guardado

```239:251:src/ui/Inspector.tsx
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
```

`Number('')` es `0` y `Number('-')`, `Number('1e')` o `Number('.')` son `NaN`. El `onChange` dispara en
cada pulsación, así que escribir `-3` pasa primero por `NaN` y borrar el campo escribe `0`. Ese valor va
directo a `lab.commitPatch`, que lo mete en el documento y lo empuja a Rapier (`setTransform`,
`setVelocity`, `setDensity`). Un `NaN` en posición o velocidad contamina el solver y el cuerpo desaparece.

El daño no acaba ahí: `JSON.stringify(NaN)` produce `null`, y el esquema exige `z.number()`, de modo que
**una escena que contenga un NaN se guarda sin avisar y ya no se puede volver a abrir**.

Corrección: parsear con validación (rechazar entradas no finitas), aplicar el clamp del campo, y
confirmar en `blur`/`Enter` en lugar de en cada tecla.

### A2. `PixiRenderer` no se puede reutilizar después de `destroy()`

```99:103:src/render/PixiRenderer.ts
  destroy(): void {
    this.app?.destroy({ removeView: false }, { children: true })
    this.app = null
    this.bodyGfx.clear()
  }
```

`world`, `grid`, `fluids`, `bodiesLayer`, `overlay` y `labels` son campos de instancia creados una única
vez, pero se añaden al `stage` en `init()` (líneas 85-87) y `app.destroy(..., { children: true })` los
destruye en cascada. En Pixi v8, `Container.destroy()` anula `_position`, `_scale` y `_pivot`, así que el
siguiente `draw()` lanza en la primera línea útil:

```128:130:src/render/PixiRenderer.ts
    this.world.position.set(width / 2, height / 2)
    this.world.scale.set(cam.pixelsPerMeter, -cam.pixelsPerMeter)
    this.world.pivot.set(cam.x, cam.y)
```

El bucle de `LabRuntime.mount` envuelve el `draw` en `try/catch` con `console.error`, de forma que el
síntoma es un lienzo negro y la consola inundada, no un fallo visible. Se dispara en cualquier segundo
montaje tras un primer montaje completado: HMR, `CanvasHost` remontado, o `StrictMode` si la carga del
WASM llega a terminar antes del ciclo de limpieza. Con la carga de Rapier lenta, el guardia de `session`
lo esconde, que es justo lo que hace al defecto intermitente.

Corrección: crear los contenedores dentro de `init()` (o no destruir hijos y reconstruir sólo el
`Application`), y marcar el renderizador como inutilizable tras `destroy()`.

### A3. Fuga de objetos `Text` en cada frame

```418:427:src/render/PixiRenderer.ts
    this.labels.removeChildren()
    const add = (text: string, world: Vec2, color = '#e8eef7') => {
      const t = new Text({ text, style: new TextStyle({ ...this.labelStyle, fill: color, fontSize: 12 }) })
```

`removeChildren()` desengancha pero no destruye. Con la capa de velocidad activa se crea un `Text` y un
`TextStyle` nuevos por cuerpo y por frame (60/s por cuerpo), cada uno con su textura asociada. La memoria
y las texturas de GPU crecen de forma monótona mientras la pestaña esté abierta.

Corrección: reserva de etiquetas reutilizables indexada por clave, o `removeChildren()` seguido de
`destroy()` de los hijos retirados.

### A4. `appliedForces` nunca se limpia

```141:145:src/sim/engine.ts
  applyImpulse(id: BodyId, jx: number, jy: number, point: Vec2): void {
    this.world?.applyImpulse(id, jx, jy, point)
    this.appliedForces.push({ bodyId: id, x: point.x, y: point.y, fx: jx / PHYSICS_DT, fy: jy / PHYSICS_DT })
    this.world?.writeBodies(this.curr)
  }
```

Nadie vacía ese array (verificado en todo `src/`). Es a la vez una fuga y un error visual: con la capa
`F` activa, `drawOverlay` (línea 265) dibuja **todas las flechas de impulso aplicadas desde el arranque**,
en posiciones del mundo que ya no significan nada.

Corrección: limpiar al inicio de cada `physicsStep` (o mantener una ventana corta con marca de tiempo si
se quiere que la flecha sea visible unos frames).

### A5. Deshacer un arrastre no deshace nada

Con la simulación en pausa, mover un cuerpo escribe directamente en el documento, sin pasar por el
historial:

```332:335:src/app/LabRuntime.ts
      } else {
        this.patchBody(s.bodyId, { x, y })
        this.engine.world?.setTransform(s.bodyId, x, y, s.orig.angle)
      }
```

Al soltar se crea el comando de historial leyendo el documento **ya modificado**:

```378:388:src/app/LabRuntime.ts
    if (s.kind === 'dragging') {
      this.engine.persistentForces = []
      if (!this.engine.clock.playing) {
        const body = this.engine.doc.bodies.find((b) => b.id === s.bodyId)
        if (body) {
          this.history.apply(
            new UpdateBodyCommand(s.bodyId, { x: body.x, y: body.y, vx: 0, vy: 0, omega: 0 }),
          )
        }
      }
    }
```

`UpdateBodyCommand.apply` captura `prev` en el momento de aplicarse, y en ese momento `prev` ya es la
posición final. El `s.orig` que la máquina de estados guarda para esto (`interaction/state.ts:9`) nunca se
usa. Resultado: Ctrl+Z tras arrastrar es un no-op, y la garantía básica del historial se rompe justo en la
operación más frecuente del editor.

Corrección: no mutar el documento durante el arrastre (mover sólo el cuerpo de Rapier y dibujar desde el
snapshot), y al soltar aplicar un comando construido con `s.orig` como estado previo.

### A6. Deshacer reinicia el reloj, borra las gráficas y puede tocar un mundo liberado

```768:773:src/app/LabRuntime.ts
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault()
      if (e.shiftKey) this.history.redo()
      else this.history.undo()
      void this.engine.reload(this.engine.doc)
    }
```

`reload` → `rebuild` destruye y reconstruye el mundo entero, hace `clock.reset()` y `recorder.clear()`.
Deshacer un cambio de color, por tanto, teletransporta `t` a 0, vacía todas las series de las gráficas y
pierde las velocidades vivas de todos los cuerpos, no sólo del afectado.

Además `reload` es asíncrona y aquí se lanza con `void`, sin serializar: dos Ctrl+Z rápidos solapan dos
reconstrucciones y el bucle de render puede llamar a `writeBodies` sobre el `World` que la primera acaba
de liberar. `step()` sí comprueba `this.freed`, pero `writeBodies`, `writeContacts` y `pointHit` no
(ver M13), así que el fallo llega desde WASM.

Corrección: aplicar el resultado del undo de forma incremental sobre el mundo existente, y si hace falta
reconstruir, encolar las reconstrucciones (una promesa en curso, sin solaparse).

### A7. Cuatro traducciones distintas de `SceneBody` → `BodyDesc`, y sólo una está completa

La versión canónica es `bodyToDesc`, que contempla masa explícita, velocidades y bloqueo de traslación:

```8:33:src/scene/builder.ts
export function bodyToDesc(body: SceneBody): BodyDesc {
  const mat = getSolid(body.materialId)
  const collider = {
    shape: body.shape,
    friction: body.friction,
    restitution: body.restitution,
    ...(body.massMode === 'explicit' && body.mass
      ? { mass: body.mass }
      : { density: body.density || mat.density }),
  }
```

`LabRuntime` no la usa nunca. Reimplementa el descriptor a mano en `addBody` (535-553), en
`duplicateSelected` (648-666) y en `commitPatch` (584-606). Las dos primeras copias omiten `linvel`,
`angvel`, `lockTranslation` y el modo de masa. Consecuencias comprobables por lectura:

- duplicar un cuerpo con `massMode: 'explicit'` lo recrea con masa derivada de la densidad;
- duplicar un cuerpo en movimiento lo deja congelado en el mundo aunque el documento diga otra cosa;
- un cuerpo con `locked: true` creado desde el lienzo no queda bloqueado en la física (`lockTranslation`
  no se envía);
- `commitPatch` sí manda el modo de masa, así que el mismo cuerpo cambia de masa al editar cualquier
  propiedad reconstruible: el estado depende del camino por el que se llegó.

Corrección: `bodyToDesc` como única fuente de verdad, invocada desde los cuatro sitios.

### A8. Los identificadores se repiten después de importar una escena

```43:43:src/app/LabRuntime.ts
  ids = new IdFactory(10)
```

`IdFactory` arranca en 10 y `loadDocument` (728-734) no la resiembra. Un archivo exportado contiene
`body:11`, `body:12`, …; al reabrirlo, el primer cuerpo nuevo vuelve a ser `body:11`. A partir de ahí:

- `RapierWorld.addBody` sobrescribe la entrada del mapa y deja el cuerpo anterior vivo en el mundo,
  simulando y colisionando sin representación ni forma de borrarlo (ver M14);
- `RemoveBodyCommand` y `UpdateBodyCommand` actúan por id y afectan al cuerpo equivocado;
- el JSON resultante tiene ids duplicados que el esquema acepta sin protestar.

Corrección: al cargar un documento, resembrar la fábrica con el máximo sufijo numérico encontrado; o
generar ids opacos (contador + aleatorio) y validar unicidad al importar.

---

## Severidad media

### M1. La masa explícita se multiplica en polígonos no convexos

```114:127:src/physics/adapters/rapier/RapierWorld.ts
    for (const col of desc.colliders) {
      const parts = shapeToDescs(this.R, col.shape)
      for (const part of parts) {
        if (col.mass !== undefined && col.mass > 0) part.setMass(col.mass)
        else part.setDensity(col.density ?? 1)
```

`shapeToDescs` descompone un polígono cóncavo en N piezas convexas (`decomposePolygon`) y también expande
las formas compuestas. Con masa explícita, cada pieza recibe la masa total, así que el cuerpo pesa N×m.
Con densidad el reparto es correcto, lo que hace que el error sólo aparezca en el modo "Masa explícita".

Corrección: repartir la masa entre las piezas proporcionalmente al área, o fijar la masa en el cuerpo
rígido en lugar de en cada colisionador.

### M2. Los marcadores de contacto caen en el origen del mundo

```280:300:src/physics/adapters/rapier/RapierWorld.ts
          this.world.contactPair(c, other, (manifold, flipped) => {
            const n = manifold.numContacts()
            for (let i = 0; i < n; i++) {
              const p = manifold.solverContactPoint(i)
```

En la API de Rapier, `numContacts()` y `numSolverContacts()` son cuentas distintas y
`solverContactPoint(i)` está indexado por la segunda (`node_modules/@dimforge/rapier2d-compat/dist/geometry/narrow_phase.d.ts:79-109`).
Cuando el solver conserva menos contactos que el manifold, `solverContactPoint(i)` devuelve `null` y el
código cae al valor por defecto `x: 0, y: 0`, dibujando el punto de contacto y su flecha en el origen.

Corrección: iterar sobre `numSolverContacts()` para la geometría del solver, o usar
`localContactPoint1(i)` transformado al mundo si se quiere recorrer `numContacts()`.

### M3. El refinamiento de la superficie del fluido es código muerto

```91:96:src/fluids/analytic/AnalyticFluid.ts
        let clipped = clipPolygon(poly, region.polygon)
        clipped = clipHalfPlane(clipped, 0, 1, region.restSurfaceY)
        const area = polygonArea(clipped)
        if (area < 1e-8) continue
        displaced += area
        contributions.push({ body, snap, poly: clipped, area, c: polygonCentroid(clipped) })
```

```108:113:src/fluids/analytic/AnalyticFluid.ts
      for (const item of contributions) {
        // Reclip with the raised surface for a slightly better hydrostatic estimate.
        let clipped = clipPolygon(item.poly, region.polygon)
        clipped = clipHalfPlane(clipped, 0, 1, surfaceY)
```

En `contributions` se guarda el polígono **ya recortado** a `restSurfaceY`, y `surfaceY` siempre es mayor
o igual que `restSurfaceY`. Volver a recortar con un semiplano más alto no puede añadir área, así que el
segundo paso devuelve exactamente lo mismo: el ascenso de nivel por volumen desplazado no influye en el
empuje. El comentario describe una intención que el código no cumple.

Corrección: guardar el polígono del cuerpo sin recortar y recortarlo con `surfaceY` en el segundo paso.

### M4. La selección por marquesina no selecciona nada

`onDown` entra en el estado `selecting` y el renderizador dibuja el rectángulo (`PixiRenderer:393-399`),
pero `onUp` (355-393) trata `creating`, `applyingForce`, `dragging` y `joining` — no hay ninguna rama para
`selecting`, así que al soltar el estado vuelve a `idle` y la selección se descarta. La función parece
existir porque se ve el recuadro.

Corrección: al soltar, recolectar los cuerpos cuyo AABB intersecte el rectángulo y asignarlos a
`this.selected`.

### M5. Las capas de visualización del documento se ignoran

```91:97:src/app/LabRuntime.ts
        this.renderer.draw(
          this.engine,
          this.camera,
          this.store?.getState().viz ?? this.engine.doc.visualization,
```

Con un store adjunto (siempre, en la app real) el render usa exclusivamente `store.viz`, y ni
`loadDocument` ni `importJson` sincronizan el store con `doc.visualization`. Por tanto los experimentos
que activan capas (`scenes.ts:87`, `102`, `116-117`, `202`) no tienen ningún efecto, y abrir un archivo
guardado pierde su configuración de visualización aunque el JSON la contenga y el esquema la valide.

Corrección: al cargar un documento, empujar `doc.visualization` al store; al exportar, leerlo de ahí
(esto último ya se hace en `exportJson`).

### M6. El eje temporal del registrador se adelanta y se aplana

```38:42:src/sim/clock.ts
    while (this.accumulator >= this.dt && steps < MAX_STEPS_PER_FRAME) {
      this.accumulator -= this.dt
      this.simTime += this.dt
      steps += 1
    }
```

`advance` suma todo el tiempo del frame **antes** de que se ejecute un solo paso, y luego
`SimulationEngine.advance` llama n veces a `physicsStep`, que muestrea con el `simTime` ya final:

```103:103:src/sim/engine.ts
    this.recorder.sample(this.clock.simTime, PHYSICS_DT, this.doc.world.gravity.y, this.curr)
```

Con un paso por frame el efecto es un desfase de un `dt`; en cuanto el navegador acumula retraso y se
ejecutan 2-5 pasos, todas las muestras de ese frame comparten marca de tiempo y la gráfica muestra
mesetas verticales. Es un laboratorio de física: el eje de tiempo es un resultado, no decoración.

Corrección: que `advance` devuelva el número de pasos y que `physicsStep` avance `simTime` justo antes de
muestrear, o pasar el instante correspondiente a cada subpaso.

### M7. Cambiar a "Masa explícita" no hace nada hasta escribir un número

`Inspector` permite seleccionar el modo sin fijar valor (`Inspector.tsx:84`), y `body.mass` queda
`undefined`. Tanto `bodyToDesc` (`builder.ts:14`) como `commitPatch` (`LabRuntime.ts:599`) condicionan con
`body.massMode === 'explicit' && body.mass`, de modo que se cae silenciosamente al camino de densidad
mientras la interfaz afirma que la masa es explícita. El texto "masa actual … (derivada)" desaparece, con
lo que ni ese indicio queda.

Corrección: al cambiar a explícita, sembrar `mass` con la masa actual del snapshot; y validar en el
esquema que `massMode: 'explicit'` implica `mass` presente.

### M8. La interfaz permite valores que el propio esquema rechaza

El inspector no acota nada, mientras el esquema exige rangos:

```46:52:src/scene/schema.ts
      mass: z.number().positive().optional(),
      friction: z.number().nonnegative(),
      restitution: z.number().min(0).max(2),
      materialId: z.string(),
      gravityScale: z.number(),
      linearDamping: z.number().nonnegative(),
```

Restitución 5, fricción −1, masa 0 o densidad negativa se aceptan en la UI, se guardan y el archivo ya no
se puede abrir. Es el mismo fallo de A1 por otra vía: **el editor puede producir escenas que el cargador
rechaza**.

Corrección: un descriptor por propiedad (mínimo, máximo, paso) compartido entre el inspector y el
esquema, de forma que no puedan divergir.

### M9. Abrir un archivo inválido falla en silencio

```103:108:src/ui/TimeBar.tsx
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (!file) return
              file.text().then((t) => lab.importJson(t))
              e.target.value = ''
            }}
```

Sin `catch`. `parseDocument` lanza mensajes ya redactados en español ("No hay migración desde
schemaVersion 0", los errores de zod) que nadie ve: la promesa se rechaza sin gestionar y la escena
anterior sigue en pantalla como si no hubiera pasado nada.

Corrección: capturar y mostrar el error en la interfaz.

### M10. El zoom por pinza se salta los límites de la cámara

```213:220:src/app/LabRuntime.ts
      if (this.pointers.size === 2 && this.pinch) {
        const pts = [...this.pointers.values()]
        const d = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y)
        this.camera = {
          ...this.camera,
          pixelsPerMeter: this.pinch.ppm * (d / (this.pinch.dist || 1)),
        }
```

`clampPpm` existe (`camera/coords.ts:20`) y `zoomAt` lo aplica, pero este camino escribe
`pixelsPerMeter` sin pasar por él. Un pellizco puede dejar la escala casi en cero (todo el mundo en un
píxel, la rejilla iterando sobre un rango enorme) o en valores desmesurados. Además el pellizco no fija
el punto medio, así que el zoom táctil se centra siempre en la cámara y no entre los dedos.

Corrección: aplicar `clampPpm` y reutilizar `zoomAt` con el punto medio de los dos punteros.

### M11. Una entrada de historial por pulsación de tecla, con reconstrucción del cuerpo

Todos los campos del inspector llaman a `commitPatch` en cada `onChange`. `commitPatch` aplica un comando
al historial y, si la propiedad está en `rebuildKeys` (densidad, masa, forma, material, fricción,
restitución, amortiguaciones, CCD, bloqueos), destruye y recrea el cuerpo en Rapier:

```582:607:src/app/LabRuntime.ts
    if (rebuildKeys.some((k) => k in patch)) {
      this.engine.world.removeBody(id)
      this.engine.world.addBody({
```

Escribir "1250" en densidad son cuatro comandos de historial, cuatro `structuredClone` del documento
completo (`History.apply` → `cloneDocument`) y cuatro destroy/create en el motor, con pérdida del estado
interno del solver y de los contactos en cada uno. Deshacer requiere cuatro Ctrl+Z para volver al valor
inicial.

Corrección: coalescer los comandos por campo mientras el foco no cambie, y separar "cambio de propiedad
del material" (que puede aplicarse en caliente) de "cambio de forma" (que sí exige reconstrucción).

### M12. El paneo con espacio está documentado pero no existe

`onDown` lo consulta:

```233:236:src/app/LabRuntime.ts
    const space = this.store?.getState().spaceHeld
    if (e.button === 1 || e.button === 2 || tool === 'pan' || space) {
```

Pero `spaceHeld` sólo se inicializa a `false` en el store (`store.ts:67`) y nadie lo pone a `true` en
ningún sitio; no hay ningún manejador de `keyup`. Además la barra espaciadora ya está asignada a
play/pausa en el mismo `onKey`, así que la combinación tendría que resolverse antes de implementarlo.

### M13. `RapierWorld` sólo protege un método del uso después de liberar

`destroy()` hace `this.world.free()` y marca `freed = true`, pero sólo `step()` comprueba la bandera
(`RapierWorld.ts:239-240`). `writeBodies`, `writeContacts`, `pointHit`, `projectPoint`, `addBody`,
`getBody`, `setTransform` y el resto operan sobre un `World` liberado y fallan dentro de WASM, que es
donde peor se diagnostica. Combinado con A6 (`reload` sin serializar) y con `dispose()` compitiendo con
el bucle de animación, es un fallo alcanzable en uso normal.

Corrección: guardia `freed` en todos los métodos públicos (o un objeto nulo tras liberar).

### M14. `addBody` con un id existente deja un cuerpo huérfano

```129:132:src/physics/adapters/rapier/RapierWorld.ts
    this.bodies.set(desc.id, body)
    this.colliders.set(desc.id, created)
    this.colliderDescs.set(desc.id, desc.colliders)
```

No se comprueba si el id ya estaba. El cuerpo anterior sale del mapa pero **no del mundo**: sigue
integrándose y colisionando, invisible para el render (que dibuja desde el documento) y para
`removeBody`. Es el amplificador de A8 y de cualquier importación con ids repetidos.

Corrección: si el id existe, eliminar primero (o rechazar el descriptor con un error explícito).

### M15. Fuga de pistas en el registrador de datos

```14:16:src/ui/GraphPanel.tsx
  useEffect(() => {
    if (selectedId) lab.engine.recorder.observe(selectedId)
  }, [selectedId, lab])
```

`DataRecorder.unobserve` existe y no se llama nunca. Cada cuerpo observado reserva 13 `RingBuffer` de
3 600 flotantes (~190 KB) que no se liberan, ni al deseleccionar ni al cargar otra escena: las pistas de
cuerpos que ya no existen sobreviven porque `clear()` vacía los búferes pero conserva el mapa.

Corrección: limitar el número de pistas vivas y dejar de observar al deseleccionar o al cargar un
documento nuevo.

---

## Severidad baja

**B1. Interpolación cuadrática en el número de cuerpos.** `interpolated()` (`engine.ts:120-135`) hace dos
búsquedas lineales por llamada, y el renderizador la invoca 3-4 veces por cuerpo y frame
(`PixiRenderer:191`, `234`, `258`, `458`). Con N cuerpos son ~4N recorridos de arrays de longitud N por
frame. Un índice `Map<BodyId, BodySnapshot>` reconstruido una vez por paso lo elimina.

**B2. Deshacer un borrado reordena la escena.** `RemoveBodyCommand.invert` (`commands.ts:39`) reinserta con
`push`, no en su índice original: cambia el orden de dibujo y el JSON exportado. La prueba de
`tests/serialization.test.ts:106` no lo detecta porque siempre borra el último elemento.

**B3. Contornos y resaltado de selección aplicados al subtrazo equivocado.** En `drawShape`
(`PixiRenderer.ts:53`) el `stroke` final se aplica al último camino abierto — en el círculo, al radio
dibujado en la línea 39, no a la circunferencia. Lo mismo con el resaltado de selección (línea 194). Los
`kind: 'polyline'` y `kind: 'compound'` no tienen rama de dibujo: son invisibles aunque el esquema los
acepte.

**B4. Formas y capas declaradas sin implementación.** `capsule`, `polyline` y `segment` existen en el
esquema y en el adaptador pero no hay herramienta que los cree; `viz.trajectories` y `viz.fluidParticles`
no se dibujan (y `scenes.ts:116` activa trajectories); `viz.colliders` dibuja un circulito de 3 cm en el
centro, no los colisionadores; `particleCount` se envía siempre a 0 (`LabRuntime.ts:823`);
`inspectorOpen`, `graphsOpen` y `debugHud` no tienen ningún control en la interfaz, así que los paneles no
se pueden cerrar.

**B5. Las regiones de fluido no se pueden borrar ni editar.** `RemoveFluidCommand` está implementado y no
se usa en ningún sitio; no hay inspector de región (material, nivel, polígono). Crear un charco es
definitivo salvo que se borre toda la escena.

**B6. Limitaciones físicas del fluido no declaradas.** El empuje usa la dirección real de la gravedad,
pero la superficie se recorta siempre con un semiplano horizontal (`AnalyticFluid.ts:92`), así que con
gravedad no vertical el modelo es incoherente; la cápsula se aproxima por un círculo de radio
`max(halfHeight, radius)` (línea 44), que sobrestima el volumen desplazado. Conviene documentarlo o
corregirlo, porque el README vende la flotación como "Arquímedes real, no partículas decorativas".

**B7. Código muerto y silenciadores de linter.** `void panCamera`, `void cloneDocument`,
`void GRAVITY_PRESETS`, `void IdFactory` (`LabRuntime.ts:838-841`), `void key` (`decompose.ts:91`),
`void mat` (`LabRuntime.ts:494`), `void xs` y `void polygonCentroid` (`PixiRenderer.ts:176-177`),
`void IdFactory` (`scenes.ts:208`) — nueve en total, y el último es doblemente inútil porque `IdFactory`
sí se usa tres líneas más arriba. Y API pública sin ningún consumidor: `hasBody`, `setCcd`,
`clearForces`, `projectPoint`, `getColliders`, `forEachBody`, `experimentById`, `asBodyId`,
`resetCamera`, `RingBuffer.last`, `ShapeKind`, `Pointer`, `InteractionEvent`, y los estados
`hovering`, `rotating` y `pinching` de `InteractionState`. `noUnusedLocals` está activo, y estos `void`
son precisamente la forma de esquivarlo: cada uno oculta una decisión pendiente.

**B8. `fsm.test.ts` no prueba la máquina de estados de la aplicación.** El archivo define su propio
`reduce` (`interaction/fsm.test.ts:5-44`) y lo prueba contra sí mismo; la lógica real vive repartida en
`onDown`/`onMove`/`onUp` de `LabRuntime` y no está cubierta. Es cobertura aparente sobre código que no se
ejecuta en producción: explica que M4 (marquesina) pasara desapercibido.

**B9. Migraciones sin guardia de versión futura.** `migrateDocument` (`schema.ts:107-124`) sólo migra hacia
arriba; un `schemaVersion: 99` entra directo al validador de la v1 y, si por casualidad valida, se carga
como si fuera actual. Y como `MIGRATIONS[0]` no existe, cualquier JSON sin `schemaVersion` muere con "No
hay migración desde schemaVersion 0" en lugar de un mensaje útil.

**B10. Validación de escena incompleta.** El esquema no comprueba unicidad de ids, ni que `joints[].bodyA`
y `bodyB` existan, ni que `materialId` esté en el catálogo, ni la coherencia `massMode`↔`mass`. Las
uniones huérfanas degradan bien (`addJoint` sale si falta un cuerpo), pero se pierden en silencio al
guardar y volver a cargar.

**B11. Detalles de gestión de recursos y estilo.** `URL.createObjectURL` sin `revokeObjectURL`
(`TimeBar.tsx:87-93`); `world.profilerEnabled = true` siempre activo sin que nadie lea el perfil
(`RapierWorld.ts:85`); `<style>` reinyectado en cada render del inspector (`Inspector.tsx:177-179`);
`manifold.normal()` asigna un vector nuevo por contacto en el bucle de `writeContacts`.

**B12. La gráfica está deformada y borrosa.** El lienzo es fijo de 900×140 (`GraphPanel.tsx:82`) y CSS lo
estira a la anchura real, sin `devicePixelRatio`; `ctx.font` se define en la línea 61, después de los
`fillText` de los mensajes de estado (líneas 30 y 36), que salen con la fuente por defecto.

**B13. Energía potencial con datum implícito.** `potential = m·|gy|·y` (`recorder.ts:94`) ignora `gx` y fija
el cero en `y = 0`. Para un laboratorio conviene o declararlo en la etiqueta del canal o calcularlo con el
vector de gravedad completo y un datum configurable.

**B14. Selección múltiple a medias.** Shift+clic acumula en `this.selected` y borrar/duplicar operan sobre
todo el conjunto, pero el inspector sólo muestra `selected[0]` (`LabRuntime.ts:807`) y no hay indicación
de cuántos elementos hay seleccionados. `deleteSelected` genera además un comando de historial por cuerpo,
así que borrar cinco cuerpos exige cinco Ctrl+Z.

**B15. Picking ambiguo.** `pointHit` (`RapierWorld.ts:308-331`) devuelve el primer colisionador que
`intersectionsWithPoint` visite, sin criterio de profundidad ni exclusión de sensores: con cuerpos
solapados, qué se selecciona depende del orden interno del BVH. Y devuelve la traslación del colisionador
como punto de impacto, no el punto consultado.

**B16. El doble clic del polígono añade vértices extra.** `dblclick` llega después de dos `pointerdown`
(`LabRuntime.ts:296-303`), que ya insertaron dos vértices casi coincidentes antes de cerrar la figura
(`onDblClick`, 395-401). `removeDuplicateVertices` los limpia si caen dentro de 1e-8, lo que no es el caso
a escalas de pantalla.

**B17. Rotar y escalar sólo desde el inspector.** No hay asas en el lienzo; el estado `rotating` está
declarado y sin usar. Para un editor "tipo juguete" es la carencia de interacción más visible.

---

## Notas de verificación

- `npx tsc -b --force` → sin diagnósticos.
- `npx oxlint src tests` con la configuración del repositorio → sin diagnósticos. Ampliando a
  `correctness`, `suspicious` y `perf` sólo aparecen falsos positivos de `react-in-jsx-scope`
  (regla inaplicable con el transform JSX automático de React 19).
- No se ejecutó `npm test` ni se levantó la aplicación, por decisión del alcance de esta revisión.
  Los defectos A1, A5, A6, M2, M4, M5, M6 y M7 son observables sin depurador en cuanto se prueben a mano;
  A2, A3 y A4 requieren observar consumo de memoria o remontar el lienzo.
