import steve from "./personajes/steve.webp";
import bob from "./personajes/bob.webp";
import lenny from "./personajes/lenny.webp";
import chip from "./personajes/chip.webp";
import dave from "./personajes/dave.webp";

/**
 * Los personajes de los agentes: cada agente de la sala tiene una cara.
 *
 * Se asignan por número y no al azar: agente-1 es siempre Steve, en todas las
 * salas y para todos los que miran. Si fuera al azar, dos personas en la misma
 * sala verían a personajes distintos hablando, y "dile a Steve" dejaría de
 * significar algo.
 *
 * Los agentes sin personaje todavía (del 6 en adelante, por ahora) se quedan
 * con el círculo de color de siempre.
 */
const PERSONAJES = [
  { nombre: "Steve", imagen: steve },
  { nombre: "Bob", imagen: bob },
  { nombre: "Lenny", imagen: lenny },
  { nombre: "Chip", imagen: chip },
  { nombre: "Dave", imagen: dave },
];

function personajeDe(nombreDelAgente: string) {
  const m = /^agente-(\d+)$/.exec(nombreDelAgente);
  if (!m) return null;
  return PERSONAJES[Number(m[1]) - 1] ?? null;
}

/** La carita de un agente: su personaje, o el círculo de color con "AI" si todavía no tiene. */
export function AvatarDeAgente(props: { nombre: string; color: string; titulo?: string }) {
  const personaje = personajeDe(props.nombre);
  if (!personaje) {
    return (
      <div className="av" style={{ background: props.color, color: "#3d2a12" }} title={props.titulo}>
        AI
      </div>
    );
  }
  return (
    <img
      className="av av-personaje"
      src={personaje.imagen}
      alt={personaje.nombre}
      title={props.titulo ?? personaje.nombre}
      draggable={false}
    />
  );
}
