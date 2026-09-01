# Migrar las salas a Modal

Estado: investigado, sin escribir codigo. Fecha: 30 de agosto de 2026.

## Por que

Multi no escala porque cada sala mantiene vivo un servidor de desarrollo
(un proceso de Node con el proyecto cargado en memoria) y **nadie lo apaga**.
Con 31 salas guardadas, las que despiertan se quedan corriendo aunque no haya
nadie mirando.

El VPS actual (KVM 2: 2 vCPU, 8 GB) con los limites por defecto de 2 CPU y 2 GB
por sala da para **una sala a la vez**. Con 0.5 CPU y 768 MB daria cuatro. El
experimento del capitulo necesita hasta 20 salas simultaneas en la condicion
individual.

## Como lo resuelven los demas

- **Bolt**: no tiene el problema. WebContainers corre Node dentro del navegador
  del usuario, asi que el preview no cuesta infraestructura. No aplica a Multi:
  el preview es compartido entre varias personas.
- **Replit**: duerme los contenedores a los 5 minutos de inactividad, con
  arranque en frio de 10 a 30 segundos al volver.
- **Lovable**: usa Modal Sandboxes. Un sandbox por sesion de generacion. En un
  fin de semana corrieron mas de un millon de sandboxes, con 20 mil concurrentes
  en el pico. Al migrar a Modal pasaron de 15 mil lineas de orquestacion a 700.

## Lo que Modal resuelve

Verificado en su documentacion, y **todo existe en el SDK de JavaScript**:

- `sandboxes.create(app, image, opts)` con `timeoutMs`, volumenes, secretos
- `sb.exec([...])` para comandos, con stdout en streaming
- `sb.filesystem`: `readText`, `writeText`, `listFiles`, `stat`,
  `makeDirectory`, `remove`, `copyFromLocal`, `copyToLocal`
- `encryptedPorts` + `sb.tunnels()` para exponer el dev server por HTTPS
- `sb.createConnectToken()` para HTTP/WebSocket autenticado hacia el sandbox
- **`idleTimeout`**: el sandbox muere solo tras inactividad, y una conexion TCP
  abierta en un tunel cuenta como actividad. Mientras alguien mire el preview,
  la sala vive; cuando todos se van, se apaga sola.
- Named Sandboxes: un nombre unico por app, solo uno corriendo a la vez. Es lo
  mismo que hoy hace el mutex de arranques con `multi-room-<id>`.
- `sandboxes.fromId()` / `fromName()`: la sala sobrevive a un reinicio del server
- Aislamiento con gVisor, mas fuerte que Docker normal

Precio: por segundo de uso, ~0.0000394 USD por nucleo-segundo. **Un sandbox
apagado no cuesta**, que es lo contrario de hoy, donde 31 salas dormidas cuestan
lo mismo que 31 activas.

Solo Python: definir Modal Functions. No hace falta para esto.

## Que cambia en el motor

`Runner` (`engine/runner.ts`) ya es la abstraccion correcta: una interfaz con dos
implementaciones (`containerRunner` y `localRunner`) y quien la usa no sabe cual
le toco. **Agregar `modalRunner(roomId)` es un tercer brazo con la misma forma.**

Lo que no tiene abstraccion todavia y hay que resolver:

1. **Archivos.** `agent/tools/fs.ts`, `engine/file-mutation.ts` y `engine/git.ts`
   leen y escriben disco local directo. Con Modal el proyecto vive alla.
2. **El CAS.** El `read-compare-write` de `writeIfUnchanged` es atomico porque
   pasa en el mismo proceso. Con `sb.filesystem` son llamadas de red: el mutex
   sigue sirviendo (vive en nuestro server), pero cada operacion cuesta un viaje.
3. **Git.** Hoy corre en el disco del host. Con Modal, o corre dentro del sandbox
   por `exec`, o se mantiene una copia local sincronizada. Hay que elegir.
4. **El preview.** `engine/preview.ts` y `engine/proxy.ts` asumen
   `localhost:PUERTO`. Con Modal es una URL de tunel remota.

## Plan

**Paso 1 — prueba de concepto, sin tocar el motor.** Un script suelto que:
- cree un sandbox y cronometre cuanto tarda
- corra `npm create vite` adentro y levante el dev server
- abra el tunel y verifique que carga en el navegador
- **mida la latencia** de `readText`, `writeText` y `exec`

Esos numeros deciden si el CAS es viable: si cada lectura son 200 ms, un turno
que lee diez archivos se vuelve lento.

Requiere: cuenta en modal.com y token (`modal token new`).

**Paso 2 — solo si los numeros salen bien.** Rama nueva, `modalRunner` como
tercer brazo, y despues los archivos y el preview.

## Lo que NO hay que hacer

**No migrar antes del experimento.** Esto toca las tres partes mas delicadas del
motor (archivos, ejecucion y preview) y el experimento tiene fecha y grupos
prestados. Si falla ese dia, se pierde el experimento.

Camino seguro para llegar a las pruebas: dormir salas + limites de 0.5 CPU y
768 MB + KVM 4 el mes del experimento + dos sesiones de 10 personas en vez de
una de 20.
