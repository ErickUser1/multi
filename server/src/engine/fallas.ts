/**
 * El error crudo del proveedor, traducido a qué pasó y qué hacer.
 *
 * Lo que cambia es A QUIÉN se le habla. Si la persona pegó su propia key, el
 * saldo y la key son suyos y se le dice cómo arreglarlo. Si el turno corrió con
 * la key de respaldo (la del `.env`, la de quien corre Multi), nadie en la sala
 * puede hacer nada: decirle "recarga tu saldo" o "pon otra key" es mandarlo a
 * resolver algo que no es suyo.
 *
 * Pasó en una sesión real: la key de respaldo se quedó sin saldo y a una
 * persona le salió dos veces "se acabaron los créditos de tu cuenta. Pon otra
 * key o recarga saldo". No tenía cuenta ni key, y ahí dejó Multi.
 */
export function explicarFallaDelProveedor(texto: string, deRespaldo: boolean): string {
  // Antes que el de créditos: este mensaje TAMBIÉN habla de saldo, y si cae en
  // el genérico se le dice "recarga" a alguien que sí tiene dinero.
  if (texto.includes("el techo de salida no cabe")) {
    return deRespaldo
      ? SIN_SALDO_DE_MULTI
      : "tu saldo no alcanza para el tamaño de respuesta que se pidió. Se reintentó con uno más chico y tampoco cupo: recarga saldo o usa un modelo más barato.";
  }
  if (texto.includes("credit balance") || texto.includes("insufficient")) {
    return deRespaldo ? SIN_SALDO_DE_MULTI : "se acabaron los créditos de tu cuenta. Pon otra key o recarga saldo.";
  }
  if (texto.includes("401") || texto.includes("key inválida") || texto.includes("invalid_api_key")) {
    return deRespaldo
      ? "Multi tiene un problema con su conexión al modelo, no es nada de tu lado. Intenta de nuevo en un rato."
      : "tu API key no es válida. Revísala en el panel de arriba.";
  }
  if (texto.includes("rate") || texto.includes("429")) {
    return deRespaldo
      ? "hay mucha gente usando Multi en este momento. Espera un minuto y vuelve a intentar."
      : "tu cuenta llegó a su límite de uso por ahora. Espera un momento o usa otra key.";
  }
  if (texto.includes("Internal Server Error") || texto.includes("no responde") || texto.includes("503")) {
    return deRespaldo
      ? "el proveedor del modelo está fallando (no es cosa tuya). Vuelve a intentar en un momento."
      : "el proveedor del modelo está fallando (no es cosa tuya). Vuelve a intentar, o cambia de modelo en el panel.";
  }
  if (texto.includes("model") && texto.includes("not found")) {
    return deRespaldo
      ? "Multi tiene un problema con su conexión al modelo, no es nada de tu lado. Intenta de nuevo en un rato."
      : "ese modelo no existe o tu cuenta no tiene acceso. Elige otro en el panel.";
  }
  if (texto.includes("se cortó a media escritura")) {
    return deRespaldo
      ? "la respuesta del modelo se cortó a la mitad, seguramente por la conexión. Vuelve a intentar."
      : "la respuesta del modelo se cortó a la mitad. Suele ser falta de créditos o una caída de conexión, vuelve a intentar.";
  }
  if (texto.includes("AbortError")) {
    return "el turno se detuvo.";
  }

  // Sin patrón conocido: se muestra recortado, no el volcado entero.
  return `algo falló — ${texto.slice(0, 120)}`;
}

/** Cuando el saldo que se acabó es el de Multi, no el de quien está en la sala. */
export const SIN_SALDO_DE_MULTI =
  "Multi se quedó sin saldo por ahora. No es tu cuenta ni nada que hayas hecho: ya lo estamos resolviendo. Intenta de nuevo en un rato.";
