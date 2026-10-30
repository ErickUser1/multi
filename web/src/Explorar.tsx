import { useEffect, useState } from "react";
import { SERVER_URL } from "./socket.js";
import { useTextos } from "./i18n.js";
import { cuando } from "./MenuSalas.js";

/**
 * Explorar: lo que la gente compartió con la comunidad.
 *
 * Es donde Multti deja de ser una sala con tus amigos y se vuelve un lugar: ves
 * lo que hicieron otros, lo juegas, y si te late entras a construir con ellos.
 * Por eso el botón principal es "Entrar a construir" (a la sala misma, con su
 * chat y su gente) y no copiar: quien comparte lo hace para que se le sumen.
 * "Haz tu versión" queda para quien quiere experimentar sin tocar lo de nadie.
 *
 * Por ahora solo juegos. La categoría ya viaja en todo, así que agregar otras
 * es agregarlas al server y a las pestañas de aquí.
 */

export interface ProyectoDeComunidad {
  id: string;
  categoria: string;
  titulo: string;
  autor: string;
  compartido: number;
  /** El link para jugarla. */
  url: string | null;
  /** Ruta de la miniatura en el server, o null si se compartió sin foto. */
  miniatura: string | null;
}

export function Explorar({ nombre }: { nombre: string }) {
  const { t, idioma } = useTextos();
  const [proyectos, setProyectos] = useState<ProyectoDeComunidad[] | null>(null);
  const [error, setError] = useState(false);
  /** El id del proyecto del que se está haciendo un remix, para el botón. */
  const [remixando, setRemixando] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    fetch(`${SERVER_URL}/comunidad?categoria=juego`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: { proyectos: ProyectoDeComunidad[] }) => !cancelado && setProyectos(d.proyectos))
      .catch(() => !cancelado && setError(true));
    return () => {
      cancelado = true;
    };
  }, []);

  const hacerTuVersion = async (id: string) => {
    if (remixando) return;
    setRemixando(id);
    try {
      const r = await fetch(`${SERVER_URL}/rooms/${id}/remix`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ autor: nombre }),
      });
      const d = (await r.json().catch(() => null)) as { id?: string; error?: string } | null;
      if (!r.ok || !d?.id) {
        alert(d?.error ?? t.remixFallo);
        return;
      }
      window.location.hash = `#/sala/${d.id}`;
    } catch {
      alert(t.remixFallo);
    } finally {
      setRemixando(null);
    }
  };

  return (
    <div className="explorar">
      <header className="explorar-cab">
        <a className="explorar-volver" href="#/">
          ← {t.volverAMultti}
        </a>
        <h1>{t.explorarTitulo}</h1>
        <p>{t.explorarSub}</p>
      </header>

      {error ? (
        <p className="explorar-vacio">{t.explorarError}</p>
      ) : proyectos === null ? (
        <p className="explorar-vacio">{t.explorarCargando}</p>
      ) : proyectos.length === 0 ? (
        <p className="explorar-vacio">{t.explorarVacio}</p>
      ) : (
        <ul className="explorar-lista">
          {proyectos.map((p) => (
            <li key={p.id} className="explorar-tarjeta">
              <a className="explorar-foto" href={`#/sala/${p.id}`} aria-label={`${t.entrarAConstruir}: ${p.titulo}`}>
                {p.miniatura ? (
                  <img src={`${SERVER_URL}${p.miniatura}`} alt="" loading="lazy" />
                ) : (
                  // Sin foto, la inicial: que la tarjeta no se vea rota.
                  <span aria-hidden="true">{p.titulo.slice(0, 1).toUpperCase()}</span>
                )}
              </a>
              <div className="explorar-info">
                <h2>{p.titulo}</h2>
                <p>
                  {t.porAutor(p.autor)} · {cuando(p.compartido, idioma)}
                </p>
              </div>
              <div className="explorar-acciones">
                <a className="explorar-entrar" href={`#/sala/${p.id}`}>
                  {t.entrarAConstruir}
                </a>
                {p.url && (
                  <a className="explorar-jugar" href={p.url} target="_blank" rel="noreferrer">
                    {t.jugar}
                  </a>
                )}
                <button className="explorar-version" onClick={() => hacerTuVersion(p.id)} disabled={!!remixando}>
                  {remixando === p.id ? t.haciendoRemix : t.hazTuVersion}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
