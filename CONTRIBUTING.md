# Contribuir

Se aceptan PRs. Esto es lo que ayuda a que se revisen rápido.

## Correrlo

```bash
npm install
npm run dev       # el server, en :4000
npm run dev:web   # la Sala con HMR, en :5173
```

No necesitas API key para trabajar en el motor: los demos usan un agente simulado (`MULTI_TEST_MOCK=1`). Sí la necesitas para probar el comportamiento del agente real.

## Antes de mandar el PR

```bash
npm run typecheck
```

Y corre el demo de lo que tocaste. Si toca concurrencia, `demo:concurrency`; si toca el aislamiento, `demo:aislamiento`. La lista está en el README.

## Dónde vive cada cosa

| | |
|---|---|
| `server/src/agent/loop.ts` | el loop del agente |
| `server/src/agent/tools/` | las 6 tools |
| `server/src/agent/providers/` | clientes HTTP de los modelos |
| `server/src/engine/file-mutation.ts` | CAS: escribir solo si nadie tocó el archivo |
| `server/src/engine/keyed-mutex.ts` | fila por clave (rutas, repos, contenedores) |
| `server/src/engine/coordinator.ts` | un turno activo por agente → paralelo real |
| `server/src/engine/container.ts` `runner.ts` | aislamiento por sala |
| `server/src/engine/preview.ts` | levantar el dev server del proyecto |
| `server/src/engine/proxy.ts` `inspector.ts` | proxy que inyecta el click-to-select |
| `server/src/engine/git.ts` `history.ts` | commits, diffs, revert, bookmarks |
| `server/src/storage/` | SQLite tras una interfaz |
| `web/src/App.tsx` | la Sala |

El recorrido completo del sistema está en [E2E.md](E2E.md).

## Cosas que conviene saber

**Todo recurso compartido necesita su lock.** El producto es concurrente por diseño — varios agentes, varias personas, un solo proyecto. Los archivos, el índice de git, los contenedores y los puertos ya pasan por `KeyedMutex`. Si agregas otro recurso compartido, dale su lock desde el principio: los bugs de concurrencia aparecen en producción, no en tu máquina.

**El motor no sabe de frameworks.** La sala nace vacía y el agente scaffoldea lo que le pidan. Si necesitas que algo funcione con un stack, resuélvelo leyendo lo que el proyecto declara o poniéndole la restricción al agente por el prompt — no cableando `vite` en el motor.

**Los errores de concurrencia van al modelo.** Si un agente intenta escribir un archivo que cambió, el mensaje es para él ("léelo otra vez"), no un modal para el humano. Esa asimetría es a propósito.

**Sin emojis en el código ni en la salida.** Ni en logs, ni en mensajes de la UI.

**Los comentarios explican el porqué, no el qué.** Si un comentario describe lo que el código ya dice, sobra. Si explica una decisión, un bug que se atajó o una restricción del entorno, vale oro.

## Reportar algo

Si es un bug, di qué esperabas y qué pasó. Si tienes el log del server, mucho mejor — buena parte de los problemas de este proyecto han salido de ahí y no de leer el código.
