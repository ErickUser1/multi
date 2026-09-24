import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { KeyedMutex } from "./keyed-mutex.js";

/**
 * Escritura de archivos con compare-and-swap (CAS) — patrón OpenCode.
 *
 * Es lo que hace posible el paralelo real entre agentes: cada escritura declara
 * los bytes que esperaba encontrar. Si el archivo cambió desde que el agente lo
 * leyó, la escritura FALLA en vez de pisar el trabajo de otro, y el error va
 * dirigido AL MODELO ("léelo otra vez"), que se corrige solo sin molestar a nadie.
 *
 * Superior a lockear archivos de forma pesimista: dos agentes en archivos
 * distintos nunca se tocan, y el conflicto se detecta exactamente cuando importa.
 */

/** Falla cuando el archivo cambió desde que el agente lo leyó. */
export class StaleContentError extends Error {
  constructor(
    readonly path: string,
    /** Quién lo tocó y hace cuánto, si se sabe (registro efímero). */
    readonly lastWriter?: { agentId: string; agoMs: number },
    /** Quién está intentando escribir ahora, para no atribuirle a otro lo suyo. */
    quienEscribe?: string,
  ) {
    super(StaleContentError.buildMessage(path, lastWriter, quienEscribe));
    this.name = "StaleContentError";
  }

  /**
   * El mensaje va AL MODELO, no al humano: tiene que decirle qué hacer.
   * Con atribución fresca es más útil; sin ella degrada pero sigue siendo accionable.
   *
   * Y si el último escritor fue ÉL MISMO, se le dice así de claro. Antes leía
   * "lo modificó agente-1 hace 3s" sin saber que agente-1 era él, concluía que
   * había alguien más trabajando, y se ponía a esperar y a releer el archivo una
   * y otra vez por un compañero que no existía. Visto en una sesión real: cuatro
   * relecturas y un `sleep 5` para nada.
   */
  private static buildMessage(
    path: string,
    w?: { agentId: string; agoMs: number },
    quienEscribe?: string,
  ): string {
    if (!w) {
      return `El archivo ${path} cambió desde que lo leíste. Léelo otra vez (read_file) antes de editarlo, y vuelve a aplicar tu cambio sobre el contenido nuevo.`;
    }
    const hace = Math.round(w.agoMs / 1000);
    if (quienEscribe && w.agentId === quienEscribe) {
      return `El archivo ${path} cambió desde que lo leíste: lo escribiste TÚ hace ${hace}s y te quedaste con la versión de antes. No hay nadie más trabajando en él. Léelo otra vez (read_file) y aplica tu cambio sobre lo que ahora hay.`;
    }
    return `El archivo ${path} cambió desde que lo leíste. Lo modificó ${w.agentId} hace ${hace}s. Léelo otra vez (read_file) antes de editarlo, y vuelve a aplicar tu cambio sobre el contenido nuevo.`;
  }
}

/** Registro EFÍMERO de última escritura por archivo. Ver DESIGN.md: memoria + TTL. */
const WRITER_TTL_MS = 5 * 60_000;

interface WriterInfo {
  agentId: string;
  at: number;
}

export class FileMutation {
  private mutex = new KeyedMutex();
  /**
   * ruta canónica → quién escribió por última vez.
   * En MEMORIA a propósito: solo sirve para enriquecer el mensaje de un CAS
   * fallido, y un CAS solo falla con turnos vivos. Si el server reinicia no hay
   * turnos con bytes viejos, así que perderlo no afecta la corrección. La
   * atribución durable vive en git (commit por turno).
   */
  private lastWriter = new Map<string, WriterInfo>();

  /**
   * Escribe solo si el archivo sigue teniendo `expected`.
   * @param expected contenido que el agente leyó. `null` = el archivo no existía.
   *                 `undefined` = escritura incondicional (crear/sobrescribir a propósito).
   */
  async writeIfUnchanged(opts: {
    path: string;
    content: string;
    expected?: string | null;
    agentId: string;
    /** Se llama si hay que esperar el lock (para mostrar "esperando a X" en la sala). */
    onWait?: (holder: string | undefined) => void;
  }): Promise<void> {
    const key = resolve(opts.path);

    await this.mutex.run(
      key,
      async () => {
        // Comparar bajo el lock: el read-compare-write es atómico respecto a
        // otros escritores del mismo proceso.
        if (opts.expected !== undefined) {
          const actual = existsSync(key) ? await readFile(key, "utf8") : null;
          if (actual !== opts.expected) {
            throw new StaleContentError(opts.path, this.writerInfo(key), opts.agentId);
          }
        }

        await mkdir(dirname(key), { recursive: true });
        // Escritura atómica: temp + rename. Nunca queda un archivo a medias.
        const tmp = `${key}.tmp-${process.pid}-${Date.now()}`;
        await writeFile(tmp, opts.content, "utf8");
        await rename(tmp, key);

        this.lastWriter.set(key, { agentId: opts.agentId, at: Date.now() });
        this.pruneWriters();
      },
      { owner: opts.agentId, onWait: opts.onWait },
    );
  }

  /**
   * Corre `fn` con el candado de `ruta` tomado, igual que una escritura.
   *
   * Para lo que no es escribir un archivo pero tampoco puede pasar dos veces a
   * la vez: correr SQL contra la base de la sala, por ejemplo. Lo que `fn`
   * devuelva en `tocados` queda anotado como escrito por `agentId`, así que
   * entra al resumen que reciben los demás agentes.
   */
  async conCandado<T>(
    ruta: string,
    opts: { agentId: string; onWait?: (holder: string | undefined) => void },
    fn: () => Promise<{ valor: T; tocados?: string[] }>,
  ): Promise<T> {
    return this.mutex.run(
      resolve(ruta),
      async () => {
        const { valor, tocados = [] } = await fn();
        for (const t of tocados) this.lastWriter.set(resolve(t), { agentId: opts.agentId, at: Date.now() });
        this.pruneWriters();
        return valor;
      },
      { owner: opts.agentId, onWait: opts.onWait },
    );
  }

  /** Lee un archivo (fuera del lock: leer no necesita exclusión). */
  async read(path: string): Promise<string | null> {
    const key = resolve(path);
    if (!existsSync(key)) return null;
    return readFile(key, "utf8");
  }

  /**
   * Archivos que otros agentes tocaron hace poco, para contárselo al que empieza
   * un turno.
   *
   * Sin esto dos agentes lanzados casi a la vez ven la misma sala vacía y los dos
   * se ponen a montar el proyecto — pasó en una sesión real. El problema del que
   * nació Multi (divergir por no ver lo que hace el otro) aplicado a los agentes.
   *
   * Solo lo reciente: lo de hace media hora ya está en el proyecto y se ve
   * leyendo los archivos.
   */
  trabajoRecienteDeOtros(
    exceptoAgente: string,
    opts: {
      dentroDeMs?: number;
      /**
       * La carpeta de la sala. Sin esto se mezclaban salas: los ids de agente se
       * repiten en cada una (`agente-1`), y este registro es uno por proceso, así
       * que el agente-2 de una sala recibía lo que tocó el agente-1 de otra. Con
       * ella, además, las rutas salen relativas a la sala y no absolutas.
       */
      sala?: string;
    } = {},
  ): Array<{ agentId: string; path: string; hace: number; escribiendoAhora: boolean }> {
    const { dentroDeMs = 120_000 } = opts;
    const sala = opts.sala ? resolve(opts.sala) + sep : null;
    const ahora = Date.now();
    const out: Array<{ agentId: string; path: string; hace: number; escribiendoAhora: boolean }> = [];
    for (const [path, w] of this.lastWriter) {
      if (w.agentId === exceptoAgente) continue;
      if (sala && !path.startsWith(sala)) continue;
      const hace = ahora - w.at;
      if (hace > dentroDeMs) continue;
      // Con el lock tomado no es "lo tocó": lo está escribiendo AHORA. Distinguirlo
      // importa — a un archivo en vuelo hay que dejarlo, uno que ya se soltó solo
      // hay que releerlo.
      out.push({
        agentId: w.agentId,
        path: sala ? relative(sala, path) : path,
        hace,
        escribiendoAhora: !!this.mutex.info(path).holder,
      });
    }
    return out.sort((a, b) => a.hace - b.hace);
  }

  /** Quién tiene tomado el lock de una ruta (para la UI: "esperando a X"). */
  lockInfo(path: string) {
    return this.mutex.info(resolve(path));
  }

  private writerInfo(key: string): { agentId: string; agoMs: number } | undefined {
    const w = this.lastWriter.get(key);
    if (!w) return undefined;
    const agoMs = Date.now() - w.at;
    // Info vieja estorba más de lo que ayuda ("lo tocó X hace 4 horas" es ruido).
    if (agoMs > WRITER_TTL_MS) return undefined;
    return { agentId: w.agentId, agoMs };
  }

  /** Descarta entradas viejas para que el mapa no crezca sin límite. */
  private pruneWriters(): void {
    if (this.lastWriter.size < 200) return;
    const cutoff = Date.now() - WRITER_TTL_MS;
    for (const [k, v] of this.lastWriter) {
      if (v.at < cutoff) this.lastWriter.delete(k);
    }
  }
}

/** Una instancia por proceso: el lock es process-local (como OpenCode). */
export const fileMutation = new FileMutation();
