# Multijugador — Diseño del producto

Fecha: 2026-07-22 (act. 2026-07-24) · Estado: DISEÑO CERRADO + arquitectura técnica definida, pre-código

## Narrativa (el posicionamiento oficial — lo primero que la gente entiende)

**Un Discord, pero en vez de jugar videojuegos con tus compas, te juntas para vibecodear.**

- Nombra un comportamiento QUE YA EXISTE y apesta hoy: la gente se junta en videollamada ("vamos a vibecodear juntos") y cada quien en su herramienta (uno en Lovable, otro en Claude Code), chocando — la historia de origen del fundador. No inventamos el hábito; le damos el lugar que le falta.
- Instantáneamente entendible (un chavo de 16 lo capta en 2s), a diferencia de "IA multijugador" (suena técnico/enterprise).
- El framing de Discord da gratis: lo social implícito, la diversión como punto (nadie entra a Discord a "ser productivo" — entra a pasarla con sus compas → separa 100% de Ace/enterprise), el modelo mental de "salas".
- Eslóganes: "Vibecodea con tus compas" · "Un Discord para construir apps con tus amigos" · "Junta a tus compas. Construyan algo. En vivo."
- Reposiciona el producto SIN cambiar el diseño técnico — solo cómo se cuenta: de "herramienta de IA colaborativa" a "el lugar donde te juntas con amigos a crear".
- Matiz: es la narrativa de ENTRADA (hace que prueben). No encierra — como Discord, que empezó "para gamers" y creció a toda comunidad, puedes entrar por "vibecodea con compas" y crecer a "construye lo que sea con quien sea".

**La verdad de origen (sin adornar):** le pasó al fundador. Él y su compa, cada uno en su Zoom compartiendo pantalla, uno en Lovable otro en Claude Code — vibecodeando juntos, hablando del producto y del futuro mientras el agente trabajaba. Funcionó como MOMENTO. Murió como proyecto, porque nunca hubo un lugar real donde eso viviera — solo dos pantallas separadas, pegadas con la mano al final.

**Motor emocional (dos cosas reales, no "diversión" genérica):**
1. **Ambición compartida** — no te juntas a programar por jugar; te emociona una idea y quieres construirla con alguien que se emociona igual. Eso sostiene el esfuerzo cuando se pone difícil.
2. **El loop de avance, duplicado** — cada "ya quedó esto" es una pequeña victoria; en Multi ves la tuya Y la de tu compa casi al mismo tiempo, en el mismo canvas. El enganche del vibecoding solo, x2.

**Pitch en una línea:** Vibecodea con tus compas — como esa llamada de Zoom donde ambos compartían pantalla, pero ahora en un solo lugar donde todos ven todo en tiempo real, sin pegar nada con la mano al final.

**El "durante" (hueco a resolver antes del lunes — la parte más tuya y difícil de copiar):** el momento real no fue el output, fue la PLÁTICA mientras el agente construía (el futuro, la tecnología, el producto). Eso no está aún en el landing ni el mockup. Ningún competidor lo tiene porque es humano, no técnico. Diseñar cómo se siente "estar ahí" mientras el agente trabaja.

**Competidor real — Replit** (más cercano que Ace). Investigado a fondo (2026):

**Replit YA tiene todo lo técnico — NO competir en features:** multiplayer con cursores nombrados + presencia (maduro, fluido), multi-agente real (Agent 4, hasta 10 en paralelo), merge automático de conflictos vía agente, humanos aprobando tareas en vivo (board Kanban). Tiene $9B de valuación (Serie D, mar 2026), ~$150M ARR, 85% del Fortune 500. Si el pitch es "colaboración + varios agentes", Multi pierde. NO forzar ese ángulo.

**Replit ABANDONÓ el terreno de Multi a propósito — ahí está la apertura (el hueco es de IDENTIDAD, no de features):**
1. **Mató su comunidad social en 2024** — removió búsqueda social, Repls embebidos, comentarios, deploys gratis. Hubo protestas ("Don't Remove the community"). Hundió una de las comunidades de programadores más grandes. → **usuarios huérfanos y resentidos esperando.**
2. **Full enterprise** — pivote explícito 2025 a no-técnicos empresariales (Zillow, Coinbase, Mercedes). Pro $100/mes, Enterprise con llamada de ventas. Cero vibra hangout.
3. **La gente ODIA su billing** (queja #1) — sistema de créditos que se quema; gente reporta $70 en una noche, 20x lo esperado; y el agente se equivoca y te cobra por arreglar sus errores (The Register lo cubrió). Resentimiento activo. → **modelo de precios de Multi como arma directa: BYO-API-key o flat.**
4. **100% cerrado, sin self-host** — no existe equivalente open source completo. Queja de lock-in/control/privacidad viva. → open source de Multi ataca esto directo.
5. **Vibra corporativa** — nadie ocupa el espacio "divertido, con amigos, low-stakes, creativo". Es el Discord-vs-Slack / itch.io-vs-plataforma-enterprise.

**Veredicto (= tesis de Multi confirmada):** Multi NO es "Replit pero mejor" (perdería). Multi es **todo lo que Replit dejó de ser**: casual vs corporativo, social/comunitario vs herramienta-sola, open source vs lock-in, precios que no te traicionan vs créditos que se queman. Replit desocupó ese asiento a propósito; hay comunidad huérfana esperando. La narrativa "Discord para vibecodear con tus compas" ES literalmente ese asiento vacío.

**Dos riesgos honestos del hueco (ir con los ojos abiertos):**
1. **El casual es difícil de monetizar** — Replit se fue a enterprise porque ahí está el dinero ($2.5M→$250M ARR persiguiendo empresas). El reto de Multi no es el producto, es cómo ganar dinero del casual (por eso el open-core → hosting importa, y BYO-key baja el costo de inferencia).
2. **"Discord para X" = cold-start** — la retención viene de la red social; arrancar una red es difícil. Por eso el core (vibecodear juntos) tiene que enganchar ANTES de la capa social.

**Base histórica de la narrativa (fechas VERIFICADAS en web; la síntesis del "punto medio" es lectura propia):**
- **2018** → Replit lanzó Multiplayer en beta (cursores en vivo, ejecución compartida). **2019** → lo volvió primitiva central, rediseñó su protocolo para ser "colaborativo de corazón". Su frase textual de entonces: **"codea con amigos"** (= literalmente la narrativa de Multi; la tuvieron, la nombraron así, la abandonaron).
- **Abril 2024** → Replit Teams (pivote a equipos/enterprise, mató lo social casual).
- **2026** → Agent 4 (multiagente serio), Serie D $9B.
- **La síntesis (lectura propia, no dato publicado — presentar como "mi análisis de su timeline"):** el punto medio —vibra casual de amigos + IA potente— NUNCA existió en Replit. Tuvieron "codea con amigos" en 2018 SIN IA útil, y la IA potente en 2026 SIN la vibra (ya enterprise). Y ese punto medio apenas se volvió POSIBLE ahora (modelos 2026 hacen el vibecoding real) = el "why now" con base histórica dura. El asiento está vacío y por primera vez es construible.
- **Matiz honesto:** el timeline prueba que el asiento está VACÍO, no que dé DINERO. Replit se fue por estrategia (el casual no monetiza fácil), no por descuido. Oportunidad de producto = verificada; modelo de negocio = la apuesta a probar.

## Tesis técnica (una frase)

**Los humanos se dividen el trabajo hablando (como en Google Docs). Los agentes se ponen de acuerdo entre ellos por abajo (shapes, mocks, swaps). Y todo — lo de arriba y lo de abajo — es visible en tiempo real.**

## Origen

- Ensayo "Multiplayer AI" de Aaron Epstein (YC), publicado 2026-07-22: las mejores herramientas ganaron al volverse multiplayer (Docs vs Word, Figma vs Photoshop); la IA aún no tiene su momento multiplayer.
- Dolor propio vivido: proyecto a dos personas — uno en Lovable, otro en Claude Code. Dos backends divergentes, caja negra mutua, features distintos, merge final "con pegamento". El proyecto sufrió/murió por no existir un lugar común donde ambos agentes convivieran.

## Por qué AHORA (el "why now")

Construir apps con amigos como actividad social no es idea nueva — lo nuevo es que **por fin es posible para todos**. Antes "construyamos algo juntos" exigía que ambos fueran programadores → mercado nicho (dos devs con las mismas skills). Hoy la barrera técnica es **cero**: el vibecoding volvió "construir una app" tan casual como hacer un doc o un diseño en Canva. El mercado ya no es "dos programadores" — es **cualquier par de amigos con una idea**, un mercado ~100x más grande que apareció en los últimos ~2 años.

Mismo patrón que las herramientas del ensayo de Epstein:
- Google Docs no inventó escribir juntos — lo hizo posible sin Word ni saber de formato. Mercado = todos los que escriben.
- Figma no inventó diseñar juntos — lo hizo posible en el browser sin ser experto en Photoshop. Mercado ≫ diseñadores pro.
- Multi no inventa construir apps juntos — lo hace posible sin saber programar. Mercado de "gente que construye software" = **ahora es todo mundo**.

El timing es la joya: **no se podía hace 3 años** (con GPT-3.5 el agente no construía apps de verdad → "construir juntos con IA" no tenía sustancia). Los modelos actuales lo hicieron real este año. Convergen dos olas en la ventana exacta: (1) la capacidad técnica acaba de nacer, (2) el comportamiento social (todo mundo quiere construir apps) acaba de explotar. Nadie ha juntado las dos con la capa social encima — Ace va por enterprise, Lovable es single-player. El espacio "construir apps juntos, socialmente, para cualquiera" está vacío.

## Usuario objetivo

**Duos/trios de vibe-coders sin empresa** — gente que se junta por Discord/X para construir proyectos sin equipo formal, sin repo compartido, sin proceso. NO el equipo de ingeniería enterprise.

Razón (eureka de la sesión): los grandes ya van por enterprise —
- **Ace (GitHub Next):** multiplayer coding agent workspace, ecosistema GitHub
- **Zed:** $32M de Sequoia, colaboración humano-agente en su editor
- **Dust:** "multiplayer AI" para empresas
- Todos presuponen: mismo equipo, misma herramienta, mismo repo, mismo empleador. El duo ad-hoc cross-tool no lo atiende nadie. Para este segmento **la diversión ES el producto** (videojuego, votar, presencia) — enterprise nunca va a competir ahí.

## Decisión estratégica: reemplazo, no capa intermedia

Se evaluó ser "capa intermedia" (contrato compartido entre Lovable y Claude Code, cada quien con su tool). Se descartó por la analogía central del ensayo:
- Docs **reemplazó** Word; Figma **reemplazó** Sketch. Import una vez, adiós.
- Precedente letal: **Abstract** (capa de colaboración/versionado sobre Sketch) murió cuando Figma hizo el multiplayer nativo — el multiplayer nativo elimina el problema que la capa resolvía.
- Estrategia Docs: ganar usuarios NUEVOS primero (proyectos que NACEN compartidos), no rescatar codebases divergidas.
- El "Word interno" ya no cuesta 4 años: existe bolt.diy (motor open source tipo Lovable: chat → agente → código → preview). El trabajo propio es la parte multiplayer.

## Modelo mental central

**El código es el formato de archivo, no la interfaz.** Como nadie edita el XML de Docs, nadie edita el código a mano: el "documento" compartido es la app viva (preview). Código visible read-only para quien quiera ("abrir el cofre"), editable solo vía agente.

## Principios de diseño (destilados por iteración)

1. **La visibilidad ES la coordinación.** Como en Docs: no escribes sobre la sección del otro porque lo VES escribiendo ahí. Sin locks, sin contratos visibles, sin carpetas asignadas.
2. **El estado es la interfaz. Si alguien necesita un resumen, el canvas falló.** Nada de narración/catch-up: abres la sala y ves qué hay, qué es real y qué es promesa.
3. **Los conflictos son manejo de excepciones, no feature central.** Modal de voto solo para: (a) simultaneidad genuina rara, (b) desacuerdos humanos de producto ("¿login con Google o email?"). Si el modal sale seguido, el motor está fallando.
4. **Capa humana social, capa agente rigurosa.** La rigurosidad (contract-first) existe sin que ningún humano la administre.
5. **Lo que ves, lo editas ahí mismo (EEA).** El estado no solo es visible — es editable en su lugar. Click al endpoint → resumen estructurado ("recibe: email, password · valida: mínimo 8") → tachas 8, pones 12. Diff exacto en vez de frase suelta que el agente interpreta; la tarea del agente pasa a "haz que el código cumpla la spec" (verificable). La spec es proyección bidireccional del código (se genera de él, lo regenera); divergencia = rojo en canvas (mismo mecanismo del mismatch de mocks). Ediciones a la spec visibles para todos en vivo, como Docs. **Frontera: el chat crea ("agrega login"), la spec afina ("12 en vez de 8")** — obligar todo por specs mata el videojuego. **EEA aplica solo al back** (endpoints, tablas, validaciones): la spec es proyección de lo que el código ya hace — enumeración finita, editarla no limita nada. **En el front NO hay panels ni knobs de propiedades:** todo cambio va por click (ancla el "cuál" exacto, selección visible para todos) + lenguaje al chat (el "qué", sin techo). Razón: cada control directo define el techo de lo editable — knob por knob se construye un Wix y el usuario acaba diseñando dentro de nuestro catálogo en vez de customizar; el lenguaje sobre código real no tiene techo. Consistencia igual la cuida el motor: aplica cambios como token/estilo global cuando corresponde (o pregunta "¿solo este o todos?") y el manual vivo destila los patrones.

   **REFINAMIENTO (lección de Replit Visual Editor, 2026) — edits deterministas para lo TRIVIAL:** el "cero panels" se mantiene para layout/estructura/estética/comportamiento (eso es lo que se vuelve Wix), PERO se agrega **edición directa determinista SOLO para los 3 casos triviales e inequívocos: texto literal, color, spacing.** Estos NO pasan por el agente — se aplican directo al código, instantáneo y GRATIS (cero tokens). Por qué el cambio de postura: mandar el loop del agente para "cambia 'Hola' por 'Adiós'" es un misil para una mosca — cuesta tokens (dinero real, arma directa contra el billing de Replit que la gente odia), es lento, y es no-determinista. La línea clara: ¿es un valor literal único y obvio? → directo. ¿Requiere interpretar intención (layout, "más premium", estructura)? → agente. Esto NO es "panels de Wix" (el usuario no elige de un catálogo) — es "no gastes un misil en una mosca". Reconcilia el instinto anti-Wix con el ahorro de costo/velocidad.

   **Instancias múltiples (loop/componente reusado):** al seleccionar un elemento que viene de un componente renderizado N veces (ej. una `<Card>` que aparece 20 veces), el cambio afecta a TODAS porque en el código es UN componente, no 20 (el código es la verdad, el DOM son copias). Regla: **resaltar las N instancias antes de aplicar** para que el usuario vea el alcance (como Replit) — y en Multi, TODOS en la sala ven las N resaltadas (Replit se lo muestra solo al que clickeó = diferenciador). Ambigüedad de intención (¿esta una o todas?): el edit determinista es solo para lo inequívoco; la duda "esta vs todas" va al lenguaje/agente, que desambigua o pregunta. Detalle técnico: detectar "aparece N veces" desde el DOM puro es difícil (el DOM no sabe qué componente lo generó); Replit usa metadata de React. Para v1 se aproxima con tag+clases; el caso fino lo resuelve el agente (que sí ve el código). = la respuesta madura al "¿solo este o todos?" que ya estaba en este principio.

## Arquitectura del producto (4 piezas)

1. **Sala con link** — entras estilo Docs/Figma: link, browser, cero setup. Humanos + agentes como participantes con nombre y presencia. Un solo canal; el chat es el log del proyecto. No existen sesiones privadas → no existe caja negra.
2. **Estado 100% visible** — preview del front compartido en vivo + back desabstraído en el mismo canvas (schema como diagrama vivo, endpoints con estado visual: punteado/gris = mock, sólido/verde = real, rojo = mismatch). Click a un botón del preview ilumina la ruta botón → request → endpoint → tabla.
3. **Click-to-edit anclado** — seleccionas un componente (o tabla del back); tu selección se ilumina para todos (cursor con nombre estilo Figma); el mensaje queda anclado al componente; el cambio se renderea en vivo para todos.

   **PENDIENTES de pulido (Fase 3 construida, falta refinar):**
   - **Cursor remoto dentro del preview.** Hoy el cursor de otros se dibuja sobre el ESCENARIO (el marco), no dentro del iframe — o sea no se ve exactamente sobre el elemento que el compa está mirando. Fix: el inspector.js (que ya vive dentro del iframe) reporta también la posición del mouse por postMessage, igual que ya hace con los clicks (~10 líneas, mismo camino probado). Esto NO es solo estético: ver que tu compa señala ESE botón es la esencia del "todos ven lo mismo".
   - **Estética del cursor**: hoy es un SVG genérico y feo. Pulido puro.
   - **Edits deterministas (Replit-style)**: texto/color/spacing directo al código sin agente. Es v2 (ver principio 5 del diseño). La base ya existe: el sistema ya sabe QUÉ elemento se seleccionó y su selector.

   **Cómo se inyecta el inspector (decidido — reverse proxy, patrón ui-annotator-mcp):** el preview se sirve vía un reverse proxy en el server de Multi (`/preview/:roomId` → dev server de la sala), NO tocando el proyecto del workspace (agnóstico al stack: funciona con Vite/Next/Astro/HTML puro). El proxy es **`http` de Node puro, cero libs** (ui-annotator lo hace así en ~50 líneas; las libs de Fastify complican el transform de HTML + WS). Para respuestas HTML: inyecta `<script>` inspector antes de `</body>`, **reescribe `href="/..."` y `src="/..."`** para que las rutas pasen por el proxy, y **quita el header Content-Security-Policy** para permitir el script. CSS/JS/imágenes pasan directo. Da same-origin gratis (resuelve el cross-origin del iframe → el inspector puede LEER el DOM). Diferencia con ui-annotator: ellos usan GET polling cada seg; Multi NO — el script inyectado manda el click por `postMessage` al padre (la sala), y la sala (que tiene socket.io) lo retransmite a todos + al agente. Ref: github.com/mcpware/ui-annotator-mcp, issue slopus/happy#802.

   **4 cuidados del click-to-select:** (1) validar `event.origin` en el listener de postMessage (no confiar en '*'); (2) el anclaje usa la selección LOCAL del usuario que manda, no una global (cada quien la suya, con su color); (3) al agente se manda TEXTO legible (tag/clases/texto/selector para grep), NO el JSON crudo con bbox; (4) al mandar mensaje anclado → limpiar la selección.

   **Dos datos del mismo click, destinos distintos:** el **bbox** (x,y,w,h) viaja a los navegadores para DIBUJAR el outline (uso visual). El **selector/tag/texto** viaja al agente para ENCONTRAR el código con grep (uso lógico). No mezclar.

   **Edge case — el elemento seleccionado desaparece por HMR** (el agente lo editó/borró): el outline dibujado sobre un bbox viejo queda fantasma (peor en Multi: todos ven el outline flotando sobre nada). Solución: el inspector.js NO confía en el bbox congelado — guarda el **selector** y tras cada cambio del DOM (MutationObserver, como ui-annotator) re-ejecuta `querySelector`: si el elemento sigue → recalcula bbox y el outline lo sigue; si murió → la selección se limpia sola y se avisa a la sala. El ANCLAJE al agente NO es frágil: viaja como texto en el payload del mensaje (una foto), no como referencia viva, así que sobrevive aunque el elemento desaparezca. Principio general: el DOM es efímero (cambia con cada HMR), nada dibujado encima puede asumir que se quedó quieto — cursores/selecciones/outlines se re-anclan o se desvanecen cuando el mundo cambia (versión visual de "el estado es la interfaz").
4. **Motor invisible (EL MOAT)** — el sistema nervioso que permite paralelo sin pensar en el paralelo:
   - Serializa escrituras de agentes; **el preview nunca muere** (equivalente al OT de Docs).
   - Paralelismo front/back: si el back ya existe, el agente de front **lee** el shape real (caso 80%). Si no existe aún, los agentes **acuerdan el shape entre ellos en el canal** (visible si te asomas), el mock se genera de ese shape acordado.
   - Swap mock→real automático cuando el endpoint real aterriza y cumple el shape. Mismatch → pieza en rojo en el canvas, agentes reconcilian o preguntan si es decisión de producto.
   - Memoria compartida + manual vivo: los agentes destilan patrones y decisiones en el mismo canal; el proyecto se vuelve más consistente con el tiempo.

La sala y el chat los clona cualquiera en un fin de semana; el motor es lo difícil y defendible.

5. **Infraestructura invisible** — cero configuración, el usuario nunca ve commits, push, ni dashboards:
   - **Git abajo:** el motor commitea solo (cada cambio de agente = commit). UI: línea de tiempo visual con scrubber + "regresar a esta versión" + "marcar versión". No existe botón de guardar — se guarda solo, como Docs.
   - **Supabase abajo (BYO como Lovable):** el usuario conecta/crea su proyecto Supabase una vez; es dueño de sus datos. El agente corre migraciones desde el chat. UI: el diagrama de tablas del canvas, jamás el dashboard.
   - **Endpoints = Supabase Edge Functions POR DEFAULT** (decisión de arquitectura propia, no posicionamiento — no competimos con Lovable, es otra categoría): el front habla con endpoints, no con tablas directo. La service role key nunca toca el browser. RLS es segunda muralla, no la única.
   - **Por qué:** lección aprendida del patrón front→BD directo con RLS como única muralla (Lovable sí genera RLS, pero cuando es la única capa, una política faltante = tabla pública: CVE-2025-48757, ~10% de 1,645 apps con alguna política rota, 170+ filtrando datos vía anon key). Con capa de API, el mismo descuido topa con muralla antes de la tabla. Además: sin capa de API no hay nada que visualizar — el canvas del back con semáforo REQUIERE que el back exista como concepto. La feature visual y la decisión de seguridad son la misma decisión.
   - **Seguridad como estado visible:** tabla sin política RLS o con política floja = tabla ROJA en el canvas. Nadie lee audits; ves rojo y le dices al agente que lo arregle.
   - Referencias: integración Lovable-Supabase 2.0 (blue/red zone, migraciones, edge function logs), CVE-2025-48757 (superblocks.com/blog/lovable-vulnerabilities, vibeappscanner.com/lovable-security).

## Arquitectura técnica de implementación (definida 2026-07-24)

### Modelo mental: un proyecto real por debajo, con la abstracción escondida

Debajo de la sala hay un proyecto de verdad: una carpeta con su git, sus dependencias y su dev server. Lo que se esconde no es el proyecto, es la ceremonia de operarlo. **Dos capas + el agente como puente:**

```
┌────────────────────────────────────────────┐
│  LA SALA  (nuestra diferenciación)         │  ← humanos + agentes conviven
│  chat, preview vivo, cursores, presencia    │    lo social y visible
├────────────────────────────────────────────┤
│  AGENTES (N puentes, reactivos, paralelos)  │  ← cada uno un jugador con
│  loop + tools; viven en la sala, operan     │    cursor/nombre/color
│  el motor                                   │
├────────────────────────────────────────────┤
│  EL MOTOR                                   │  ← carpeta por sala + git propio,
│  workspace + git + dev server + proxy       │    dev server y proxy inyector
└────────────────────────────────────────────┘
```

- **El motor son las tools del agente sobre un filesystem real, no un editor.** Un editor (VS Code, openvscode-server) es un VISOR para humanos: los archivos existen en disco con o sin él, y el agente escribe con sus tools directo al filesystem — igual que Claude Code, que no depende de que tengas un editor abierto. Confundir el visor con el motor lleva a construir infraestructura que nadie necesita.
- **De ahí sale el multi-stack gratis:** el motor no sabe de frameworks. Corre lo que el agente scaffoldee y proxea el puerto que levante. El usuario nunca se casa con un stack — el agente pregunta o infiere, como Claude Code.
- **openvscode-server sigue teniendo un lugar, pero es otro: "abrir el cofre"** — dejar que quien quiera se asome al código en un editor real dentro de la sala. Es una feature de UI opcional (el equivalente a que tú abras la carpeta en tu editor), no una pieza del motor. Nada depende de ella; hoy el acceso al código se cubre con el historial y sus diffs.
- **Los agentes son REACTIVOS, no autónomos.** El humano los dispara (escribir en chat / seleccionar+hablar); el agente entra al loop, trabaja, y duerme hasta el siguiente trigger. Autonomía solo de EJECUCIÓN dentro de una tarea (decide qué archivos crear, qué instalar), nunca de iniciativa (el QUÉ siempre lo pone el humano). Regla: humano inicia, agente ejecuta y se detiene, cero acción no solicitada.
- **Auto-verify (robar de Claude Code Desktop Preview) — refinamiento del motor, va con Fase 4+:** tras editar, el agente verifica que NO rompió el preview antes de decir "listo": revisa que cargue, checa errores de consola/build, y si rompió algo lo arregla solo. Importa MÁS en Multi que en Claude Code: si el agente rompe el preview, 2-3 personas ven la pantalla en blanco a la vez → se acaba el "videojuego". Es la implementación concreta del principio "el preview nunca muere". Mecanismo: la tool Bash corre build/lint + el agente lee logs del preview. NO es v1-mínimo (ahí el agente edita y ya); es la capa de robustez.
- **Coordinación entre agentes = por el workspace compartido**, no por protocolo. Agente-back crea la tabla, agente-front la lee del mismo filesystem. La visibilidad es la coordinación.

### Stack (cerrado)

- **Node + TypeScript en TODO** (server, web, agentes). Cero frameworks de agente (ni LangGraph — Claude Code tampoco usa framework), cero SDK de modelo.
- **Agentes a mano**, siguiendo el blueprint de CCX-RS / Claude Code (`~/ccx-rs`, reverse-engineering documentado). El loop es un while+switch: mensaje → API stream → si stop_reason==tool_use ejecuta TODAS las tools en paralelo → mete resultados → repite; termina en end_turn/max_tokens/límite de turnos.
- **3 providers HTTP directos** (Claude, GPT, Gemini) tras una interfaz común `ModelProvider.stream(mensajes, tools)`. Un adaptador por proveedor (formato de tools/stream difiere entre los 3). Sin OpenRouter (solo 3 conocidos = 3 clientes directos, más barato/rápido). Default: Claude para el agente de código. Cambiar de modelo = instanciar otra clase.
- **Tools del agente** (schema exacto en `~/ccx-rs/research-tools.md`): Read, Write, Edit (old/new/replace_all, escritura atómica temp+rename), Glob, Grep = funciones directas al filesystem (syscalls de Node, NO bash — precisas, observables: cada una emite evento socket `file:changed` → preview en vivo). Bash = terminal para procesos (npm install, git, arrancar dev server). Agent = spawnear otro agente-jugador (run_in_background, name, isolation).
- **Robar de CCX / evitar sus gaps:** streaming con callbacks on_text/on_thinking (agente "escribiendo" en vivo en el chat); retry con backoff en 429/529; permission gate antes de cada tool; tools en PARALELO desde día 1 (CCX las hace en serie); compactación de contexto (MicroCompact) desde temprano — sesiones de horas; prompt caching activado.
- **Multi-agente — arquitectura confirmada por la doc oficial de Claude Code Agent Teams** (Anthropic publicó su implementación; VALIDA la tesis: su versión es solo terminal/tmux para 1 dev, sin visual ni segunda persona — el moat de Multi es la capa social/visual, no la arquitectura). Robar: (1) **lista de tareas compartida** que los agentes auto-reclaman (pending/in-progress/completed + dependencias); (2) **mailbox** de mensajes entre agentes (archivos JSON, entrega automática, no polling); (3) **file-locking al reclamar tarea** para evitar race conditions → confirma que serializar (cola FIFO) es el patrón correcto; (4) **cada agente posee archivos distintos** para evitar conflictos → confirma nuestra decisión de working tree. Sin las restricciones de ellos (líder fijo, un equipo por sesión, sin anidar) porque nuestra capa de sala es propia. Detalle en [[referencia-ccx-rs-claude-code]].
- **Fastify + socket.io** — salas, presencia, chat, broadcast del preview.
- **React + Vite** — la UI de la Sala (traducir `app/sala.html` a React).
- **Supabase** — persistir salas/proyectos + BYO del usuario para sus apps.
- **Astro** — el landing de marketing (SEO). El landing NO es Vite; solo el marketing estático usa Astro.

### Aclaraciones de vocabulario

- **"Template" / "plantilla" = NUESTRO monorepo interno** (server, web, motor), NO un molde para las apps de usuarios. Los proyectos de usuarios los scaffoldea el agente desde cero en el workspace del motor. Cero molde impuesto (a diferencia de Lovable).

## Plan de versiones — v1 COMPLETO desde ya (decisión: ~1-2 días, no fin de semana escalonado)

Se descartó el enfoque v0-primero: se construye v1 completo directo.

**Incluye:**
- Sala en vivo: entrar con link + nombre, chat, presencia, cursores de todos (humanos y agentes)
- Motor: workspace por sala (carpeta + git propio) + preview en vivo (dev server en iframe, HMR broadcasteado)
- Agente(s) a mano: loop + tools + 3 providers; **multi-agente en paralelo** con cursores
- Click-to-select: script inyectado → socket → selección compartida + mensaje anclado
- Back desabstraído (canvas de schema/endpoints con semáforo mock/real)
- Modal de conflicto (solo si la realidad lo pide)
- Manual vivo destilado (mecánica abajo)
- Persistencia Supabase

**Orden de construcción:** (0) workspace por sala + dev server corriendo → (1) agente + tools tocan el motor, ves un archivo cambiar → (2) sala mínima: preview iframe + chat, le hablas al agente y el preview se actualiza → (3) presencia + cursores + click-to-select → (4) multi-agente paralelo → (5) back visual → (6) persistencia.

**Demo de éxito:** (multiplayer) dos laptops, un link, "ponlo verde" → el otro lo ve al instante. (solo) entras solo, pides el menú, y MIENTRAS el agente lo construye en vivo seleccionas el título y disparas otro cambio — diriges un equipo, no esperas un spinner.

## Git por debajo + concurrencia — E2E de la mecánica

Adaptación del paper "Realtime GitHub" a nuestro caso (escritor = agente en bursts, no humano tecleando). El paper resuelve su unidad (transacción por teclazo) y su grano fino disuelve el problema del "preview vs commit"; nosotros SÍ tenemos ese gap y lo resolvemos con dos canales separados.

### Los DOS canales (dos velocidades, independientes)

- **CANAL 1 — TIEMPO REAL (lo que ven todos en vivo):** cada `Write`/`Edit` emite `file:changed` → el dev server (Vite) hace HMR → el preview (iframe) se refresca AL INSTANTE, archivo por archivo, MIENTRAS el agente trabaja. NO espera al commit.
  - **Listener eager (lección de OpenCode):** suscribir al bus de eventos ANTES de abrir el stream al cliente. Si no, se pierden los eventos emitidos en la ventana entre "el cliente conecta" y "el stream está listo" → se manifiesta como *"a veces falta el primer tool call"*, un bug horrible de diagnosticar. Aplica a nuestro socket.io igual.
  - **Semáforo de publicación (lección de OpenCode):** con tools corriendo en paralelo, sus eventos llegan intercalados. Serializar la publicación (permit=1) para que el orden que ve la UI sea coherente. El canvas del back (semáforo mock/real) igual: la pieza pasa de gris a verde en vivo. Red de seguridad ("el preview nunca muere"): si un estado intermedio rompería el render (componente sin su import), el motor espera al siguiente estado válido en vez de pantalla blanca.
- **CANAL 2 — GUARDADO (el historial):** el agente termina su turno → 1 commit. Es el checkpoint que alimenta el scrubber. Invisible ("guardado solo", como Docs). **Commit ≠ visualización:** el commit es solo el álbum de fotos; el preview va por el Canal 1, por delante, sin esperarlo.

### DOS problemas distintos, DOS mecanismos (corrección tras estudiar OpenCode)

Confundirlos fue el error del diseño original: usábamos la herramienta del historial (hash del árbol completo) para resolver la concurrencia de escrituras. Se separan:

| | **Problema A: escrituras concurrentes** | **Problema B: historial y volver atrás** |
|---|---|---|
| Escala | segundos | minutos/horas |
| Pregunta | ¿quién escribe qué AHORA? | ¿cómo estaba el proyecto ANTES? |
| Mecanismo | **CAS por archivo** (OpenCode) | **commit por turno + git** (paper) |
| Grano | un archivo | el proyecto entero |

**Lo único que se cae del diseño original:** el compare-and-swap sobre el hash del ÁRBOL COMPLETO con rebase automático. Era demasiado grueso — dos agentes tocando archivos distintos se estorbaban sin razón. Todo lo demás del paper sigue vigente.

### Problema A — escrituras concurrentes: CAS por archivo (patrón OpenCode)

- **Compare-and-swap POR ARCHIVO, no por proyecto.** Cada tool de escritura manda "espero que este archivo tenga estos bytes" (los que leyó). Si nadie lo tocó → escribe. Si cambió → falla con `StaleContentError`. Dos agentes en archivos distintos **nunca se estorban**.
- **El read-compare-write es atómico** vía un mutex por ruta canónica de archivo (`KeyedMutex`: misma clave → cola, claves distintas → paralelo). Y la escritura va en un bloque no-interrumpible: nunca queda un archivo a medio escribir.
- **El error va dirigido al MODELO, no al humano.** Mensaje estilo OpenCode: *"El archivo cambió después de que lo leíste. Léelo otra vez antes de editar."* → el LLM lo resuelve solo, sin interrumpir a nadie. En multi-agente esto pasa seguido; tiene que ser recuperable sin humano.
- **Mejora propia sobre OpenCode (encaja con "todos ven todo"):** al fallar el CAS, decirle al agente **QUIÉN** lo cambió y hace cuánto ("el agente del front tocó este archivo hace 12s"). OpenCode no lo tiene; el punto de enganche ya existe.
- **Coordinador por sala con coalescing** (patrón `run-coordinator` de OpenCode, ~100 líneas): un solo "drain" activo por sala, salas distintas en paralelo. Tres comportamientos a copiar: (1) **join en vez de encolar** — dos requests para la misma sala comparten la misma ejecución, no arrancan dos loops; (2) **coalescing de wakeups** — si llegan 5 mensajes mientras el agente trabaja, se arranca UNA sola ejecución al terminar (sin esto, con dos compas escribiendo en vivo, se queman tokens en ejecuciones redundantes); (3) **flag `stopping` con retry** — cierra la carrera cancelar/reiniciar (el bug que muerde a las 3 semanas).

### Problema B — historial: commit por turno (paper, sigue vigente)

- **Unidad de commit = por TURNO de agente** (cuando termina SU tarea). El scrubber muestra cambios con sentido ("puso el botón verde"), no ruido.
- **"Por turnos" NO significa que los agentes se turnen** — trabajan en PARALELO. "Turno" = el turno de ESE agente al terminar.
- **El servidor es la única autoridad** del estado de la sala. Los clientes no tienen repos.
- **Snapshots shadow (truco de OpenCode) para el scrubber:** repo git paralelo en un directorio aparte que opera con `--git-dir shadow --work-tree real`, sin tocar el `.git` del usuario. Clave para que sea barato: `objects/info/alternates` apuntando al object store del repo real → reusa los blobs ya hasheados (en repos enormes, capturar pasa de minutos a instantáneo). Respeta `.gitignore` del usuario y excluye archivos grandes.
- **Revert selectivo por archivo** (patrón OpenCode): para volver atrás, por cada archivo se restaura el snapshot MÁS ANTIGUO posterior al punto de corte. No es un reset global — es "deja cada archivo como estaba justo antes del primer cambio después de aquí".

### Disparar agentes: `@agente` separa plática de orden

**Regla central:** el chat es para HUMANOS. El agente solo despierta si lo llamas.

| Lo que escribes | Qué pasa |
|---|---|
| Texto normal | **Plática.** Nadie despierta. |
| `@agente <tarea>` | **Nace un agente nuevo** (límite 3 por sala) |
| `@agente-2 <algo>` | **Join** a ese agente (coalescing, no arranca otro loop) |
| Con elemento anclado (aunque no pongas `@`) | **Nace agente** — el click ya implica la orden |

Por qué importa más allá de lo técnico: sin esto, CADA mensaje dispara al agente y **no puedes hablar con tu compa** sin que se ponga a trabajar. Eso mata la plática que es el corazón del producto ("el momento real no fue el output, fue la plática mientras el agente construía"). Y `@` da gratis el direccionamiento cuando hay varios agentes — el patrón de Discord que la gente ya conoce, cero aprendizaje. UX: al escribir `@` mostrar autocompletado con los agentes activos y su tarea. (Claude Code usa el mismo patrón de mención-@ con estado.)

**La clave del coordinador es el `agentId`, NO la sala.** Esto es lo que da paralelo REAL. OpenCode (clave = sesión) y Agent Teams (un líder que delega) son secuenciales por sesión — copiarlos nos encasillaría en su limitación. En Multi **los humanos son los líderes**: no hay agente-jefe que reparta trabajo; tú y tu compa comandan con `@`. Se siente RTS, no "pedirle a un manager".

### Dos relojes distintos: trabajo activo vs espera de lock

Problema: el coordinador despacha por `agentId` (paralelo), pero el CAS usa mutex por ruta (si dos agentes tocan el mismo archivo, uno espera). Si esa espera contara para el timeout de turno, marcaríamos como "atorado" a alguien que solo está EN FILA — y el sistema se vería más roto cuanto más activo esté. Pésima señal.

**Decisión: el timeout de turno mide TRABAJO ACTIVO, no tiempo transcurrido.** El reloj se pausa al entrar a la cola de un lock y se reanuda al obtenerlo. Pero eso dejaría un deadlock invisible, así que la espera tiene su propio reloj con distinto significado:

| Reloj | Mide | Si vence |
|---|---|---|
| **Timeout de turno** | tiempo trabajando (pausado en esperas) | el agente no avanza solo → **atorado** |
| **Timeout de lock** | tiempo esperando un archivo | **el problema es del DUEÑO del lock**, no del que espera → investigar/destrabar al dueño, nunca culpar a la víctima |

Los dos relojes se cubren mutuamente: los locks son de milisegundos por naturaleza (leer-comparar-escribir), así que una espera larga significa que el dueño está atorado — y su propio timeout de turno debería haberlo detectado primero.

**Tres estados visualmente distintos en la sala** (que la gente entienda de un vistazo si preocuparse):
```
🟡 Agente-1  escribiendo Menu.jsx              ← trabajando (normal)
⏳ Agente-3  esperando a Agente-1 (Menu.jsx)   ← EN FILA: normal, color NEUTRO,
                                                  dice a quién espera y por qué archivo
⚠️ Agente-2  atorado: sin respuesta hace 3m    ← requiere atención, color de alerta,
                                                  dice desde cuándo y qué hizo al final
```
"Esperando" NO usa color de alerta — es un estado normal como "cargando"; si lo pintas de alarma, entrenas a la gente a ignorar las alertas reales. Y decir **a quién** espera convierte una espera opaca en algo comprensible (= "la visibilidad es la coordinación", se entiende el sistema sin explicación).

**Bonus que sale gratis:** si dos agentes hacen fila seguido por el mismo archivo, la sala puede avisar *"Agente-1 y Agente-3 están trabajando sobre el mismo archivo"*. Eso ES coordinación semántica — justo lo que Anthropic admite que Agent Teams no tiene.

### Cómo se REPRESENTA un agente en el preview (decisión)

**Cursores = humanos. Resaltados = agentes.** De un vistazo sabes quién es quién.

Se descartó darle al agente un cursor que se mueva como persona: sería una **mentira bonita** — el agente no navega el DOM, edita archivos. Habría que *inventar* la posición mapeando "editó Menu.jsx" → "el menú está por aquí", y un cursor mal puesto se ve roto. Humanos y agentes trabajan distinto y el diseño debe respetarlo, no disfrazarlo: un humano **señala** (cursor puntual), un agente **transforma** (afecta una zona).

**Decisión: resaltar el elemento afectado** con el color del agente mientras trabaja. Es honesto (no finge un cursor), se siente vivo (ves la zona brillar y cambiar), reutiliza la maquinaria del inspector (ya sabe resaltar por selector), y tolera imprecisión (resaltar una zona aguanta error; un cursor no).

### Ver el código / los diffs (validado contra Lovable)

**El código no es el centro, pero está accesible.** Jerarquía de profundidad:
```
preview (lo que ves)  →  historial de versiones  →  diff del cambio
   siempre visible          panel / scrubber          un click más adentro
```
Lovable hace exactamente esto y funciona con no-técnicos: la unidad NO es el diff, es la **versión**. Cada respuesta del agente genera una tarjeta con botón de revertir ahí mismo; un panel de History lista todas las versiones; clickeas una → **la previsualizas** → y solo entonces "Restore".

Patrones suyos a copiar: (1) **revertir NO borra historia** — crea una entrada nueva y los cambios posteriores siguen disponibles para reaplicar (= nuestro revert como commit nuevo); (2) **preview antes de restaurar** (= arrastrar el scrubber y luego "Regresar aquí"); (3) **bookmarks** — marcar versiones que importan ("la que funcionaba", "antes del login"); lo teníamos como "marcar versión" sin darle peso, Lovable lo hace feature de primera clase, con su propia pestaña.

**Más patrones de su doc oficial:**
- **"Ir al mensaje en el chat"** desde un punto del historial: salta a la conversación que produjo ese cambio (*"útil para recordar POR QUÉ pasó"*). Para nosotros es casi gratis: ya guardamos mensajes con timestamp y commits por turno. Cierra el círculo entre *qué cambió* y *por qué se pidió*.
- **Confirmación antes de revertir**, mostrando la fecha de la versión y con opción de "ver en chat" antes de decidir. Evita accidentes.
- **⚠️ EL REVERT NO TOCA LOS DATOS** (su `<Warning>`): *"revertir restaura solo el CÓDIGO... NO restaura ni revierte los datos de tu base de datos. Si mensajes posteriores agregaron registros o corrieron migraciones, revertir el código no deshace esos cambios."* **Crítico para nuestra Fase 6** (Supabase/back): cuando el agente cree tablas y datos, "regresar aquí" tendrá el mismo límite y hay que AVISARLO explícitamente, o alguien va a regresar el código creyendo que también vuelven sus datos.
- **PENDIENTE — editar un mensaje pasado = "revertir y reenviar"**: en vez de "regresa" + "ahora pide otra cosa" (dos gestos), editas el mensaje que mandaste y el sistema vuelve a ese punto y reintenta con la nueva instrucción. Muy natural en un chat y no lo teníamos. Se retoma después del v1.
- Su límite que superamos: *"¿Puedo revertir solo parte de una versión? **No.** Revert es todo o nada"* — su workaround es pedirle al chat que restaure esa parte. Nosotros tenemos `revertFile`: revert selectivo real.

**Donde los superamos:** su revert es todo-o-nada por versión (restaura el proyecto entero). Nosotros ya diseñamos **revert selectivo por archivo** (patrón OpenCode) → podemos ofrecer "regresa solo este archivo" además de "regresa todo".

Alcance: los diffs viven en la **Fase 5** (scrubber/historial), como el nivel más profundo. El dato ya existe: commit por turno + `filesInCommit` en `git.ts`; falta endpoint y visor.

**PENDIENTE — previsualizar visualmente un estado anterior (la app viva del pasado).**
Lovable SÍ lo tiene: *"clickea cualquier versión para abrirla en una vista de snapshot donde puedes mirar alrededor de ese estado de tu app sin cambiar nada"*, más el diff por separado. Les sale natural porque su infra ya buildea y hostea cada versión.

El problema técnico: el proyecto en disco es CÓDIGO FUENTE (JSX/TS). El dev server lo traduce al vuelo; servir el árbol de un commit como archivos estáticos entrega JSX crudo que el navegador no ejecuta. Tres caminos:
- **A. Build bajo demanda** (recomendado si se retoma): al previsualizar, correr el build de ese commit en la carpeta temporal y servir `dist/`. Fidelidad real, ~3-10s la primera vez y luego cacheado. Necesita reusar `node_modules` del workspace por symlink para no reinstalar por preview.
- **B. Dev server efímero por versión**: más fiel, más pesado, ocupa puerto. Sobre-ingeniería para v1.
- **C. Servir el árbol crudo**: barato pero pobre — solo sirve para ver estructura/contenido, no la app.

**Decisión v1: NO se implementa.** El historial arranca con diff + "regresar aquí", que cubren el uso real (*"¿qué cambió?"* y *"devuélvemelo"*) — y "regresar aquí" sí muestra el estado vivo, porque restaura el working tree y el dev server normal se encarga. La previsualización visual es el lujo intermedio (ver sin comprometerse); se retoma con la opción A si se extraña al usar el producto. Es una feature opcional dentro de una opcional: no toca el preview del presente, ni los agentes, ni los commits.

**Alcance — la 4b se parte en dos:**
- **4b-mínima:** lista de agentes con sus 3 estados + atribución por agente en el chat + autocompletado de `@` + aviso de turnos huérfanos. SIN representación en el preview. Ya se ve el multi-agente funcionando.
- **4b-plus (después):** el resaltado del elemento afectado. Requiere el mapeo archivo→elemento visual, que NO es trivial (saber que `Menu.jsx` es ese `<nav>`). Se construye junto con el mapeo del back visual (Fase 6), no improvisado.

## Fase 6 — El back visual: lo que hay y el issue abierto

**Construido (punto de partida, funcionando):** `engine/api-map.ts` + `web/BackCanvas.tsx` + `GET /rooms/:id/api-map`. Escanea el workspace con regex, cruza lo que el FRONT llama (`fetch`, `axios.*`, `useSWR`) contra lo que el BACK declara (`app.get`, `router.post`, rutas por convención de archivo tipo `app/api/x/route.ts`), y dibuja una card por endpoint con semáforo: **punteado** (el front lo llama, no existe), **verde** (existe y lo usan), **gris** (existe, nadie lo llama). Se actualiza en vivo por `file:changed`. Click en una card redacta el pedido en el chat. Verificado: `npm run demo:back`, 12/12.

**El issue abierto: falta lo que guarda la app (las tablas).** Un endpoint es lenguaje de programador; `GET /api/pedidos` no le dice nada a alguien que no programa. Lo que un compa necesita saber para no chocar es *qué guarda esto*.

**Por qué importa aquí y no en Lovable.** Lovable esconde el back porque es un jugador con un agente: todo el estado vive en su chat. Multi es multijugador — si tu compa hizo que se guardaran pedidos y tú no te enteras, pides algo que choca y acabas pegando dos backends que no se conocen. Ese es el dolor del que nació el producto. La contra legítima: "si quieres saber, pregúntale al agente o al compa en el chat". Cierto, pero uno no pregunta por una tabla que no sospecha que existe — las pantallas no responden preguntas, las provocan.

**Callejones ya recorridos (no repetirlos):**
- **Leer las migraciones** — son un histórico incremental (`create table`, luego `add column`, luego `drop column`). Saber cómo está la tabla HOY exige replayearlas en orden y en el dialecto correcto. Además mucha gente no usa migraciones.
- **Un `schema.sql` que el agente mantenga** — es una copia sincronizada a mano, y las copias se desincronizan. Sería un artefacto que existe solo para que la pantalla se vea bien: el mismo error del mock incrustado (ver `multi-mocks-aparte`).
- **Leer el archivo del ORM** (`schema.prisma`, `models.py`) — no cubre a quien corre queries directos en el dashboard de Supabase. Ese flujo es legítimo, deja la base perfecta y el proyecto sin rastro alguno.

**A dónde habíamos llegado:** todos los caminos anteriores leen *representaciones* del esquema, y una representación puede mentir. La única fuente que no puede mentir sobre sí misma es **la base viva**. Y no hace falta que Multi escriba un cliente por cada motor: **el agente ya tiene las creds del `.env` y una terminal** — puede preguntarle a la base y reportar el resultado, igual que hace el setup del front. La agnosticidad no la da un detector nuestro; ya la tiene el motor (un filesystem real + un agente que instala y corre lo que sea).

**Cuidados si se retoma:** (1) preguntarle a la base cuesta conexión — refrescar al cerrar un turno que tocó datos o bajo demanda, no en cada `file:changed`; (2) si no hay creds o la base está apagada, decirlo ("no me pude conectar"), nunca mostrar vacío que parezca "no hay tablas"; (3) estructura sí, datos no por default — en una sala compartida las filas pueden ser sensibles; (4) si el canvas refleja lo que el agente reporta, un cambio no reportado lo deja viejo en silencio: atarlo al cierre de turno.

**Los tres bloques que tendría el tab completo** (qué guarda / qué responde / qué necesita para vivir): tablas con sus campos; endpoints (ya construido); y variables de entorno **por nombre, nunca por valor** — que exista `STRIPE_KEY` y esté puesta, sin enseñar el secreto. Explicar la lógica de negocio en prosa queda FUERA: eso es interpretación, envejece, y para eso está el chat.

### Cuándo un archivo pasa de "en caliente" a "en el historial"

**Disco = ahora. Commit = memoria.** Un archivo entra al historial cuando el agente TERMINA SU TURNO completo, no cuando se escribe. Un turno puede tocar 5 archivos → 1 solo commit.

```
t=1  escribe App.jsx   → CAS ok → a disco → HMR → TODOS lo ven (aún sin commit)
t=2  escribe Menu.jsx  → CAS ok → a disco → HMR
t=3  corre npm install
t=4  TERMINA el turno  → 1 commit con los 3 cambios → punto en el scrubber
```

Por qué commit por turno y no por archivo: el commit es la unidad de SENTIDO, no de escritura. Por archivo, el scrubber se llena de ruido y —peor— guarda **estados intermedios rotos** (el componente escrito pero su import todavía no). Cada punto del scrubber debe ser un estado coherente y con nombre ("hizo el menú de tacos"), que es lo que tiene sentido restaurar.

**Con varios agentes en paralelo la separación se luce:** el CAS los protege archivo por archivo en tiempo real; los commits salen desfasados, en orden de terminación, cada uno con su nombre. Y como el CAS ya garantizó que nadie sobrescribió a nadie, **el commit del segundo agente no necesita rebase** — el árbol ya es consistente cuando llega a git. El CAS resuelve el conflicto ANTES de que llegue a git; git solo registra historia, no arbitra peleas.

### Turnos huérfanos (el server se cayó a media tarea)

Ventana de riesgo: entre la primera escritura y el commit, el trabajo está en disco y **ya lo vieron todos**, pero no está en el historial.

**Cómo se detecta:** el snapshot no es un objeto suelto — pertenece a un turno, y el turno tiene **estado durable** (en disco/DB, NO solo en memoria; si vive en memoria muere con el proceso y no queda rastro). Ciclo: `running` → `committed` | `failed`. Al arrancar, el server hace un **barrido de recuperación**: los turnos que quedaron en `running` son huérfanos por definición (un proceso que se apaga bien no deja turnos corriendo). Es el mismo patrón que OpenCode usa para tools colgadas (`failInterruptedTools` barre las `pending`/`running` al inicio de cada run).

**Qué hacer con el huérfano — decisión: NO decidir automáticamente.** Se preserva el disco tal cual y la sala pregunta: *"El agente se interrumpió a media tarea. ¿Guardas lo que alcanzó a hacer o vuelves al último punto?"*. Razón: ese trabajo **ya está en disco y ya lo vieron todos en el preview** — descartarlo solo se sentiría como una traición; commitearlo a ciegas metería estados rotos al historial. El humano decide con el botón de "regresar" que ya existe. Encaja con "humanos en los bordes, lo irreversible es suyo".

**Ciclo de vida del snapshot:** durante el turno son red de seguridad, no historial. Turno commiteado → sus snapshots intermedios son descartables (evita acumulación infinita). Turno huérfano → sus snapshots son lo único que queda del trabajo, se preservan hasta que el humano decida.
- **Conflictos que escalan a humano = solo los de INTENCIÓN** ("¿botón azul o verde?"), no los de archivo. Los de archivo los resuelve el modelo con el mensaje del CAS. El paper mandaba todo a resolución manual porque asumía humanos tecleando.

### Working tree — decisión v1 (sin cambios)

**Mismo working tree compartido.** Ya NO se serializan todas las escrituras por una cola global (eso era el diseño viejo): el CAS por archivo + mutex por ruta da paralelismo real con seguridad. Un solo tree, un solo dev server, un solo preview.

**Evolución futura (NO v1):** worktrees aislados por agente. Nota: OpenCode los tiene implementados (`worktree/index.ts`) pero como aislamiento OPCIONAL y manual, no como el modo por defecto de sus agentes — coincide con nuestra decisión.

### Lecciones de OpenCode sobre lo que NO tiene (= nuestro hueco)

- **No tiene coordinación semántica entre agentes** sobre el mismo workspace: su "coordinación" para subagentes es prompt engineering (*"DO NOT duplicate this task's work — avoid working with the same files"*). Literalmente les piden por favor que no se pisen. **Ese es el hueco que Multi llena.**
- **No tiene colaboración de varios humanos** sobre una sesión (su stream es broadcast read-only, el steering no tiene identidad de autor).
- **No recupera la ejecución tras un crash** (el historial sobrevive, el turno en curso no). Para Multi: el estado del proyecto vive en git (sobrevive), y los agentes son reactivos (el humano re-dispara si hace falta).

### Lo que NO tomamos del paper

Clientes como clones, pull/rebase/push distribuido, offline. El servidor es autoritativo y punto — más simple, y el paper mismo lo avala cuando no necesitas descentralización. Para 2-4 personas en una sala, servidor autoritativo basta.

### Manual vivo — mecánica (circuito cerrado)

Marco: sensores → política → herramientas → aprendizaje (bucle recursivo). Sin la capa de aprendizaje solo hay automatización; con ella, la sala se vuelve más inteligente con el uso.

- **Destilar en LOTE, no en tiempo real.** El estado (preview, canvas, chat) es tiempo real; la destilación de patrones es batch — corre en momentos de cierre (feature terminada, versión marcada). Destilar cada evento = ruido; en lote = patrones.
- **Sensores:** correcciones de humanos en el chat, previews rotos, cambios revertidos, decisiones tomadas.
- **Clasificación del destilador:** nuevo → al manual · redundante → se ignora · **contradice → NUNCA se auto-escribe: dispara el modal de conflicto** (contradicción de manual = decisión humana de producto → votan → Decisiones). Umbral: ≥2 ocurrencias antes de volverse patrón.
- **Consumo:** los agentes leen el manual antes de cada tarea. Efecto: "le dijimos una vez que usara rem y nunca más usó px" — el proyecto se vuelve más consistente con el tiempo, no menos.
- **Alcance:** cada sala tiene SU manual, privado, como archivo en el repo mantenido por el motor. Sin Mem0 ni infra dedicada en v1. Sin agregación entre salas (posible moat futuro, fuera de diseño actual — el moat definido es el motor).
- **IA al centro, humanos en los bordes:** agentes ejecutan lo repetitivo; humanos deciden producto y lo irreversible (borrar tabla, deploy, pagos).

## Arquitectura del motor — referencia técnica (de "Realtime GitHub", GitHub Next 2023)

Blueprint validado por el equipo que hoy construye Ace. Aplica al motor invisible de v1 (cuando hay múltiples agentes escribiendo en paralelo). Nota de arranque: las primeras iteraciones pueden serializar + broadcastear simple antes de meter el sync por git completo.

- **No CRDTs.** Sus fortalezas (descentralización, muchos colaboradores) no aplican a salas de 2-4 personas. Servidor autoritativo.
- **Git como protocolo de sync, no solo historial:** cliente = clone; cambio se aplica local optimista → se manda al server con hash base → hash coincide: aplica y notifica; no coincide: pull, rebase, retry. Los árboles git son hash trees persistentes: clientes cachean por hash, bajan solo lo que cambió, cargan lazy solo lo que ven.
- **Ventaja propia:** nuestra infraestructura invisible YA es git abajo → el sync en tiempo real y el scrubber de versiones son EL MISMO mecanismo. Un solo sustrato.
- **Merge por tipo de dato, dos granularidades:** fino = transacciones rebaseadas en vivo; grueso = merge semántico 3-way sobre estructura (no líneas), conflictos como nodos especiales visibles en UI para resolución manual (= nuestra pieza roja en canvas + modal).
- **Herramientas externas (agentes) como participantes** vía exposición del branch como filesystem — su diseño ya contempla AI assistants como colaboradores.
- Posicionamiento: Realtime GitHub/Ace exponen git al usuario ("meet me in this branch") y construyen desde el editor hacia arriba, para devs. Nosotros escondemos git y construimos desde la app viva (preview + agente) hacia abajo, para no-devs. Extremos opuestos del mismo túnel.

**Filtro 2023→2026 (qué envejeció del paper y qué no):**
- **Vigente (física, no IA):** hash trees, sync por hash, servidor autoritativo, lazy fetch, merge por tipo de dato. No depende de qué tan capaz sea el modelo.
- **Envejecido (suposición de quién escribe):** su modelo asume muchos humanos tecleando; hoy escriben agentes en bursts de cientos de líneas → menos merge fino de teclazos, más merge grueso/semántico.
- **Conflictos:** su diseño escala todo a resolución manual; hoy el agente reconcilia solo y escala únicamente decisiones de producto. Los modelos actuales hacen viable este diseño (con GPT-4 no se podía — por eso 2023 dio un editor de docs, no una sala de agentes).
- **Opción nueva 2026 — merge de intenciones:** cuando el merge estructural se pone feo, es más barato regenerar el archivo cumpliendo las DOS intenciones que mergear texto. El motor elige entre merge determinista y re-generación.
- **Simplificación clave propia:** aquí los humanos NO editan código — solo agentes escriben, pocos y serializables. El problema difícil del paper (concurrencia humana masiva sobre archivos) es ~cero; el nuestro es reconciliar intenciones de agentes: inteligencia, no protocolo.

## Modo solo = multijugador con agentes (caso de uso clave)

Entrar solo NO es estar solo: la sala nunca está vacía — el agente está presente con cursor y avatar, trabajando en vivo frente a ti. Mientras un agente trabaja, el usuario sigue seleccionando y hablando, y cada nueva instrucción sobre otra cosa puede disparar OTRO agente en paralelo — el equipo de agentes se forma jugando, sin panel de configuración ni orquestador visible (el chat crea, el click señala).

Implicaciones:
- **Mata el arranque en frío** de todo producto multiplayer: valor completo desde el día 1 en solitario; invitar compas es upgrade natural, no requisito. (Figma solo servía si tu equipo llegaba; aquí no.)
- **Mata el tiempo muerto** del AI single-player (promptear y ver el spinner): aquí diriges — mientras uno construye, tú ya estás disparando lo siguiente. Se siente RTS (comandar unidades), no chat.
- **Cero UI nueva:** la presencia (cursores, avatares, selecciones) ya trata a los agentes como jugadores; N agentes = N cursores. El sistema no cambia, solo cambia quién llena los asientos.
- Camino de adopción: solo → equipo de agentes → invitas al compa → misma sala, un jugador más.
- **Validación de la brecha (dato real):** el fundador, power user de Claude Code, no sabía que CC ya puede lanzar multi-agentes (se pide en lenguaje natural y corren en background). La capacidad existe en los labs pero está enterrada: invisible, sin presencia, sin feedback en vivo, contexto por texto. El moat no es "multi-agentes" — es que aquí la capacidad se descubre jugando (seleccionas otra cosa, hablas, aparece otro cursor), no leyendo docs. Si un power user no la encuentra en CC, el usuario de Lovable jamás la encontrará.

## Evidencia de demanda — el assignment

Evidencia actual: dolor propio (N=1, historia real del proyecto Lovable+Claude Code) + ensayo de YC como señal de mercado (tesis de inversor, no demanda).

**Assignment:** cuando el v1 corra, invitar al compa de Lovable — el del proyecto que murió — y construir algo chico juntos adentro. Su reacción a los 5 minutos es la primera evidencia real. "No mames, sigamos usándolo" = producto. Aburrido a los 10 min = aprendizaje barato.

**Objeción "¿la gente pagaría?" — ya respondida por el mercado (y por el fundador):** el fundador, estudiante, quemó $100 USD de Claude Code en UN día construyendo, sin dudarlo. El hábito de pagar por IA para construir ya es masivo y probado (Cursor factura cientos de millones, Lovable cobra suscripción). La disposición a pagar NO es el riesgo. Además el multiplayer históricamente SUBE el precio, no lo baja (Figma cobra por asiento, Notion por equipo) → "paga por la versión colaborativa" es más fácil que "paga por IA". Matiz honesto: esto valida "pagan por construir con IA" (sólido), NO todavía "pagan por la versión multijugador/social específica" — ese es el salto de fe que valida el assignment de arriba. Ángulo de negocio extra: dos amigos en UNA sala comparten/coordinan el costo de tokens mejor que cada quien quemando su suscripción aislada.

## Idea v2 — Capa social de descubrimiento (growth loop)

Aclaración: el producto YA es social en v1 (compartes link, entran, construyen juntos en vivo = colaboración estilo Google Docs, sin fricción de "solicitudes"). El link-y-entra se queda como el modo principal. Lo de v2 NO es "hacerlo social" — es agregar **descubrimiento y comunidad** encima.

Idea (inspiración: la capa social de una red, pero sin la fricción de solicitudes formales):
- **Feed de tu círculo:** ves las salas públicas de tus amigos — "Erick construyó [taquería-app], 2 amigos adentro", "el Compa está EN VIVO en [juego] ahora".
- **Presencia social en tiempo real:** como el producto es en vivo, el feed muestra quién está construyendo AHORITA, no posts muertos. Es Discord (ver quién está en línea) + Strava (actividad de tu gente) para vibe-coders. Nadie lo tiene.
- **Unirse:** pedir entrar a una sala pública / abierta → el dueño acepta → entras como jugador.

Por qué importa: es el **growth loop**. v1 crece sumando (cada quien invita a su compa por link); el feed social crece multiplicando (entras, ves 3 amigos construyendo, te unes, invitas a otro — la red se teje sola). Es el efecto de red que Figma/Discord tienen y Lovable no. Además baja la barrera del lienzo en blanco (entrar a una sala con algo pasando invita a jugar).

Reglas / peligros:
- **NO construir antes de validar el core.** Feed + círculos ANTES de que 2 compas amen construir juntos = techo sin paredes. Primero el core en vivo engancha, LUEGO el descubrimiento.
- **Privado por default, público si el usuario elige.** El feed muestra SOLO lo que la gente hizo público. Forzar visibilidad asusta y expulsa (error clásico de privacidad).
- Nivel: alto potencial (motor de crecimiento), cero urgencia (no bloquea v1).

## Contexto estratégico (dónde vive el proyecto)

- **Multi = side-project, código abierto.** No es la apuesta principal de tiempo del fundador ahora — es una apuesta asimétrica de bajo riesgo (no arriesga el sustento) y upside enorme (mercado masivo si pega).
- **Wienops = el negocio principal AHORA** — agencia de IA nativa modelo Palantir, ya con un cliente pagando, aprendiendo manufactura desde adentro. Da runway y evita depender de que Multi explote.
- **Se retroalimentan:** meterse a manufactureras revela procesos que gritan "necesita herramienta"; Multi (construir apps rápido en equipo) puede ser el arma para construir las automatizaciones de Wienops más rápido.
- **Umbral de salto (por definir con un número, no un sentimiento):** "si Multi llega a X usuarios activos / salas / gente desconocida usándolo → salto a tiempo completo". Sin umbral claro, el riesgo es que la agencia (dinero YA) se coma al producto (dinero DESPUÉS) y la ventana se cierre.
- **Nota OSS:** open source da distribución y credibilidad gratis para un side-project, pero ≠ negocio automático; si algún día se salta a Multi de lleno, necesitará un modelo (hosting / versión pro). Para ahora, perfecto.

## Modelo de negocio — open-core → SaaS de hosting (referencia: PostHog)

Jugada: código abierto → comunidad gigante → cobrar por hosting gestionado → SaaS con usuarios reales desde el día 1. Es el playbook estándar de dev-tools 2026 (Vercel/Next.js, Supabase, GitLab, Sentry, PostHog).

**Referencia PostHog (YC W20, open source, hoy vale ~$1B):**
- **~70% de sus ingresos = PostHog Cloud (hosting gestionado).** El hosting ES la columna vertebral del negocio, no un extra.
- El resto: enterprise self-hosted (compliance) + marketplace de add-ons.
- Su frase-regla: "ganamos dinero de los que lo tienen y les gustan nuestros productos, NO de los que no lo tienen" (estudiante/proyecto chico = gratis; empresa que factura = paga).
- Por qué pagan el hosting aunque sea open source: self-hostear PostHog cuesta $5–15k/mes en infra+DevOps vs $300–2.5k/mes el cloud; solo vale self-hostear a escala enorme con equipo dedicado. **El open source es real y completo, pero operarlo bien es tan caro/molesto que casi todos pagan el hosting.** Ese es el truco maestro — no mutilar el producto, sino quitarle a la gente el dolor de operarlo.
- Lección de producto: MVP lean, expandir SOLO siguiendo jalón real de usuarios; tratar usuarios como co-creadores (los vuelve advocates). = valida nuestra secuencia.

**Regla de oro (qué guardar para el pago):** lo de pago debe ser **operacional / escala / equipo / social**, NUNCA la funcionalidad core. El core (construir juntos en vivo) es completo y gratis; se cobra por operarlo sin dolor y a escala. Si guardas el core detrás del muro, la comunidad siente un demo mutilado, se enoja, hace un fork gratis, y matas tu distribución.

| GRATIS (open source, core completo) | PAGO (hosting) |
|---|---|
| La sala multijugador, agentes, motor | **Hosting gestionado** (cero setup, cero servidores) |
| Preview en vivo, cursores, chat | **Escala** (muchas salas/agentes sin caídas) |
| Construir con 1-2 compas | **Equipos grandes** (más de X por sala) |
| Self-hostearlo tú mismo | **Persistencia/backups gestionados** |
| | **Capa social/descubrimiento (v2)** — valor añadido, no mutila el core |
| | **Modelos premium / más tokens incluidos** · **salas privadas / permisos** |

**Encaje perfecto para Multi:** correr un contenedor aislado por sala + agentes + quemar tokens de IA a escala es un infierno técnico y un costo real por usuario. "Yo pongo la infra + absorbo el costo de tokens, tú solo úsalo" es un valor obvio y honesto — idéntico a Supabase. NUNCA guardar detrás del muro la esencia (ej. "el tercer amigo" o "multiplayer de más de 2" mataría la magia); sí guardar escala/equipos/enterprise.

**Secuencia obligatoria (el orden manda):** (1) producto que engancha —validar que 2 compas lo amen— ANTES de abrir; (2) open source → comunidad crece; (3) % pequeño (1–5%) paga hosting; (4) SaaS con usuarios reales. Open source sobre un producto que nadie ama = comunidad de cero. Esto refina el umbral de salto Wienops→Multi: la señal no es solo "usuarios", es "comunidad creciendo Y gente pagando hosting".

## Riesgos abiertos

- **Ace (GitHub Next)** resuelve el MISMO problema técnico (multijugador + agentes + código en vivo) pero NO es competidor directo: va por equipos de ingeniería enterprise dentro de GitHub; Multi va por el duo vibe-coder casual. Mismo mecanismo, mercados opuestos — no pelean por el mismo cliente ni el mismo dinero. Que Ace exista VALIDA el espacio (GitHub apuesta recursos a la tesis) y marca el hueco por contraste (mientras suben a enterprise, dejan el casual/social libre). Riesgo real (bajo): que GitHub decida BAJAR al segmento casual — improbable, va contra su ADN/precios/cultura enterprise. Aun así, ganar el segmento vibe-coder rápido.
- Adopción requiere que el proyecto NAZCA adentro (no hay import de proyectos divergidos en v1).
- El motor (serialización + shapes + preview siempre vivo) es la apuesta técnica; si el preview muere seguido, se acaba el "videojuego".

## Estado de la UI (construido, pre-código del motor)

Ver `soul.md` (alma/mood) y las carpetas del repo:
- **Nombre:** "MULTI" es placeholder. NO reusar "multi.app" (startup de colaboración multiplayer que OpenAI compró y cerró en 2024).
- **Dirección visual:** cartel/revista editorial exclusiva (moodboard `insp2` tipo "SILHOUETTE") — serif gigante, grano, composición de póster. Paleta crepúsculo del Gengar bajo la lluvia (`insp3`): indigo #383b5e, navy #2e3150, lavanda #b9a8e3, ámbar #ffc37a, rojo #d95d63, rosa #c393c9. La estética exclusiva ES marketing (se screenshotea y comparte; los AI tools se ven genéricos, este no).
- **Reglas de diseño:** cero emojis, bordes/espaciado limpios, iterar componentes sueltos.
- **Landing:** `landing/hero.html` (crepúsculo oscuro, elegido sobre `hero-v2-celestial.html`). Imagen hero = "La Creación de Adán" reimaginada (escultura mármol con hoodie + fantasmita lavanda tocándose los dedos), recorte en `landing/assets-src/adan-cutout.png`. El fantasmita puede volverse mascota/logo. Pendiente: migrar el landing a Astro.
- **La Sala:** `app/sala.html` — chat izquierda estilo Discord (mensajes planos agrupados, no burbujas; una sola línea vertical sin cruces), escenario central con tabs (I La app / II El back), cursores en vivo + selección compartida + notas ancladas, scrubber "Historial" abajo.
- **Pipeline de imágenes:** el usuario genera PNGs (Gemini/Midjourney) con prompts que escribe el asistente; recorte de fondo con rembg (venv en scratchpad, `rembg i -m isnet-general-use`).
