import type { Room } from "../rooms.js";

/**
 * El tope de salas trabajando a la vez, y la fila para las que no caben.
 *
 * El VPS aguanta unas 20 salas activas antes de quedarse sin RAM, y sin tope
 * la sala 21 no espera: tumba el server para todos, incluidas las 20 que iban
 * bien. Con esto la 21 se forma y arranca sola cuando hay lugar.
 *
 * Lo que cuenta es lo que pesa: una vista previa corriendo o arrancando (el dev
 * server, ~150 MB) o un agente trabajando (instala, compila). Una sala dormida
 * deja su contenedor vivo (~50 MB, ver `dormirSala`) y no ocupa lugar.
 *
 * Tres reglas que no se rompen:
 * - A una sala que ya ocupa lugar nunca se le hace esperar, ni a su vista
 *   previa ni a sus turnos: el tope solo frena lo que todavía no empezó.
 * - Para hacer lugar solo se duermen salas sin nadie, sin agente, sin instalar
 *   ni publicar. Las mismas que `dormirSalasOciosas` dormiría de todos modos a
 *   los 30 minutos; aquí solo se adelanta.
 * - El chat no pasa por aquí. Una sala formada sigue platicando.
 *
 * Se cuenta en vivo sobre las salas en vez de llevar un contador: un contador
 * suelto se desfasa con el primer camino que se olvide de bajarlo, y entonces
 * el tope se va cerrando solo hasta que nadie cabe.
 */

/** Lo que el módulo necesita de afuera. Lo pone rooms.ts; las demos, el suyo. */
interface Entorno {
  salas: () => Room[];
  dormir: (room: Room) => Promise<void>;
  /** Una sala formada para su vista previa ya tiene lugar: que la levanten. */
  alHaberLugar?: (room: Room) => void;
}

let entorno: Entorno | null = null;

export function configurarCupo(e: Entorno): void {
  entorno = e;
}

/** El hook de "ya hay lugar para tu vista previa". Lo registra index.ts. */
export function alHaberLugar(fn: (room: Room) => void): void {
  if (entorno) entorno.alHaberLugar = fn;
}

/**
 * El tope, leído en cada llamada para que una demo pueda cambiarlo.
 * 0 (o un valor que no sea número) apaga el tope: Multti se comporta como antes.
 */
export function maxSalasActivas(): number {
  const crudo = process.env.MULTI_MAX_SALAS_ACTIVAS;
  if (crudo === undefined || crudo.trim() === "") return 20;
  const n = Number(crudo);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Cuánto dura un lugar apartado. Al admitir a una sala de la fila se le aparta
 * el lugar mientras arranca; si por lo que sea no llega a arrancar (el proyecto
 * desapareció, el turno se canceló), el lugar vuelve solo en vez de perderse.
 */
const RESERVA_MS = 60_000;

/** Si esta sala está ocupando uno de los lugares. */
export function ocupaLugar(r: Room): boolean {
  return (
    r.preview != null ||
    r.previewBooting === true ||
    (r.turnosEnCurso ?? 0) > 0 ||
    (r.reservaHasta !== undefined && r.reservaHasta > Date.now())
  );
}

/**
 * Si se puede dormir YA sin que nadie lo note. Es el criterio de
 * `dormirSalasOciosas` sin la espera de 30 minutos.
 */
export function sePuedeDormirYa(r: Room): boolean {
  return (
    r.preview != null &&
    r.members.size === 0 &&
    r.coordinator.activeKeys().length === 0 &&
    !r.previewBooting &&
    !r.publicando &&
    (r.turnosEnCurso ?? 0) === 0
  );
}

function salasActivas(menos?: Room): number {
  if (!entorno) return 0;
  return entorno.salas().filter((r) => r !== menos && ocupaLugar(r)).length;
}

/**
 * Si esta sala puede trabajar AHORA. Síncrono a propósito: quien llama marca la
 * sala como ocupada (`previewBooting`, `turnosEnCurso`) inmediatamente después,
 * sin un `await` en medio, y así dos salas no se quedan con el mismo lugar.
 */
export function hayLugarPara(room: Room): boolean {
  const max = maxSalasActivas();
  if (max === 0 || !entorno) return true;
  if (ocupaLugar(room)) return true;
  return salasActivas(room) < max;
}

/**
 * Duerme salas vacías hasta que haya un lugar libre. Devuelve si lo hubo.
 * Las que llevan más tiempo vacías van primero.
 */
export async function hacerLugar(): Promise<boolean> {
  const max = maxSalasActivas();
  if (max === 0 || !entorno) return true;
  const sobran = salasActivas() - max + 1;
  if (sobran <= 0) return true;
  const candidatas = entorno
    .salas()
    .filter(sePuedeDormirYa)
    .sort((a, b) => (a.vaciaDesde ?? 0) - (b.vaciaDesde ?? 0))
    .slice(0, sobran);
  for (const r of candidatas) {
    try {
      await entorno.dormir(r);
      console.log(`[tope] sala ${r.id} dormida antes de tiempo para hacer lugar`);
    } catch (err) {
      console.error(`[tope] no se pudo dormir la sala ${r.id}:`, err);
    }
  }
  return salasActivas() < max;
}

// ── La fila ──────────────────────────────────────────────────────────────────

interface EnFila {
  room: Room;
  tipo: "preview" | "turno";
  desde: number;
  /** Solo los turnos esperan en una promesa; la vista previa se relanza por hook. */
  entra?: () => void;
  cancela?: (err: unknown) => void;
}

const fila: EnFila[] = [];
let revisor: ReturnType<typeof setInterval> | null = null;
let revisando = false;

/** Cada cuánto se revisa si ya hay lugar mientras alguien espera. */
const CADA_MS = Number(process.env.MULTI_TOPE_REVISION_MS ?? 5000);

/**
 * Qué lugar ocupa la sala en la fila (1 es la siguiente), o 0 si no está.
 */
export function posicionEnFila(roomId: string): number {
  const i = fila.findIndex((e) => e.room.id === roomId);
  return i === -1 ? 0 : i + 1;
}

export function enFila(): number {
  return fila.length;
}

function avisarFormada(room: Room): void {
  console.log(
    `[tope] ${salasActivas()}/${maxSalasActivas()} salas activas: ` +
      `sala ${room.id} en espera (${fila.length} en fila)`,
  );
}

function prenderRevisor(): void {
  if (revisor) return;
  revisor = setInterval(() => void revisar(), CADA_MS);
  // Que el intervalo no mantenga vivo al proceso (ni a las demos) por sí solo.
  revisor.unref?.();
}

/**
 * Forma a la sala para levantar su vista previa. Si ya estaba formada no se
 * repite: entrar, recargar y el `bootPreview` del despertar piden lo mismo.
 * Devuelve su lugar en la fila.
 */
export function formarParaPreview(room: Room): number {
  if (!fila.some((e) => e.room === room && e.tipo === "preview")) {
    fila.push({ room, tipo: "preview", desde: Date.now() });
    avisarFormada(room);
    prenderRevisor();
  }
  return posicionEnFila(room.id);
}

/**
 * Forma a un turno y espera a que tenga lugar. Al resolver, la sala ya tiene el
 * lugar apartado: quien llama solo tiene que subir `turnosEnCurso`.
 *
 * Si el turno se interrumpe mientras espera, sale de la fila y la promesa se
 * rechaza con el motivo, para que el mensaje vuelva a la cola del agente igual
 * que cuando se corta un turno a medias.
 */
export function esperarLugarParaTurno(room: Room, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const entrada: EnFila = { room, tipo: "turno", desde: Date.now() };
    const alAbortar = () => {
      const i = fila.indexOf(entrada);
      if (i !== -1) fila.splice(i, 1);
      reject(signal?.reason ?? new Error("se canceló la espera"));
    };
    if (signal?.aborted) return alAbortar();
    entrada.entra = () => {
      signal?.removeEventListener("abort", alAbortar);
      resolve();
    };
    entrada.cancela = reject;
    signal?.addEventListener("abort", alAbortar, { once: true });
    fila.push(entrada);
    avisarFormada(room);
    prenderRevisor();
  });
}

function admitir(e: EnFila): void {
  const espero = Math.round((Date.now() - e.desde) / 1000);
  console.log(`[tope] sala ${e.room.id} entra (esperó ${espero}s)`);
  if (e.tipo === "turno") e.entra?.();
  else entorno?.alHaberLugar?.(e.room);
}

/**
 * Deja pasar a las de enfrente mientras haya lugar. Exportada para las demos;
 * en el server la corre el intervalo.
 */
export async function revisar(): Promise<void> {
  if (revisando) return;
  revisando = true;
  try {
    while (fila.length > 0) {
      const e = fila[0];
      // Una sala que se quedó sin nadie no necesita su vista previa: se baja de
      // la fila sin gastar el lugar. Se vuelve a pedir cuando alguien entre.
      // Los turnos sí siguen: el agente trabaja aunque la gente se vaya.
      if (e.tipo === "preview" && e.room.members.size === 0) {
        fila.shift();
        console.log(`[tope] sala ${e.room.id} sale de la fila: ya no hay nadie dentro`);
        continue;
      }
      if (!hayLugarPara(e.room)) {
        await hacerLugar();
        if (!hayLugarPara(e.room)) break;
      }
      fila.shift();
      // El lugar se aparta aquí mismo, sin `await` de por medio: la siguiente
      // vuelta del ciclo ya cuenta a esta sala como ocupada.
      if (!ocupaLugar(e.room)) e.room.reservaHasta = Date.now() + RESERVA_MS;
      admitir(e);
    }
  } finally {
    revisando = false;
    if (fila.length === 0 && revisor) {
      clearInterval(revisor);
      revisor = null;
    }
  }
}

/** Para las demos: vaciar la fila entre casos. */
export function reiniciarCupo(): void {
  for (const e of fila.splice(0)) e.cancela?.(new Error("reinicio"));
  if (revisor) clearInterval(revisor);
  revisor = null;
  revisando = false;
}

/**
 * Lo que se lanza cuando una vista previa no cabe. Como `NoHayAislamiento`, se
 * atrapa arriba: no es un fallo del proyecto, es que hay que esperar.
 */
export class SalaEnEspera extends Error {
  constructor(readonly posicion: number) {
    super(`Multti está lleno: la sala espera en el lugar ${posicion} de la fila`);
  }
}
