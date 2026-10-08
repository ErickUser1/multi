import * as Y from "yjs";
import type { Socket } from "socket.io-client";

/**
 * El lado del navegador de la sincronía del documento (ver doc-vivo.ts en el
 * server). Usa el mismo socket de la sala: no hay otro servidor ni otra
 * conexión que mantener viva.
 *
 * 1. Al unirse (y cada vez que se vuelve a unir tras un corte) manda su vector
 *    de estado con `doc:sync1` y recibe lo que le falta.
 * 2. Después, cada cambio llega como `doc:update`.
 * 3. Si el server recarga el documento (alguien volvió atrás en el historial),
 *    llega `doc:recargar`: este Y.Doc ya no es el de la sala y quien lo usa
 *    tiene que crear otro proveedor.
 *
 * `editable` decide si lo que cambia aquí se manda al server. Mientras no se
 * puede editar, el navegador solo recibe.
 */
export class ProveedorDocumento {
  readonly ydoc = new Y.Doc();
  private generacion = -1;
  private sincronizado = false;
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
    },
  ) {
    const enUpdate = ({ update, generacion }: { update: ArrayBuffer | Uint8Array; generacion: number }) => {
      if (generacion !== this.generacion) return;
      Y.applyUpdate(this.ydoc, new Uint8Array(update as ArrayBuffer), this);
    };
    const enRecargar = () => this.opts.alRecargar?.();
    // Tras un corte, la Sala se vuelve a unir: ahí se pone al día otra vez.
    const enJoined = () => this.sincronizar();
    socket.on("doc:update", enUpdate);
    socket.on("doc:recargar", enRecargar);
    socket.on("joined", enJoined);
    this.oyentes.push(
      () => socket.off("doc:update", enUpdate),
      () => socket.off("doc:recargar", enRecargar),
      () => socket.off("joined", enJoined),
    );

    const enCambio = (update: Uint8Array, origen: unknown) => {
      // Lo que vino del server no se le regresa.
      if (origen === this || !this.opts.editable || !this.sincronizado) return;
      this.socket.emit("doc:update", { update, generacion: this.generacion });
    };
    this.ydoc.on("update", enCambio);
    this.oyentes.push(() => this.ydoc.off("update", enCambio));

    this.sincronizar();
  }

  private sincronizar(): void {
    this.socket.emit(
      "doc:sync1",
      { vector: Y.encodeStateVector(this.ydoc) },
      (r: { update: ArrayBuffer; vector: ArrayBuffer; generacion: number } | { noHay: true }) => {
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
        // Lo que se escribió aquí sin conexión, el server todavía no lo tiene.
        if (this.opts.editable) {
          const falta = Y.encodeStateAsUpdate(this.ydoc, new Uint8Array(r.vector));
          if (falta.byteLength > 2) this.socket.emit("doc:update", { update: falta, generacion: this.generacion });
        }
        const primera = !this.sincronizado;
        this.sincronizado = true;
        if (primera) this.opts.alSincronizar?.();
      },
    );
  }

  destruir(): void {
    for (const quitar of this.oyentes) quitar();
    this.oyentes = [];
    this.ydoc.destroy();
  }
}
