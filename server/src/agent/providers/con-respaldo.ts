import type { ModelProvider, StreamCallbacks, StreamEvent, StreamParams } from "./types.js";

/**
 * El proveedor de Multti con un respaldo para cuando se acaba el saldo.
 *
 * Pasó el 29 de octubre: seis personas construyendo un juego en una sala, una
 * tarde entera, y a media sesión "Multti se quedó sin saldo". Ahí se cortó todo.
 * Con esto, si el principal (Claude, con la key del `.env`) contesta que no hay
 * saldo, ESA misma vuelta se repite con el respaldo (Gemini, pagado con los
 * créditos de Google) y la sala sigue. Las vueltas de los próximos minutos van
 * directo al respaldo, para no gastar una llamada que ya se sabe que falla.
 *
 * Solo envuelve al proveedor de respaldo del `.env`. Quien pegó su propia key
 * paga con ella: si se le acaba, se le dice a él, no se le pasa a los créditos
 * de Multti.
 */

/** Cuánto se queda en el respaldo antes de volver a probar el principal. */
export const MINUTOS_EN_RESPALDO = 30;

/** Hasta cuándo se usa el respaldo. Compartido por todas las salas: el saldo es uno. */
let respaldoHasta = 0;

/** Si este error es "se acabó el saldo" del principal. */
export function esSinSaldo(err: unknown): boolean {
  const t = String(err);
  return /credit balance|insufficient|sin créditos|billing/i.test(t);
}

/** Lo que el respaldo no tiene y el prompt da por hecho. */
const NOTA_DEL_RESPALDO =
  "\n\n<respaldo>\nEn este turno no tienes web_search ni web_fetch. Si necesitas algo de internet, usa curl desde bash.\n</respaldo>";

export class ConRespaldo implements ModelProvider {
  readonly name: string;
  readonly defaultModel: string;

  constructor(
    private readonly principal: ModelProvider,
    private readonly respaldo: ModelProvider,
    private readonly ahora: () => number = Date.now,
  ) {
    // Se presenta como el principal: el resto del server decide cosas por el
    // nombre (si ve imágenes, si lleva búsqueda web), y eso lo resuelve cada uno.
    this.name = principal.name;
    this.defaultModel = principal.defaultModel;
  }

  async stream(params: StreamParams, callbacks: StreamCallbacks = {}): Promise<Extract<StreamEvent, { type: "end" }>> {
    if (this.ahora() < respaldoHasta) return this.conRespaldo(params, callbacks);
    try {
      return await this.principal.stream(params, callbacks);
    } catch (err) {
      if (params.signal?.aborted || !esSinSaldo(err)) throw err;
      respaldoHasta = this.ahora() + MINUTOS_EN_RESPALDO * 60_000;
      console.warn(`[respaldo] ${this.principal.name} sin saldo — ${MINUTOS_EN_RESPALDO} min con ${this.respaldo.name}`);
      return this.conRespaldo(params, callbacks);
    }
  }

  private conRespaldo(params: StreamParams, callbacks: StreamCallbacks): Promise<Extract<StreamEvent, { type: "end" }>> {
    callbacks.onRespaldo?.({ proveedor: this.respaldo.name });
    return this.respaldo.stream(
      {
        ...params,
        // El modelo lo eligió el principal; el respaldo usa el suyo.
        model: undefined,
        system: params.system ? params.system + NOTA_DEL_RESPALDO : NOTA_DEL_RESPALDO.trim(),
      },
      callbacks,
    );
  }
}

/** Si ahorita se está usando el respaldo. Para el log y las pruebas. */
export function enRespaldo(ahora: number = Date.now()): boolean {
  return ahora < respaldoHasta;
}

/** Para las pruebas. */
export function reiniciarRespaldo(): void {
  respaldoHasta = 0;
}
