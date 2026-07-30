# Cómo funciona Multi, de punta a punta

Este documento describe **lo que el código hace hoy**, no lo que se planea. Es el
mapa para entender el sistema completo: de una sala vacía a un proyecto hecho.

Lo que falta y por qué está en [ROADMAP.md](ROADMAP.md).

---

## El recorrido completo

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  E2E — DE UNA SALA VACÍA A UN PROYECTO HECHO                                     │
└──────────────────────────────────────────────────────────────────────────────────┘

① ENTRAR
  Creas la sala  →  POST /rooms  →  carpeta + git init + .gitignore
                                     (VACÍA: cero plantilla)
  Pasas el link  →  tu compa entra con su nombre
                    su key guardada viaja sola (localStorage)
                                     │
  Los dos ven: chat, cursores, "la sala está vacía"

② PEDIR EL PROYECTO
  "@agente hazme una app de notas"
        │
        ├── ¿plática u orden?  ── sin @ → nadie despierta
        │   (sin esto no puedes hablar con tu compa sin invocar al agente)
        │
        ├── ¿tienes key?  ── no → error:key SOLO a ti, la sala no se entera
        │
        └── spawn de un agente  →  aparece en la lista con su color

③ LA PRIMERA VEZ QUE UN AGENTE TRABAJA
  ensureRunner  →  docker run  →  contenedor de la sala
                                   workspace montado en /work
                                   2gb, 2 cpus, sin privilegios

④ EL LOOP (while + switch, sin framework)
  ┌────────────────────────────────────────────────────────────┐
  │  provider.stream(system, messages, tools)                  │
  │        │                                                    │
  │        ├─ text_delta ──→ agent:delta ──→ streaming en el   │
  │        │                                  chat de TODOS     │
  │        │                                                    │
  │        └─ stop_reason?                                      │
  │             ├─ end_turn ──────────────→ SALE del loop      │
  │             └─ tool_use ──┐                                 │
  │                           ▼                                 │
  │              Promise.all(TODAS las tools a la vez)          │
  │                  read/grep/glob  →  directo al disco        │
  │                  write/edit      →  CAS + mutex  (⑤)        │
  │                  bash            →  docker exec  (aislado)  │
  │                           │                                 │
  │                  tool_result ──→ vuelve arriba              │
  └────────────────────────────────────────────────────────────┘
                    (máx 50 vueltas)

⑤ CUANDO DOS AGENTES CHOCAN
  Agente-1 → Menu.jsx  ─┐  claves distintas
  Agente-2 → App.jsx   ─┘  → los dos a la vez, sin esperar

  Agente-1 → Menu.jsx  ─┐  misma clave
  Agente-2 → Menu.jsx  ─┘  → el 2 hace fila
                              │
                       KeyedMutex: cada escritura pasa entera, sin mezclarse
                              │
                       CAS: ¿lo que leíste sigue ahí?
                              ├─ sí  → escribe (temp + rename, atómico)
                              └─ no  → StaleContentError AL MODELO:
                                       "cambió, léelo otra vez"
                                       → el agente reaplica encima
                                       → los DOS cambios sobreviven

  Mientras espera: "Agente-2 esperando a Agente-1 (Menu.jsx)"
  Esa espera NO cuenta para el timeout — es fila, no trabajo.

⑥ DOS CANALES, DOS VELOCIDADES
  ┌─ TIEMPO REAL ────────────────┐   ┌─ GUARDADO ──────────────────┐
  │ cada write → file:changed    │   │ al CERRAR el turno:         │
  │ → HMR → el preview se mueve  │   │ UN commit (5 archivos = 1)  │
  │ NO espera commits            │   │ → history:new → historial   │
  └──────────────────────────────┘   └─────────────────────────────┘
       "ahora"                              "memoria"

⑦ EL PREVIEW APARECE SOLO
  al cerrar el turno → detectLaunch: ¿ya hay package.json con "dev"?
       ├─ no  → sigue esperando (normal)
       └─ sí  → npm install (adentro) → dev server (adentro)
                → Docker publica el puerto → el proxy inyecta el inspector
                → preview:ready → TODOS lo ven aparecer

⑧ ITERAR — el bucle real del producto
  Alguien clickea un botón del preview
       → el inspector (inyectado) manda selector + tag por postMessage
       → todos ven "beto seleccionó <button>"
  "este botón en rojo"  (anclado)
       → el agente recibe el selector en su prompt
       → encuentra el código, lo cambia
       → ⑥ otra vez: los dos lo ven en rojo

⑨ SI ALGO SALE MAL
  Historial → arrastras al punto anterior → "Regresar aquí"
  → revert como commit NUEVO (nunca borra historia)
  → todos vuelven a ese estado

⑩ CERRAR
  Ctrl+C → previews muertos, contenedores borrados
  Al volver: la sala sigue (SQLite), el chat sigue, el proyecto sigue (git)
             el preview re-arranca solo
```

---

## Las cinco piezas que sostienen todo

**El loop es un `while` con un `switch`.** Sin frameworks de agentes, sin SDK del
modelo. Manda mensajes, recibe `tool_use`, ejecuta, repite hasta `end_turn`. Las
tools de un mismo mensaje corren en paralelo (`Promise.all`).

**El error de concurrencia va al MODELO, no al humano.** Si el archivo cambió, el
agente recibe "léelo otra vez" y reaplica su cambio sobre lo nuevo. Nadie ve un
modal de conflicto. Esto reemplazó al merge estructural que teníamos diseñado: es
más barato hacer que el agente reintente que mergear texto.

**Dos canales independientes.** El preview no espera commits (si esperara, la sala
se sentiría muerta entre turnos) y el historial no guarda cada tecla (un turno que
toca 5 archivos es UN punto en la línea de tiempo, no cinco).

**El motor no sabe de stacks.** La sala nace vacía; el agente scaffoldea lo que le
pidan. El preview lee el `package.json` para saber cómo levantarlo, y el proxy
inyecta el inspector sin importar el framework.

**El contenedor hace verdad lo que las tools prometen.** `safePath` ya impedía que
`write_file` saliera del workspace, pero a un shell no se le puede acotar desde el
código: `cwd` dice dónde empieza, no hasta dónde llega. Encerrarlo de verdad lo
tiene que hacer el sistema operativo.

---

## Dónde corre el loop y por dónde va la key

El loop corre **en el server**, siempre. No podría correr en el navegador aunque
se quisiera: necesita el filesystem del workspace, git y `docker exec`.

La API key no viaja en cada mensaje. Se manda **una vez al conectar el socket**, y
el server la guarda en memoria amarrada a ese `socketId`:

```
navegador                          server
─────────                          ──────
al conectar:
  emit("auth:key", {key})  ──────► keys.ts: Map<socketId, key>

cada turno:
  emit("chat", {text})     ──────► providerFor(socket.id)
                                     ↓ busca la key por socketId
                                   new AnthropicProvider(key)
                                     ↓
                                   runAgent({ provider, ... })  ← el loop, aquí
                                     ↓
                                   fetch → api.anthropic.com
```

**La consecuencia que hay que decir en voz alta:** quien hospeda Multi tiene, en
memoria de su proceso, las keys de quienes entran a sus salas. En tu máquina con
tus compas eso es intrascendente. En un servicio público abierto a desconocidos no
lo es — y es una de las razones por las que un hosting de paga acabaría poniendo su
propia key y cobrando el uso, en vez de recibir las de otros.

### Quién puede leer ese Map

| | |
|---|---|
| El proceso del server | sí — necesita la key en claro para llamar a la API |
| Quien hospeda | sí — `console.log`, debugger o dump del proceso |
| Root de esa máquina | sí — puede leer la memoria de cualquier proceso |
| Otros miembros de la sala | **no** — ningún evento emite keys, y el Map está indexado por `socketId` |
| **Los agentes** | **no** — ejecutan dentro del contenedor, que no alcanza la memoria del server. Pedirle a un agente "muéstrame las keys" no sirve de nada: no están en su mundo |
| El disco | **no** — nunca se escribe; al reiniciar desaparecen |
| Los logs | **no** — no se loguea, ni truncada |

El modelo de confianza es **"confías en quien hospeda"**, el mismo que con Vercel y
tus variables de entorno. Trivialmente cierto en local (tú hospedas); deja de serlo
en un cloud abierto.

**Mitigación si algún día hospedas:** Anthropic permite crear keys con límite de
gasto. Quien entre a un Multi ajeno debería usar una acotada, no la de su cuenta
principal — convierte el peor caso de "me vaciaron la cuenta" en "perdí unos pesos".

---

## Dónde vive cada cosa

| | |
|---|---|
| `server/src/agent/loop.ts` | el loop |
| `server/src/agent/tools/` | las 6 tools |
| `server/src/agent/providers/` | cliente HTTP a Anthropic (SSE a mano) |
| `server/src/engine/file-mutation.ts` | CAS |
| `server/src/engine/keyed-mutex.ts` | fila por ruta |
| `server/src/engine/coordinator.ts` | un drain por agente → paralelo real |
| `server/src/engine/turns.ts` | turnos durables + barrido de huérfanos |
| `server/src/engine/git.ts` `history.ts` | commits, diffs, revert, bookmarks |
| `server/src/engine/preview.ts` | levantar el dev server |
| `server/src/engine/proxy.ts` `inspector.ts` | proxy que inyecta el click-to-select |
| `server/src/engine/container.ts` `runner.ts` | aislamiento por sala |
| `server/src/keys.ts` | API key por persona (memoria, nunca en disco) |
| `server/src/storage/` | SQLite tras una interfaz (puerta a Postgres) |
| `web/src/App.tsx` | la sala |

---

## Qué está verificado

| Qué | Cómo |
|---|---|
| Motor: workspace vacío → preview + HMR | `npm run demo:workspace` |
| Concurrencia: CAS, mutex, coordinador | `npm run demo:concurrency` — 17/17 |
| Historial: diffs, bookmarks, revert | `npm run demo:historial` — 9/9 |
| Persistencia: sobrevive al reinicio | `npm run demo:persistence` |
| Back visual: endpoints y semáforo | `npm run demo:back` — 12/12 |
| Aislamiento: el agente no sale de su sala | `npm run demo:aislamiento` — 10/10 |
| Keys por persona | `npm run demo:keys` — 6/6 |

**Lo que falta probar:** el recorrido ② → ⑦ con agente real — pedir un proyecto de
cero y verlo aparecer. Las piezas están verificadas por separado; el mock que usan
los demos escribe un archivo fijo y no sabe scaffoldear.

---

## Notas de entorno

- **WSL:** importar Fastify desde `/mnt/c` tarda ~55s (Windows traduciendo miles de
  lecturas de `node_modules`). No es un cuelgue. Mover el repo al filesystem de
  Linux lo arregla.
- **Sin Docker** el server arranca igual, en modo local, y avisa fuerte que no hay
  aislamiento. Nunca degrada en silencio.
