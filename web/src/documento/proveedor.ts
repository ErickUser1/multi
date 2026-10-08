import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import type { Socket } from "socket.io-client";

/** Lo que la vista dice del guardado. */
export type EstadoDeGuardado = "guardado" | "guardando" | "sinConexion";

/**
 * El lado del navegador de la sincronía del documento (ver doc-vivo.ts en el
 * server). Usa el mismo socket de la sala: no hay otro servidor ni otra
 * conexión que mantener viva.
 *
 * 1. Al unirse (y cada vez que se vuelve a unir tras un corte) manda su vector
 *    de estado con `doc:sync1` y recibe lo que le falta; si escribió algo sin
 *    conexión, lo manda en ese momento.
 * 2. Después, cada cambio viaja como `doc:update` en los dos sentidos, y los
 *    cursores como `doc:awareness`.
 * 3. Si el server recarga el documento (alguien volvió atrás en el historial),
 *    llega `doc:recargar`: este Y.Doc ya no es el de la sala y quien lo usa
 *    tiene que crear otro proveedor.
 */
export class ProveedorDocumento {
  readonly ydoc = new Y.Doc();
  readonly awareness = new Awareness(this.ydoc);
  private generacion = -1;
  private sincronizado = false;
  private pendientes = 0;
  private oyentes: (() => void)[] = [];

  constructor(
    private socket: Socket,
    private opts: {
      editable: boolean;
      /** El documento ya está al día (primera sincronía). */
      alSincronizar?: () => void;
      /** La sala ya no es documento. */
      alNoHaber?: () => void;
      /** El documento del server se recargó: hay que tirar este. */
      alRecargar?: () => void;
      /** Cambió el estado del guardado. */
      alGuardar?: (estado: EstadoDeGuardado) => void;
    },
  ) {
    const enUpdate = ({ update, generacion }: { update: ArrayBuffer | Uint8Array; generacion: number }) => {
      if (generacion !== this.generacion) return;
      Y.applyUpdate(this.ydoc, new Uint8Array(update as ArrayBuffer), this);
    };
    const enAwareness = ({ update }: { update: ArrayBuffer | Uint8Array }) => {
      applyAwarenessUpdate(this.awareness, new Uint8Array(update as ArrayBuffer), this);
    };
    const enRecargar = () => this.opts.alRecargar?.();
    // Tras un corte, la Sala se vuelve a unir: ahí se pone al día otra vez.
    const enJoined = () => this.sincronizar();
    const enCorte = () => this.opts.alGuardar?.("sinConexion");
    socket.on("doc:update", enUpdate);
    socket.on("doc:awareness", enAwareness);
    socket.on("doc:recargar", enRecargar);
    socket.on("joined", enJoined);
    socket.on("disconnect", enCorte);
    this.oyentes.push(
      () => socket.off("doc:update", enUpdate),
      () => socket.off("doc:awareness", enAwareness),
      () => socket.off("doc:recargar", enRecargar),
      () => socket.off("joined", enJoined),
      () => socket.off("disconnect", enCorte),
    );

    const enCambio = (update: Uint8Array, origen: unknown) => {
      // Lo que vino del server no se le regresa.
      if (origen === this || !this.opts.editable || !this.sincronizado) return;
      this.enviar(update);
    };
    this.ydoc.on("update", enCambio);
    this.oyentes.push(() => this.ydoc.off("update", enCambio));

    const enMiAwareness = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origen: unknown) => {
      if (origen === this) return;
      const cambiados = [...added, ...updated, ...removed];
      if (cambiados.length) this.socket.emit("doc:awareness", { update: encodeAwarenessUpdate(this.awareness, cambiados) });
    };
    this.awareness.on("update", enMiAwareness);
    this.oyentes.push(() => this.awareness.off("update", enMiAwareness));

    this.sincronizar();
  }

  private enviar(update: Uint8Array): void {
    if (this.socket.disconnected) {
      // Sin conexión: el cambio se queda en este Y.Doc y sale en la próxima
      // sincronía (el server pide lo que le falta con su vector).
      this.opts.alGuardar?.("sinConexion");
      return;
    }
    this.pendientes++;
    this.opts.alGuardar?.("guardando");
    this.socket.emit("doc:update", { update, generacion: this.generacion }, () => {
      this.pendientes = Math.max(0, this.pendientes - 1);
      if (this.pendientes === 0) this.opts.alGuardar?.("guardado");
    });
  }

  private sincronizar(): void {
    this.socket.emit(
      "doc:sync1",
      { vector: Y.encodeStateVector(this.ydoc) },
      (
        r:
          | { update: ArrayBuffer; vector: ArrayBuffer; generacion: number; awareness?: ArrayBuffer }
          | { noHay: true },
      ) => {
        if ("noHay" in r) {
          this.opts.alNoHaber?.();
          return;
        }
        if (this.generacion !== -1 && r.generacion !== this.generacion) {
          this.opts.alRecargar?.();
          return;
        }
        this.generacion = r.generacion;
        Y.applyUpdate(this.ydoc, new Uint8Array(r.update), this);
        if (r.awareness) applyAwarenessUpdate(this.awareness, new Uint8Array(r.awareness), this);
        // Lo que se escribió aquí sin conexión, el server todavía no lo tiene.
        if (this.opts.editable) {
          const falta = Y.encodeStateAsUpdate(this.ydoc, new Uint8Array(r.vector));
          if (falta.byteLength > 2) this.enviar(falta);
          else if (this.pendientes === 0) this.opts.alGuardar?.("guardado");
        }
        // Mi cursor, para el que acaba de llegar (o para todos, tras un corte).
        const mio = this.awareness.getLocalState();
        if (mio) this.socket.emit("doc:awareness", { update: encodeAwarenessUpdate(this.awareness, [this.ydoc.clientID]) });
        const primera = !this.sincronizado;
        this.sincronizado = true;
        if (primera) this.opts.alSincronizar?.();
      },
    );
  }

  destruir(): void {
    // Que mi cursor no se quede flotando en las pantallas de los demás.
    removeAwarenessStates(this.awareness, [this.ydoc.clientID], "adios");
    for (const quitar of this.oyentes) quitar();
    this.oyentes = [];
    this.awareness.destroy();
    this.ydoc.destroy();
  }
}
