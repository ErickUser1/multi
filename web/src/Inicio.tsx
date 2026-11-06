import { useEffect, useRef, useState } from "react";
import { SERVER_URL } from "./socket.js";
import { useTextos } from "./i18n.js";
import { PERSONAJES } from "./personajes.js";
import type { ProyectoDeComunidad } from "./Explorar.js";

/**
 * La pantalla de inicio: qué es Multti, para quien entra por primera vez.
 *
 * Salió de la junta con la maestra: a los estudiantes se les pasó el link de la
 * sala y nada más, y se quedaron sin saber qué hacer. La pantalla del nombre
 * decía "vas a entrar a la sala X" y ya; la sala vacía, un ejemplo rotando.
 * Nadie les había dicho que se le escribe al agente como a una persona, ni que
 * lo que piden aparece a un lado.
 *
 * Lo que NO puede volver es la portada de antes. Tenía un botón de "crear una
 * sala" como único camino, y quien ya tenía salas creaba otra (cuatro de nueve
 * acabaron vacías). Por eso:
 *
 * - Solo sale la primera vez: sin nombre guardado, sin cuenta y sin salas. Quien
 *   ya usó Multti cae donde siempre.
 * - No crea nada. "Empezar" te deja en la sala vacía de siempre, y si llegaste
 *   por un link, en esa sala.
 * - Pide el nombre aquí mismo, arriba, para que después no salga otra pantalla
 *   a preguntarlo. Es la misma pregunta de antes, con la explicación debajo.
 *
 * Con `#/inicio` se ve cuando sea, desde el menú.
 */
const STEVE = PERSONAJES[0].imagen;
const DAVE = PERSONAJES[1].imagen;

export function Inicio(props: {
  /** La sala del link, si se llegó por uno. */
  roomId: string | null;
  name: string;
  setName: (n: string) => void;
  /** Ya con el nombre: a la sala. */
  onEntrar: () => void;
  /** Si se abrió desde el menú: ya hay nombre y no se vuelve a pedir. */
  desdeElMenu?: boolean;
}) {
  const { t } = useTextos();
  const [proyectos, setProyectos] = useState<ProyectoDeComunidad[]>([]);
  const campoNombre = useRef<HTMLInputElement>(null);
  const textoBoton = props.desdeElMenu ? t.volverAMultti : props.roomId ? t.entrarALaSala : t.empezar;

  /**
   * El botón de hasta abajo. Quien leyó todo y le da ahí sin haber escrito su
   * nombre entraría como "anónimo" sin darse cuenta: mejor subirlo al campo.
   */
  const entrarDesdeAbajo = () => {
    if (!props.desdeElMenu && !props.name.trim() && campoNombre.current) {
      campoNombre.current.scrollIntoView({ behavior: "smooth", block: "center" });
      campoNombre.current.focus({ preventScroll: true });
      return;
    }
    props.onEntrar();
  };

  // Lo que ya hizo la gente, para que se vea de qué es capaz. Si falla o no hay
  // nada, la sección no sale: no es lo importante de esta pantalla.
  useEffect(() => {
    let cancelado = false;
    fetch(`${SERVER_URL}/comunidad?categoria=juego`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: { proyectos: ProyectoDeComunidad[] }) => {
        if (!cancelado) setProyectos(d.proyectos.filter((p) => p.miniatura).slice(0, 6));
      })
      .catch(() => {});
    return () => {
      cancelado = true;
    };
  }, []);

  return (
    <div className="inicio">
      {/* El logo chico, arriba a la izquierda. */}
      <span className="inicio-barra">
        <img src="/logo/multti-manos.svg" alt="" draggable={false} />
        <span>multti</span>
      </span>
      <header className="inicio-cab">
        {/* Steve y Dave a punto de tocarse, como en La creación de Adán: una
            persona y un agente construyendo algo juntos. Dave va volteado para
            que se miren. */}
        <div className="inicio-creacion" aria-hidden="true">
          <img src={STEVE} alt="" draggable={false} />
          <span className="inicio-chispa" />
          <img src={DAVE} alt="" draggable={false} className="volteado" />
        </div>
        <h1>{t.inicioTitulo}</h1>
        <p className="inicio-lema">{t.inicioLema}</p>

        <div className="inicio-entrada">
          {props.roomId && (
            <p className="inicio-sala">
              {t.vasAEntrar} <strong>{props.roomId}</strong>
            </p>
          )}
          {!props.desdeElMenu && (
            <input
              ref={campoNombre}
              className="name-input"
              placeholder={t.tuNombre}
              aria-label={t.tuNombre}
              value={props.name}
              onChange={(e) => props.setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && props.onEntrar()}
              autoFocus
            />
          )}
          <button className="cta inicio-cta" onClick={props.onEntrar}>
            {textoBoton}
          </button>
          {!props.desdeElMenu && <p className="inicio-nota">{t.inicioSinCuenta}</p>}
        </div>
      </header>

      <section className="inicio-seccion">
        <h2>{t.comoFunciona}</h2>
        <ol className="inicio-pasos">
          {t.inicioPasos.map((p, i) => (
            <li key={p.titulo}>
              <span className="inicio-num">{i + 1}</span>
              <h3>{p.titulo}</h3>
              <p>{p.texto}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="inicio-seccion">
        <h2>{t.inicioHablarle}</h2>
        <div className="inicio-modos">
          {t.inicioModos.map((m) => (
            <div key={m.titulo}>
              <h3>{m.titulo}</h3>
              <p>{m.texto}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="inicio-seccion">
        <h2>{t.inicioQuePedir}</h2>
        <ul className="inicio-ejemplos">
          {t.inicioEjemplos.map((e) => (
            <li key={e}>“{e}”</li>
          ))}
        </ul>
      </section>

      <section className="inicio-seccion">
        <h2>{t.inicioTips}</h2>
        <ul className="inicio-tips">
          {t.inicioListaTips.map((tip) => (
            <li key={tip.titulo}>
              <strong>{tip.titulo}</strong> {tip.texto}
            </li>
          ))}
        </ul>
      </section>

      {proyectos.length > 0 && (
        <section className="inicio-seccion">
          <h2>{t.inicioHechoAqui}</h2>
          <ul className="inicio-galeria">
            {proyectos.map((p) => (
              <li key={p.id}>
                <img src={`${SERVER_URL}${p.miniatura}`} alt="" loading="lazy" />
                <span>{p.titulo}</span>
              </li>
            ))}
          </ul>
          <a className="inicio-link" href="#/explorar">
            {t.explorarLink} →
          </a>
        </section>
      )}

      <footer className="inicio-pie">
        <button className="cta inicio-cta" onClick={entrarDesdeAbajo}>
          {textoBoton}
        </button>
        <a className="inicio-link" href="/acerca/">
          {t.acercaDeMulti}
        </a>
      </footer>
    </div>
  );
}
