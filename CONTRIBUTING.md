# Contribuir

Laboratorio de física 2D en el navegador. Antes de un cambio grande, lee `AGENTS.md` y `docs/plan-de-mejora.md`.

## Entorno

```bash
npm install
npm run dev
```

```bash
npm test
npm run typecheck
npm run lint
```

## Invariantes

1. El documento de escena solo se muta con comandos de `History`.
2. `bodyToDesc` (`src/scene/builder.ts`) es la única traducción a física.
3. No silencies `noUnusedLocals` con `void identificador`. Úsalo o bórralo.

React no calcula física. Rapier no se importa desde `ui/` ni `render/`.

## Estilo

Prettier (sin `;`, comillas simples). Textos de interfaz en español; nombres en código en inglés.

## Git

El proyecto está conectado a Lovable. No hagas force-push ni reescribas commits ya publicados en la rama conectada.
