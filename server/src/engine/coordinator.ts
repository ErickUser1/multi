/**
 * Coordinador de ejecución — un "drain" activo por CLAVE.
 *
 * Patrón de OpenCode (`session/run-coordinator.ts`), con una diferencia clave:
 * allá la clave es la SESIÓN (→ un agente a la vez, secuencial). Aquí la clave
 * es el **agentId**, así que agentes distintos corren EN PARALELO de verdad, que
 * es el punto del producto. Ver DESIGN.md.
 *
 * Tres comportamientos que importan:
 *  1. JOIN — si ya hay ejecución para esa clave, el segundo llamador se suscribe
 *     a la misma en vez de arrancar otro loop.
 *  2. COALESCING — N mensajes durante una ejecución producen UNA sola
 *     re-ejecución al terminar (sin esto, con dos compas escribiendo en vivo,
 *     se encolan ejecuciones redundantes y se queman tokens).
 *  3. STOPPING + retry — cierra la carrera "interrumpí y arranqué antes de que
 *     el anterior soltara".
 */

interface Entry {
  /** Promesa de la ejecución en curso (para que otros hagan join). */
  running: Promise<void>;
  /** Llegaron mensajes durante la ejecución → arrancar UNA re-ejecución al final. */
  pendingWake: boolean;
  /** Se está interrumpiendo: los nuevos run() esperan a que muera y reintentan. */
  stopping: boolean;
  /** Señal de cancelación para el trabajo en curso. */
  abort: AbortController;
}

export class RunCoordinator {
  private entries = new Map<string, Entry>();

  /** ¿Hay ejecución activa para esta clave? */
  isActive(key: string): boolean {
    return this.entries.has(key);
  }

  activeKeys(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * Ejecuta `drain` para `key`, garantizando un solo drain activo por clave.
   * Si ya hay uno: hace JOIN y marca pendingWake (coalescing).
   *
   * @param drain recibe la señal de aborto para poder cancelarse.
   */
  async run(key: string, drain: (signal: AbortSignal) => Promise<void>): Promise<void> {
    for (;;) {
      const existing = this.entries.get(key);

      if (existing) {
        // JOIN + coalescing: no arranca otro loop, pide una re-ejecución al final.
        //
        // Vale también si está `stopping`: ese es justo el caso de interrumpir
        // escribiendo lo que sí quieres. El ciclo se entera de que hay trabajo
        // pendiente y, en vez de morir, lo atiende con una señal limpia. Antes
        // aquí se esperaba a que muriera y se reintentaba, con lo que el mensaje
        // del que interrumpió se quedaba sin dueño.
        existing.pendingWake = true;
        return existing.running.then(
          () => undefined,
          () => undefined,
        );
      }

      // No hay nadie: arrancar.
      const entry: Entry = {
        running: Promise.resolve(),
        pendingWake: false,
        stopping: false,
        abort: new AbortController(),
      };
      this.entries.set(key, entry);

      entry.running = this.loop(key, entry, drain);
      return entry.running;
    }
  }

  /** Corre el drain, y si hubo wakeups mientras tanto, arranca UNA re-ejecución. */
  private async loop(
    key: string,
    entry: Entry,
    drain: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    try {
      for (;;) {
        entry.pendingWake = false;
        // Un drain puede terminar por abort: no debe tumbar el ciclo, porque
        // justo después suele venir el trabajo que causó la interrupción.
        await drain(entry.abort.signal).catch((err) => {
          if (!entry.abort.signal.aborted) throw err;
        });

        // Coalescing: los N mensajes que llegaron durante el drain se atienden
        // con UNA sola pasada más, no con N.
        if (!entry.pendingWake) break;

        // Interrumpido CON trabajo encolado: se atiende lo nuevo con una señal
        // limpia. Sin esto el ciclo moría llevándose el mensaje del que
        // interrumpió — el caso normal es interrumpir escribiendo lo que sí
        // quieres, así que perderlo rompe el gesto entero.
        if (entry.stopping) {
          entry.stopping = false;
          entry.abort = new AbortController();
        }
      }
    } finally {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    }
  }

  /**
   * Interrumpe la ejecución de una clave.
   *
   * Se limpia el wake que hubiera ANTES: pertenecía al trabajo que estás
   * matando, y revivirlo sería justo lo contrario de interrumpir. Pero un wake
   * que llegue DESPUÉS sí se atiende — ese es el caso normal: interrumpes
   * escribiendo lo que sí quieres, y ese mensaje tiene que llegar.
   *
   * La distinción es de OpenCode (`session/run-coordinator.ts`), que la prueba
   * con dos casos: "interrupts active execution and clears its pending wake" y
   * "runs a wake registered during interruption cleanup".
   */
  interrupt(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.stopping = true;
    entry.pendingWake = false;
    entry.abort.abort();
  }

  interruptAll(): void {
    for (const key of this.entries.keys()) this.interrupt(key);
  }
}
