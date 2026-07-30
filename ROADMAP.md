# Lo que falta

Cada punto trae el contexto de por qué no está hecho y qué se descartó en el camino. Si vas a tomar alguno, eso te ahorra recorrer callejones ya recorridos.

---

## El back visual completo

**Lo que hay:** un mapa de endpoints. Escanea el workspace y cruza lo que el front llama (`fetch`, `axios.*`, `useSWR`) contra lo que el back declara (`app.get`, `router.post`, rutas por convención de archivo). Card por endpoint con semáforo: punteado (el front lo llama, no existe), verde (existe y lo usan), gris (existe, nadie lo llama). Se actualiza en vivo. Ver `engine/api-map.ts` y `web/BackCanvas.tsx`.

**Lo que falta:** lo que la app *guarda* — las tablas. Un endpoint es lenguaje de programador; `GET /api/pedidos` no le dice nada a alguien que no programa. Lo que un compa necesita saber para no chocar contigo es *qué guarda esto*.

**Por qué importa en multijugador:** si tu socio hizo que se guardaran pedidos y tú no te enteras, pides algo que choca y acabas pegando dos backends que no se conocen. Es el problema del que nació el proyecto.

**Callejones ya recorridos:**

- **Leer las migraciones.** Son un histórico incremental (`create table`, luego `add column`, luego `drop column`). Saber cómo está la tabla hoy exige replayearlas en orden y en el dialecto correcto. Y mucha gente no usa migraciones.
- **Un `schema.sql` que el agente mantenga.** Es una copia sincronizada a mano, y las copias se desincronizan. Sería un artefacto que existe solo para que la pantalla se vea bien.
- **Leer el archivo del ORM** (`schema.prisma`, `models.py`). No cubre a quien corre queries directos en el dashboard de su proveedor. Ese flujo es legítimo, deja la base perfecta y el proyecto sin rastro alguno.

**A dónde llegó el razonamiento:** todos los caminos anteriores leen *representaciones* del esquema, y una representación puede mentir. La única fuente que no puede mentir sobre sí misma es la base viva. Y no hace falta escribir un cliente por cada motor: el agente ya tiene las credenciales del `.env` y una terminal — puede preguntarle a la base y reportar el resultado.

**Cuidados si lo tomas:** preguntarle a la base cuesta una conexión, así que hay que refrescar al cerrar un turno que tocó datos o bajo demanda, no en cada `file:changed`. Si no hay credenciales o la base está apagada, decirlo ("no me pude conectar"), nunca mostrar vacío que parezca "no hay tablas". Estructura sí, datos no por default: en una sala compartida las filas pueden ser sensibles.

---

## Migrar el runtime a Bun

**El motivo concreto:** arrancar el server tarda unos 5 minutos en WSL sobre `/mnt/c`. La mayor parte es Node leyendo miles de archivos de `node_modules` a través de la capa de traducción de Windows. Medido en la misma máquina y la misma carpeta: importar Fastify tarda **~55s en Node contra 6.2s en Bun**.

**El bloqueador:** `node:sqlite` no existe en Bun (`No such built-in module`). Es la API que usa la persistencia. Bun tiene la suya (`bun:sqlite`), con otra forma.

**Por qué el bloqueador es pequeño:** el acceso a datos ya vive detrás de la interfaz `Storage` (`server/src/storage/types.ts`), precisamente para poder cambiar de motor. Sería escribir un `storage/bun-sqlite.ts` hermano del actual y elegir uno al arrancar según el runtime. Nada más del sistema lo toca. El resto de las APIs que usamos (`child_process`, `fs`, `http`, `net`, `path`, `stream`, `util`) sí están cubiertas.

**Lo que se gana además de la velocidad:** ejecutables de un solo archivo. La puerta de entrada pasaría de *"clona, instala Node 22, npm install"* a *"descarga esto y córrelo"*.

---

## El cursor del agente sobre el preview

Hoy los humanos tienen cursor en vivo sobre el escenario y el agente no. La razón no es estética: un humano tiene cursor porque mueve el mouse — hay coordenadas que transmitir. El agente no tiene mouse.

Para dibujar su posición habría que saber que *"está editando `Pedidos.tsx`"* corresponde a *ese bloque* de la pantalla. Entre el archivo y los pixeles hay un compilador que borra ese rastro.

**Camino posible:** los plugins de build de algunos frameworks marcan cada elemento con su origen (`data-source`). Si el elemento del DOM sabe de qué archivo salió, el inspector puede resaltar lo que el agente está tocando. La contra es que depende del framework, así que tendría que degradar limpio: si hay marca de origen se resalta, si no se cae al aviso de texto que ya existe.

**Versión intermedia, más barata:** cuando alguien ancla un mensaje a un elemento, el selector ya viajó por el socket. Ahí sí se sabe qué elemento es, sin resolver el mapeo general.

---

## Previsualizar un estado anterior

El historial permite ver el diff de un punto y volver a él, pero no *mirar* cómo se veía la app en ese momento sin comprometerse.

El problema: el proyecto en disco es código fuente. El dev server lo traduce al vuelo; servir el árbol de un commit como archivos estáticos entrega JSX crudo que el navegador no ejecuta.

**Camino recomendado:** build bajo demanda. Al previsualizar, correr el build de ese commit en una carpeta temporal y servir el resultado. Fidelidad real, unos segundos la primera vez y luego cacheado. Necesita reusar el `node_modules` del workspace por symlink para no reinstalar en cada preview. `engine/git.ts` ya tiene `extractTo` para sacar el árbol de un commit sin tocar el working tree.

---

## Editar un mensaje pasado

Hoy corregir el rumbo son dos gestos: volver a un punto del historial y después pedir otra cosa. Sería más natural editar el mensaje que mandaste y que el sistema vuelva a ese punto y reintente con la instrucción nueva.

El dato ya existe: los mensajes se persisten con su turno, y cada turno tiene su commit.

---

## Hosting

Multi corre local hoy. Para hospedarlo de verdad faltan:

- **Apagar salas inactivas.** Cada sala levanta un contenedor y un dev server; sin apagado automático se paga RAM de gente que ya se fue.
- **HTTPS con dominio propio.** El túnel sirve para una sesión, no para algo permanente.
- **Sin credencial de respaldo.** En un servicio abierto, la key del `.env` la gastarían desconocidos. Cada quien la suya, sin excepción.
- **Y una decisión de confianza:** quien hospeda tiene, en memoria de su proceso, las keys de quienes entran a sus salas (ver [E2E.md](E2E.md)). En tu máquina con tu equipo es intrascendente; en un servicio público abierto a desconocidos, no. Es la razón por la que un hosting de paga acabaría poniendo su propia key y cobrando el uso.

---

## Auto-verificación del agente

El agente escribe y dice "listo". No siempre comprueba que no rompió el preview.

Importa más aquí que en un agente de un solo usuario: si rompe el preview, varias personas ven la pantalla en blanco al mismo tiempo. La tool de `bash` ya puede correr el build o el linter — falta que el prompt lo pida antes de cerrar el turno, y que el agente lea los logs del dev server.

En la práctica los modelos actuales ya lo hacen bastante seguido por su cuenta ("compila sin errores"), así que el trabajo es hacerlo confiable, no inventarlo.

---

## Subir archivos e imágenes

No se puede arrastrar una imagen a la sala para que el agente la use. Es una carencia obvia en cuanto alguien quiere construir algo con contenido real.
