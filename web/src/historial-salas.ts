/**
 * Las salas donde has entrado, guardadas en este navegador.
 *
 * El problema que resuelve: hoy si cierras la pestaña y no guardaste el link,
 * la sala se perdió. Los nombres son legibles a propósito (compa-zona-49, no un
 * UUID) justo para poder dictarlos por teléfono, pero nadie se los aprende.
 *
 * Sin cuenta y sin servidor: vive en localStorage, atado a este navegador. No
 * sincroniza entre dispositivos, y eso está bien — un login contra el server de
 * quien levantó Multi guardaría una identidad que solo existe mientras esa
 * máquina esté prendida.
 *
 * NO se separa "mis salas" de "compartidas conmigo". La distinción se borra
 * sola: entras a una que te pasaron, invitas a alguien, y ya es tuya también.
 * Lo que sí distingue es cuándo entraste, y por eso van ordenadas por eso.
 */

const CLAVE = "multi.salas";

/** Cuántas se recuerdan. Más allá de esto la lista deja de ser útil. */
const MAXIMO = 20;

export interface SalaVisitada {
  id: string;
  /** Última vez que entraste, en milisegundos. Es el orden de la lista. */
  visitadaEn: number;
  /**
   * Cómo se llamaba la sala la última vez que entraste.
   *
   * El nombre de verdad vive en el server (lo ven todos), pero se copia aquí
   * para poder pintar la lista sin preguntar por cada sala. Si alguien lo
   * cambió mientras no estabas, verás el viejo hasta que vuelvas a entrar: en
   * un menú para reconocer tus salas, eso alcanza.
   */
  nombre?: string | null;
}

/** Las salas donde entraste, de la más reciente a la más vieja. */
export function salasVisitadas(): SalaVisitada[] {
  try {
    const crudo = localStorage.getItem(CLAVE);
    if (!crudo) return [];
    const lista = JSON.parse(crudo);
    if (!Array.isArray(lista)) return [];
    return lista
      .filter((s): s is SalaVisitada => typeof s?.id === "string" && typeof s?.visitadaEn === "number")
      .sort((a, b) => b.visitadaEn - a.visitadaEn);
  } catch {
    // Un localStorage corrupto no debe impedirte entrar a una sala.
    return [];
  }
}

/** Anota que entraste a una sala. Si ya estaba, sube al principio. */
export function recordarSala(id: string): void {
  try {
    const previa = salasVisitadas().find((s) => s.id === id);
    const otras = salasVisitadas().filter((s) => s.id !== id);
    // Se conserva el nombre que ya se tenía: esto corre AL ENTRAR, cuando el
    // server todavía no ha dicho cómo se llama la sala. Sin esto, cada visita
    // borraba el nombre y el menú volvía a mostrar el id.
    const lista = [
      { id, visitadaEn: Date.now(), nombre: previa?.nombre ?? null },
      ...otras,
    ].slice(0, MAXIMO);
    localStorage.setItem(CLAVE, JSON.stringify(lista));
  } catch {
    // Modo incógnito o almacenamiento lleno: se pierde el historial, no la sala.
  }
}

/**
 * Anota cómo se llama una sala, para que el menú la muestre por su nombre.
 *
 * Se llama cuando el server lo dice: al entrar y cuando alguien lo cambia. Si
 * la sala no está en la lista todavía, no hace nada: entrar es lo que la mete.
 */
export function recordarNombre(id: string, nombre: string | null): void {
  try {
    const lista = salasVisitadas();
    const sala = lista.find((s) => s.id === id);
    if (!sala || sala.nombre === nombre) return;
    sala.nombre = nombre;
    localStorage.setItem(CLAVE, JSON.stringify(lista));
  } catch {
    // Igual que arriba: no vale la pena romper la interfaz por el historial.
  }
}

/** Saca una sala de la lista. */
export function olvidarSala(id: string): void {
  try {
    const lista = salasVisitadas().filter((s) => s.id !== id);
    localStorage.setItem(CLAVE, JSON.stringify(lista));
  } catch {
    // Igual que arriba: no vale la pena romper la interfaz por esto.
  }
}
