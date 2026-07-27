/**
 * Mutex por clave: misma clave → cola; claves distintas → paralelo real.
 *
 * Patrón de OpenCode (`packages/core/src/effect/keyed-mutex.ts`), portado a
 * Promises. Es la base de la concurrencia de Multi: dos agentes escribiendo
 * archivos DISTINTOS no se estorban; si tocan el MISMO, hacen fila.
 *
 * Cuenta holders + waiters para no borrar la entrada mientras alguien la va a
 * reusar (si se borra a medias, dos waiters podrían crear entradas distintas
 * para la misma clave y perder la exclusión).
 */

interface Entry {
  /** Promesa del último en la fila; el siguiente espera a esta. */
  tail: Promise<void>;
  /** Holders + waiters. Al llegar a 0 se puede limpiar la entrada. */
  users: number;
}

export interface LockInfo {
  /** Quién tiene el lock ahora (para diagnóstico y para el aviso "esperando a X"). */
  holder?: string;
  /** Cuántos están esperando esta clave. */
  waiting: number;
}

export class KeyedMutex {
  private entries = new Map<string, Entry>();
  private holders = new Map<string, string>();
  /** Primer dueño encolado para una clave (antes de que tome el lock). */
  private pendingOwners = new Map<string, string>();

  /**
   * Corre `fn` en exclusión mutua para `key`.
   * @param owner etiqueta de quién toma el lock (agentId), para diagnóstico.
   * @param onWait se llama si hay que esperar, con quién lo tiene. Sirve para
   *        mostrar en la sala "esperando a Agente-1 (Menu.jsx)" — ver DESIGN.md
   *        (dos relojes: la espera de lock NO cuenta para el timeout de turno).
   */
  async run<T>(
    key: string,
    fn: () => Promise<T>,
    opts: { owner?: string; onWait?: (holder: string | undefined) => void } = {},
  ): Promise<T> {
    const existing = this.entries.get(key);
    // Hay que esperar si ya hay alguien ENCOLADO (no basta con mirar `holders`:
    // el de adelante puede no haber tomado el lock todavía — es una carrera).
    const mustWait = existing !== undefined && existing.users > 0;

    const entry = existing ?? { tail: Promise.resolve(), users: 0 };
    if (!existing) this.entries.set(key, entry);

    entry.users++;

    const previous = entry.tail;
    if (mustWait) opts.onWait?.(this.holders.get(key) ?? this.pendingOwners.get(key));

    // Registrar quién viene, para que el que espere sepa a quién espera aunque
    // el de adelante aún no haya llegado a marcarse como holder.
    if (opts.owner && !this.pendingOwners.has(key)) this.pendingOwners.set(key, opts.owner);

    // Encadenar: este trabajo empieza cuando el anterior termine.
    let release!: () => void;
    entry.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous.catch(() => {
      /* si el anterior falló, igual seguimos: el lock es de exclusión, no de éxito */
    });

    if (opts.owner) this.holders.set(key, opts.owner);
    try {
      return await fn();
    } finally {
      this.holders.delete(key);
      release();
      entry.users--;
      // Limpiar solo si nadie más la está usando ni esperando.
      if (entry.users === 0 && this.entries.get(key) === entry) {
        this.entries.delete(key);
        this.pendingOwners.delete(key);
      }
    }
  }

  /** Estado de una clave (para diagnóstico / UI). */
  info(key: string): LockInfo {
    const entry = this.entries.get(key);
    return {
      holder: this.holders.get(key),
      waiting: entry ? Math.max(0, entry.users - (this.holders.has(key) ? 1 : 0)) : 0,
    };
  }
}
