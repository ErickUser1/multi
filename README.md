# Multi

**Construir en paralelo sin divergir.** Una sala en vivo donde varias personas y varios agentes de IA trabajan sobre el mismo proyecto, viendo lo mismo al mismo tiempo.

Se siente como entrar a un Discord: llegas por un link, ya hay gente adentro, y lo que pasa se ve pasar. Solo que en vez de jugar, están construyendo.

---

## El problema

Dos personas van a construir algo. Sacan requerimientos, se reparten: *"tú la sección de pedidos, yo la de usuarios"*. Cada uno se va a su rama, su editor, su agente.

Tres días después se muestran lo que hicieron.

```
SIN MULTI                          CON MULTI
──────────────────────             ──────────────────────
sacan requerimientos               sacan requerimientos
"tú X, yo Y"                       los dos en la misma sala
      ↓                                   ↓
3 días cada uno, a solas           ves lo que hace mientras lo hace
      ↓                                   ↓
"listo, mira"                      "espérate, eso no era"
      ↓                                   ↓
"…no era eso"  →  iterar           (la divergencia no llega a existir)
```

El costo no es el merge — eso git lo resuelve. El costo es que **la divergencia se descubre al final**, cuando ya hay tres días de trabajo apoyados en un supuesto equivocado. Y con agentes es peor: producen más código, más rápido, en direcciones que nadie está viendo.

Las herramientas de IA para construir software son de un jugador: tú, tu agente, tu contexto. Cuando entra otra persona, lo único que se comparte son capturas de pantalla y buena voluntad.

Multi hace que el proyecto sea el lugar donde están, no el archivo que se pasan.

<sub>Nació de un caso real: dos amigos, uno en Lovable y otro en Claude Code, dos backends que no se conocían, y una app armada con pegamento al final.</sub>

---

## Cómo se siente

```
┌─────────────────────┬──────────────────────────────────────────┐
│  taco-crew-21       │  [ SELECCIONAR ELEMENTO ]      D  E  +   │
│  3 EN LA SALA       ├──────────────────────────────────────────┤
│                     │  LA APP    EL BACK                       │
│  ● agente-1         │ ┌──────────────────────────────────────┐ │
│    escribiendo Nav  │ │                                      │ │
│  ○ agente-2 libre   │ │     tu app, moviéndose en vivo       │ │
│                     │ │                                      │ │
│  ─────────────────  │ │        ↖ erick                       │ │
│  D  Donscanor       │ │                    ↖ el compa        │ │
│    @agente haz el   │ │                                      │ │
│    header rojo      │ └──────────────────────────────────────┘ │
│                     │  HISTORIAL  ● ● ● ● ●            AHORA   │
│  AI agente-1        │                                          │
│    Listo, ya quedó  │                                          │
└─────────────────────┴──────────────────────────────────────────┘
```

- **Le hablas a un agente con `@agente`.** Sin la mención, el chat es entre humanos: puedes platicar sin que nadie se ponga a trabajar.
- **Cualquiera puede interrumpir a cualquier agente.** Si tu compa le pidió el header rojo y tú ves que va mal, `@agente-1 mejor azul` lo detiene ahí mismo.
- **Varios agentes a la vez.** `@agente` lanza uno nuevo; trabajan en paralelo y el motor evita que se pisen.
- **Señalas y hablas.** Clickeas un botón del preview y todos ven qué seleccionaste; lo que pidas se aplica a ese elemento.
- **El historial es de la sala.** Cada turno de agente es un punto al que puedes volver, con el diff y con lo que se pidió.

---

## Correrlo

Necesitas [Node 22+](https://nodejs.org) y, si quieres aislamiento, [Docker](https://docs.docker.com/get-started/get-docker/).

```bash
git clone https://github.com/ErickHub192/multi
cd multi
npm install
npm start
```

Abre **http://localhost:4000** y crea una sala. Al pedirle algo a un agente te va a pedir tu API key — eso es todo el setup.

### Meter a alguien más a la sala

```bash
npm run compartir
```

Compila, levanta el server, abre un túnel y te imprime un link público. Se lo pasas a quien quieras y entra directo, sin instalar nada.

> Mientras eso corre tu máquina está expuesta a internet, y **cualquiera con el link entra a cualquier sala**. Los ids son impredecibles, pero no hay más puerta que esa. Cierra con `Ctrl+C` al terminar, y saca tu key del `.env` si no quieres que la usen.

### Desarrollo

```bash
npm run dev       # el server, en :4000
npm run dev:web   # la Sala con HMR, en :5173
```

---

## Tu modelo, tu cuenta

Multi no trae modelo incluido ni cobra por tokens: **cada quien pone su propia key**, y paga solo lo que le pide al agente. En una sala, uno puede estar con Claude, otro con un modelo gratis y otro con un modelo local — no se estorban.

Soportados: **Anthropic**, **OpenRouter** (y por ahí Gemini, GPT, DeepSeek, Llama, Gemma), **OpenAI**, **Groq**, **DeepSeek** y **Ollama** en tu máquina.

Tu key vive en tu navegador y en la memoria del server mientras estás conectado. No se escribe en disco, no entra al contenedor, y nadie más en la sala la ve. Si vas a compartir pantalla, hay un botón para olvidarla.

Si prefieres una key de respaldo para toda la sala, copia `server/.env.example` a `server/.env`. No es obligatorio.

---

## Cómo funciona por dentro

```
┌─────────────────────────────────────────────┐
│  LA SALA                                    │  humanos y agentes conviven
│  chat, preview vivo, cursores, presencia    │  lo social y visible
├─────────────────────────────────────────────┤
│  AGENTES (N, reactivos, en paralelo)        │  cada uno un jugador
│  loop + tools; viven en la sala,            │  con nombre y color
│  operan el motor                            │
├─────────────────────────────────────────────┤
│  EL MOTOR                                   │  carpeta por sala con su
│  workspace + git + dev server + proxy       │  propio git, aislada en
│                                             │  un contenedor
└─────────────────────────────────────────────┘
```

Cuatro decisiones que explican casi todo:

**El agente se escribió a mano.** Sin frameworks de agentes y sin SDK del modelo: un `while` con un `switch` que manda mensajes, recibe `tool_use`, ejecuta y repite. Los clientes HTTP hablan con las APIs directo.

**La sala nace vacía.** Cero plantilla. El agente scaffoldea el proyecto con el stack que le pidas — si no le dices, elige uno y lo menciona. El motor no sabe de frameworks: lee el `package.json` para saber cómo levantar el proyecto, y el proxy inyecta el inspector sin importar el stack.

**Dos canales, dos velocidades.** El preview se actualiza en cuanto se escribe un archivo, sin esperar commits (si esperara, la sala se sentiría muerta entre turnos). El historial guarda un commit por *turno* — cinco archivos tocados son un punto, no cinco.

**Los conflictos los resuelve el modelo, no tú.** Si dos agentes tocan el mismo archivo, el segundo recibe "esto cambió, léelo otra vez" y reaplica su cambio sobre lo nuevo. No hay modal de conflicto: los dos cambios sobreviven.

El recorrido completo, con las piezas y qué está verificado, está en **[E2E.md](E2E.md)**.

---

## Aislamiento

Cada sala corre en su propio contenedor de Docker. El agente puede instalar lo que necesite y correr lo que sea, pero encerrado en el workspace de esa sala: tu disco, tu home y tus llaves no existen para él.

Eso importa aquí más que en un agente de un solo usuario: **quien manda el comando no es el dueño de la máquina donde corre.** Si invitas a alguien a tu sala, su agente ejecuta en tu equipo.

Sin Docker, Multi arranca igual — pero avisa fuerte que no hay aislamiento, porque correr así con invitados es una decisión que debes estar tomando a sabiendas.

---

## Probarlo

```bash
npm run typecheck

npm run demo:aislamiento   # el agente no puede salir de su sala
npm run demo:concurrency   # CAS, mutex y coordinador con agentes en paralelo
npm run demo:historial     # diffs, bookmarks y volver a un punto
npm run demo:keys          # las keys son de cada persona
npm run demo:menciones     # a quién le hablas y cómo interrumpir
npm run demo:providers     # la traducción de formatos entre proveedores
npm run demo:back          # el mapa de endpoints
```

Son demos, no unit tests: cada una ejercita el flujo real e imprime qué pasó. El criterio es "se ve funcionando".

---

## Estado

Funciona de punta a punta: entras a una sala vacía, pides un proyecto, el agente lo construye, el preview aparece solo y de ahí iteras en vivo con quien esté contigo.

Lo que falta, con el contexto de por qué no se hizo, está en [ROADMAP.md](ROADMAP.md):

- **El back visual completo** — hoy muestra endpoints; falta lo que la app *guarda* (las tablas), que es lo que un compa necesita para no chocar contigo.
- **Migrar el runtime a Bun** — el arranque tarda ~5 min en WSL sobre `/mnt/c`; medido, Bun es 9× más rápido ahí.
- **Cursor del agente sobre el preview** — requiere mapear archivo → elemento visual.
- **Hosting** — apagar salas inactivas, HTTPS con dominio propio.

---

## Contribuir

Se aceptan PRs. Lo que ayuda a que se revisen rápido está en [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Licencia

MIT — ver [LICENSE](LICENSE).
