import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
  ) {
    super(StaleContentError.buildMessage(path, lastWriter));
    this.name = "StaleContentError";
  }

  /**
   * El mensaje va AL MODELO, no al humano: tiene que decirle qué hacer.
   * Con atribución fresca es más útil; sin ella degrada pero sigue siendo accionable.
   */
  private static buildMessage(path: string, w?: { agentId: string; agoMs: number }): string {
    const quien = w ? ` Lo modificó ${w.agentId} hace ${Math.round(w.agoMs / 1000)}s.` : "";
    return `El archivo ${path} cambió desde que lo leíste.${quien} Léelo otra vez (read_file) antes de editarlo, y vuelve a aplicar tu cambio sobre el contenido nuevo.`;
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
            throw new StaleContentError(opts.path, this.writerInfo(key));
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

  /** Lee un archivo (fuera del lock: leer no necesita exclusión). */
  async read(path: string): Promise<string | null> {
    const key = resolve(path);
    if (!existsSync(key)) return null;
    return readFile(key, "utf8");
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
