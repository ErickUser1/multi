/**
 * Los personajes de los agentes, del lado del server: el mismo orden que
 * `web/src/personajes.tsx`, que es donde viven las imágenes.
 *
 * El agente no ve la pantalla, así que sin esto no sabe que en la sala lo ven
 * como Steve: alguien le decía "gracias Steve" y contestaba que no era Steve.
 * Si cambia el orden o entra un personaje nuevo, cambia en los dos archivos.
 */
const PERSONAJES = [
  { nombre: "Steve", aspecto: "una bolita naranja de peluche con goggles y cinturón de herramientas" },
  { nombre: "Dave", aspecto: "una nube azul cielo de peluche con un tablero de botones en el pecho" },
  { nombre: "Lenny", aspecto: "un peluche morado con gorro de aviador, audífonos y cámara" },
  { nombre: "Bob", aspecto: "una cápsula verde de peluche con micrófono" },
  { nombre: "Chip", aspecto: "un peluche verde azulado con casco de chips" },
];

/** El personaje de `agente-N`, en el mismo orden y con la misma vuelta que en la Sala. */
export function personajeDe(nombreDelAgente: string): { nombre: string; aspecto: string } | null {
  const m = /^agente-(\d+)$/.exec(nombreDelAgente);
  if (!m) return null;
  return PERSONAJES[(Number(m[1]) - 1) % PERSONAJES.length] ?? null;
}

/**
 * Quién es el agente, dicho al empezar cada turno: su nombre para mencionarlo
 * y cómo lo ven las personas. Va en el mensaje y no en el prompt del sistema
 * porque cambia de un agente a otro, y el prompt del sistema se cachea.
 */
export function quienEres(nombreDelAgente: string): string {
  const p = personajeDe(nombreDelAgente);
  const lineas = [
    "<quien_eres>",
    `Eres ${nombreDelAgente}: así te mencionan en el chat (@${nombreDelAgente}).`,
  ];
  if (p) {
    lineas.push(
      `En la sala las personas te ven como ${p.nombre}, ${p.aspecto}.`,
      `Si te llaman ${p.nombre}, te hablan a ti: contesta con naturalidad, sin corregirles el nombre.`,
    );
  }
  lineas.push("</quien_eres>");
  return lineas.join("\n");
}
