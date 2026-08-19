# Laboratorio de Física 2D

Sandbox de física 2D en el navegador: cuerpos rígidos, líquidos hidrostáticos, vectores, gráficas y experimentos.

No es una demo. Es un laboratorio para crear escenas, cambiar propiedades y ver qué ocurre.

## Qué hay en el MVP

- Motor rígido **Rapier 2D** (WASM) detrás de una abstracción propia
- Editor tipo juguete: círculo, rectángulo, polígono, plataforma, líquido
- Cámara con pan, zoom al cursor y gestos táctiles
- Play / Pause / Step / Reset con **paso fijo** de 1/60 s
- Inspector con densidad o masa explícita (nunca las dos como fuente de verdad)
- Uniones entre cuerpos: soldar, bisagra, resorte y cuerda
- Herramienta de fuerza (impulso o fuerza sostenida con Mayús)
- Vectores de velocidad, gravedad, contactos (impulsos reales del solver)
- Gráficas de posición, velocidad y energía
- Guardar / cargar JSON versionado
- Experimentos: caída libre, tiro parabólico, colisiones, plano inclinado, péndulo, flotación
- Flotación por **regiones analíticas** (Arquímedes + arrastre), no partículas decorativas

## Cómo ejecutarlo

```bash
npm install
npm run dev
```

```bash
npm test
npm run typecheck
npm run build
```

## Controles

| Acción | Cómo |
| --- | --- |
| Reproducir / pausar | Espacio o barra superior |
| Paso a paso | `.` |
| Herramientas | V seleccionar, H mano, C círculo, R rectángulo, G polígono, L plataforma, W líquido, F fuerza, M medir, J unir |
| Unir | arrastra de un cuerpo a otro; el tipo (soldar, bisagra, resorte, cuerda) se elige en la barra |
| Zoom | rueda o pellizco |
| Pan | botón medio, derecho, o herramienta Mano |
| Polígono | clics para vértices, Enter o doble clic para cerrar |
| Fuerza sostenida | herramienta Fuerza + Mayús |

Las unidades del mundo son **metros**. El eje Y apunta hacia arriba.

## Arquitectura

La UI (React) no calcula física. El bucle vive en `LabRuntime`:

`SceneDocument` (autoría) → `SimulationEngine` → Rapier + fluido analítico → snapshot → PixiJS.

Reglas de dependencia comprobadas en `tests/architecture.test.ts`.

## Licencia

MIT
