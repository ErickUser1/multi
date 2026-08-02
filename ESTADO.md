# Dónde va Multi

Nota de traspaso: qué está hecho, qué falta y qué se decidió por el camino.
Última actualización: 1 de agosto de 2026.

---

## El producto funciona de punta a punta

Verificado con agente real, no solo con demos:

```
sala vacía → pides un proyecto → el agente lo monta en la raíz
          → el preview arranca solo → pides un cambio
          → se ve en vivo SIN refrescar
```

Y con dos agentes a la vez: se reparten el trabajo, no se pisan, y verifican antes de cerrar.

Probado también: click-to-select, historial con diffs y revert, interrumpir y redirigir con una sola mención, keys por persona, aislamiento por contenedor.

---

## Repo

`github.com/ErickUser1/multi` — **privado todavía**. `main` protegido, se entra por PR.

Dos PRs mergeados (#4 interrumpir, #5 preview en vivo). Rama `fix/agentes-se-ven` con 7 commits **sin subir**.

El plan de publicar: abrirlo cuando esté probado con más gente. Se mencionó Reddit, X y un grupo de la uni de ~1000 personas.

---

## Lo que falta

**Antes de publicar:**

- **El CI no corre.** Los dos PRs dicen "0 of 2 checks passed". El workflow existe y está bien escrito (`.github/workflows/ci.yml`); lo más probable es que GitHub Actions esté deshabilitado en Settings del repo.
- **Un GIF de la demo.** Un turno grabado —pides algo, el preview se mueve— vale más que el README en Reddit. Cuesta un turno de agente.
- **Abrir el repo.**
- **Sacar la key del `.env`** si va a estar expuesto: hoy sirve de respaldo y un desconocido gastaría tu saldo.

**Bugs y mejoras conocidas** — todo el detalle en `ROADMAP.md`, con lo que se descartó y por qué:

- El back visual solo muestra endpoints; falta lo que la app *guarda* (tablas)
- Migrar a Bun: el arranque tarda ~5 min en WSL sobre `/mnt/c`, medido 9× más rápido en Bun
- Cursor del agente sobre el preview (necesita mapear archivo → elemento visual)
- Auto-verificación con mutex, si al usarlo se ven builds solapándose
- `max_tokens` adaptativo: OpenRouter valida contra el máximo posible, no contra el uso real

---

## Lo que se decidió y no hay que re-discutir

**Sin task list compartida.** Claude Code coordina agent teams con una, pero su lead es un agente que no ve nada. Aquí los coordinadores son personas mirando la misma pantalla — el tablero es el preview. Razonamiento completo en `ROADMAP.md`.

**Sin mailbox entre agentes.** El 90% de lo que resolvería ya lo resuelve leer el código; el otro 10% (el *porqué* de una decisión) ahora viaja en el resumen.

**Sin worktrees.** Un solo working tree con CAS por archivo. Aislar rompería el preview compartido, que es la premisa.

**Sin botón de interrumpir.** Mencionar al agente ya lo detiene y redirige con un solo gesto.

**El motor no sabe de stacks.** La sala nace vacía, el agente scaffoldea. Todo lo específico de framework va por el prompt o se lee del proyecto, nunca cableado.

**Todo recurso compartido lleva su lock.** `KeyedMutex` ya protege archivos, el índice de git y el arranque de contenedores. Si aparece otro recurso compartido, dale su lock desde el principio.

---

## Rama `fix/agentes-se-ven` (sin subir)

Siete commits, todos verificados:

| | |
|---|---|
| Los agentes saben qué hacen los otros | resumen al empezar el turno: quién trabaja, en qué, qué archivos toca |
| El resumen incluye lo que el otro contó | lo último que dijo en el chat, para que no se reinventen decisiones |
| El agente comprueba antes de cerrar | build/typecheck antes de decir "listo", y arregla lo que rompió |
| Quitar el permiso de ceder | daba pie a que un error quedara sin arreglar en silencio |
| Decirle que ya hay un dev server | el agente levantaba los suyos y quedaban huérfanos |
| Un stream cortado dice qué pasó | `"JSON inválido"` cuando en realidad se acabaron los créditos |
| roadmap: por qué no lleva task list | la decisión escrita, con el razonamiento |

Archivos tocados: `server/src/agent/loop.ts`, `server/src/engine/agents.ts`, `server/src/engine/file-mutation.ts`, `server/src/agent/providers/anthropic.ts`, `server/src/index.ts`, `server/src/demos/agentes-se-ven.ts`, `ROADMAP.md`.

---

## Documentos

| | |
|---|---|
| `README.md` | inglés, corto. La cara pública |
| `E2E.md` | el recorrido completo del sistema y qué está verificado |
| `ROADMAP.md` | lo que falta, con los callejones ya recorridos |
| `CONTRIBUTING.md` | dónde vive cada cosa y las convenciones |
| `DESIGN.md`, `soul.md` | cuaderno personal, **fuera del repo** |

---

## Cómo correrlo

```bash
npm install
npm start          # todo en :4000
npm run compartir  # + túnel público
```

Desarrollo: `npm run dev` (server) y `npm run dev:web` (Sala con HMR en :5173).

Demos sin API key: `demo:concurrency` (17/17), `demo:agentes-se-ven` (12/12), `demo:providers` (17/17), `demo:back` (12/12), `demo:aislamiento` (10/10), `demo:keys` (6/6), `demo:menciones` (9/9), `demo:interrupcion` (6/6).

**Nota de entorno:** en WSL sobre `/mnt/c` el server tarda ~5 min en arrancar (Windows traduciendo lecturas de `node_modules`). No es un cuelgue.
