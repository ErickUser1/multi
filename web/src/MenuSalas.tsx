import { useEffect, useState } from "react";
import {
  salasVisitadas,
  guardarSalas,
  olvidarSala,
  type SalaVisitada,
} from "./historial-salas.js";
import { sincronizarSalas } from "./cuenta.js";
import { borrarSala } from "./socket.js";
import { IconoBrujula, IconoAyuda, IconoInfo, IconoMas, IconoPanel } from "./iconos.js";
import { useTextos } from "./i18n.js";

/**
 * El panel lateral: tus salas y lo que no es de la sala en la que estás.
 *
 * Antes era un menú que caía del botón "Tus salas". Se volvió panel, como el
 * de Lovable, por dos cosas: la barra de arriba no tenía espacio para todo lo
 * que ya cargaba, y aquí cabe el logo, que en la barra no.
 *
 * Empuja el contenido en vez de taparlo: con el panel abierto se sigue viendo
 * el chat, y saltar entre salas mientras lees la conversación es justo para lo
 * que sirve. En el celular sí va encima, porque ahí no hay ancho que empujar.
 *
 * La lista NO separa "mías" de "compartidas conmigo": esa distinción se borra
 * sola en cuanto invitas a alguien o alguien te invita, y sin login no hay
 * forma de saber quién creó qué. Lo que sí distingue es cuándo entraste, y por
 * eso van ordenadas por eso.
 */
export function PanelLateral({
  abierto,
  actual,
  onCerrar,
  onNavegar,
  onNuevaSala,
  creando,
}: {
  abierto: boolean;
  actual?: string;
  onCerrar: () => void;
  /** Al ir a otro lado: en el celular el panel estorba y se cierra. */
  onNavegar: () => void;
  onNuevaSala: () => void;
  creando: boolean;
}) {
  const { t, idioma } = useTextos();
  const [salas, setSalas] = useState<SalaVisitada[]>([]);
  /** El id de la sala que se está borrando ahora mismo, o null. */
  const [borrando, setBorrando] = useState<string | null>(null);
  /** La que se acaba de borrar, para avisarlo. Se limpia sola. */
  const [borrada, setBorrada] = useState<string | null>(null);

  useEffect(() => {
    if (!borrada) return;
    const id = setTimeout(() => setBorrada(null), 4000);
    return () => clearTimeout(id);
  }, [borrada]);

  /**
   * Borrar una sala de verdad, no solo quitarla de esta lista.
   *
   * Se pregunta antes porque es irreversible y NO es personal: la sala es de
   * quien tenga el link, así que borrarla se lleva el trabajo de los compas que
   * estén ahí. El nombre va en la pregunta para que se vea cuál se va a ir: en
   * una lista de salas que se llaman parecido, "¿seguro?" a secas no dice nada.
   *
   * Si el server falla, la sala NO se quita de la lista: seguiría existiendo y
   * borrarla del menú solo escondería algo que sigue ocupando disco.
   */
  const borrar = async (id: string) => {
    if (!confirm(t.confirmarBorrarSala(id))) return;
    setBorrando(id);
    try {
      await borrarSala(id);
      olvidarSala(id);
      setSalas(salasVisitadas());
      if (id === actual) {
        // Borraste la sala donde estabas: ahí ya no hay nada que ver.
        alert(t.salaBorradaOk(id));
        window.location.hash = "#/";
      } else {
        setBorrada(id);
      }
    } catch (e) {
      alert(t.noSePudoBorrar + String(e));
    } finally {
      setBorrando(null);
    }
  };


  // Se lee al abrir, no al montar: así refleja lo que haya pasado en otra
  // pestaña sin tener que escuchar el evento `storage`.
  //
  // Primero lo local, que es instantáneo, y luego se pregunta al server: con
  // cuenta, tus salas viven ahí y pueden ser más de las que cupieron en este
  // navegador. Sin sesión la petición devuelve lo mismo que ya se pintó, así
  // que no cambia nada visible.
  useEffect(() => {
    if (!abierto) return;
    setSalas(salasVisitadas());
    let cancelado = false;
    void sincronizarSalas().then((delServer) => {
      if (cancelado) return;
      guardarSalas(delServer);
      setSalas(delServer);
    });
    return () => {
      cancelado = true;
    };
  }, [abierto, actual]);

  // Escape cierra, como cualquier panel. Click fuera NO: el panel empuja el
  // contenido y convive con él, así que tocar el chat no tiene por qué cerrarlo.
  useEffect(() => {
    if (!abierto) return;
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCerrar();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [abierto, onCerrar]);

  if (!abierto) return null;

  return (
    <>
      {/* Solo en el celular: oscurece lo de atrás y cierra al tocarlo. */}
      <div className="panel-lateral-fondo" onClick={onCerrar} aria-hidden="true" />
      <nav className="panel-lateral" aria-label={t.tusSalas}>
        <div className="panel-lateral-cab">
          <a className="panel-lateral-logo" href="#/inicio" onClick={onNavegar} title={t.comoFuncionaMenu}>
            <img src="/logo/multti-manos.svg" alt="" draggable={false} />
            <span>multti</span>
          </a>
          <button className="icono-btn" onClick={onCerrar} title={t.cerrarPanel} aria-label={t.cerrarPanel}>
            <IconoPanel />
          </button>
        </div>

        <button className="panel-nueva" onClick={onNuevaSala} disabled={creando}>
          <IconoMas tam={16} />
          {creando ? t.creandoSala : t.nuevaSala}
        </button>

        <a className="panel-link" href="#/explorar" onClick={onNavegar}>
          <IconoBrujula tam={16} />
          {t.explorarLink}
        </a>
        <a className="panel-link" href="#/inicio" onClick={onNavegar}>
          <IconoAyuda tam={16} />
          {t.comoFuncionaMenu}
        </a>

        <div className="panel-seccion">{t.tusSalas}</div>
        {/* Que la fila desaparezca no dice si se borró la sala o solo se quitó
            del menú. Este aviso lo confirma, y se va solo. */}
        {borrada && <p className="menu-borrada">{t.salaBorradaOk(borrada)}</p>}

        {salas.length === 0 ? (
          <p className="menu-vacio">{t.sinSalas}</p>
        ) : (
          <ul className="menu-lista">
            {salas.map((s) => (
              <li key={s.id} className={`menu-item${s.id === actual ? " actual" : ""}`}>
                <a
                  className="menu-link"
                  href={`#/sala/${s.id}`}
                  onClick={onNavegar}
                  aria-current={s.id === actual ? "page" : undefined}
                >
                  {/* El nombre manda, porque es lo que hace reconocible la
                      sala. El id se queda debajo: sigue siendo lo que va en
                      el link y lo que se dicta por teléfono. */}
                  <span className="menu-sala-id">{s.nombre || s.id}</span>
                  <span className="menu-sala-fecha">
                    {s.nombre ? `${s.id} · ` : ""}
                    {cuando(s.visitadaEn, idioma)}
                  </span>
                </a>
                <button
                  className="menu-olvidar"
                  title={t.borrarSala}
                  aria-label={`${t.borrarSala}: ${s.id}`}
                  disabled={borrando === s.id}
                  onClick={() => borrar(s.id)}
                >
                  {borrando === s.id ? "…" : "×"}
                </button>
              </li>
            ))}
          </ul>
        )}

        <a className="panel-link panel-pie" href="/acerca/">
          <IconoInfo tam={16} />
          {t.acercaDeMulti}
        </a>
      </nav>
    </>
  );
}

/**
 * Cuánto hace que entraste, en palabras.
 *
 * Una fecha exacta no dice nada útil aquí ("2 de agosto" no te ayuda a
 * reconocer una sala); "hace 10 min" sí.
 */
export function cuando(ms: number, idioma: string): string {
  const minutos = Math.floor((Date.now() - ms) / 60000);
  const rtf = new Intl.RelativeTimeFormat(idioma, { numeric: "auto" });

  if (minutos < 1) return rtf.format(0, "minute");
  if (minutos < 60) return rtf.format(-minutos, "minute");

  const horas = Math.floor(minutos / 60);
  if (horas < 24) return rtf.format(-horas, "hour");

  const dias = Math.floor(horas / 24);
  if (dias < 30) return rtf.format(-dias, "day");

  return rtf.format(-Math.floor(dias / 30), "month");
}
