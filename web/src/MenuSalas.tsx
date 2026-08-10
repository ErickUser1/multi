import { useEffect, useRef, useState } from "react";
import { salasVisitadas, olvidarSala, type SalaVisitada } from "./historial-salas.js";
import { createRoom } from "./socket.js";
import { useTextos } from "./i18n.js";

/**
 * El menú de salas: dónde has estado.
 *
 * Va arriba a la izquierda, encima del nombre de la sala, porque es navegación
 * y no una acción de la sala. La lista NO separa "mías" de "compartidas
 * conmigo": esa distinción se borra sola en cuanto invitas a alguien o alguien
 * te invita, y sin login no hay forma de saber quién creó qué. Lo que sí
 * distingue es cuándo entraste, y por eso van ordenadas por eso.
 */
export function MenuSalas({ actual }: { actual?: string }) {
  const { t, idioma } = useTextos();
  const [abierto, setAbierto] = useState(false);
  const [salas, setSalas] = useState<SalaVisitada[]>([]);
  const [creando, setCreando] = useState(false);
  const cajaRef = useRef<HTMLDivElement>(null);

  const crearOtra = async () => {
    setCreando(true);
    try {
      const id = await createRoom();
      window.location.hash = `#/sala/${id}`;
      setAbierto(false);
    } catch (e) {
      // Sin sala nueva el menú se queda como estaba, que es un sitio válido:
      // las salas de siempre siguen ahí y se puede volver a intentar.
      alert(t.noSePudoCrear + String(e));
    } finally {
      setCreando(false);
    }
  };

  // Se lee al abrir, no al montar: así refleja lo que haya pasado en otra
  // pestaña sin tener que escuchar el evento `storage`.
  useEffect(() => {
    if (abierto) setSalas(salasVisitadas());
  }, [abierto]);

  // Cerrar al hacer click fuera o con Escape, como cualquier menú.
  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: MouseEvent) => {
      if (cajaRef.current && !cajaRef.current.contains(e.target as Node)) setAbierto(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAbierto(false);
    };
    document.addEventListener("mousedown", fuera);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", fuera);
      document.removeEventListener("keydown", escape);
    };
  }, [abierto]);

  const otras = salas.filter((s) => s.id !== actual);

  return (
    <div className="menu-salas" ref={cajaRef}>
      <button
        className="menu-btn"
        onClick={() => setAbierto((v) => !v)}
        title={t.tusSalas}
        aria-label={t.tusSalas}
        aria-expanded={abierto}
      >
        <span className="menu-icono" aria-hidden="true" />
      </button>

      {abierto && (
        <div className="menu-panel">
          <div className="menu-cab">{t.tusSalas}</div>

          {otras.length === 0 ? (
            <p className="menu-vacio">{t.sinOtrasSalas}</p>
          ) : (
            <ul className="menu-lista">
              {otras.map((s) => (
                <li key={s.id} className="menu-item">
                  <a className="menu-link" href={`#/sala/${s.id}`} onClick={() => setAbierto(false)}>
                    <span className="menu-sala-id">{s.id}</span>
                    <span className="menu-sala-fecha">{cuando(s.visitadaEn, idioma)}</span>
                  </a>
                  <button
                    className="menu-olvidar"
                    title={t.quitarDeLaLista}
                    aria-label={`${t.quitarDeLaLista}: ${s.id}`}
                    onClick={() => {
                      olvidarSala(s.id);
                      setSalas(salasVisitadas());
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/*
            Crea la sala aquí mismo, no manda al inicio.

            Era un enlace a `#/`, así que "crear otra sala" te dejaba frente a
            otro botón de crear sala: la acción prometida ocurría un click
            después. Se notaba poco cuando de por medio estaba la pantalla del
            nombre; en cuanto esa dejó de aparecer, el rodeo quedó a la vista.
          */}
          <button className="menu-nueva" onClick={crearOtra} disabled={creando}>
            {creando ? t.creandoSala : t.crearOtraSala}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Cuánto hace que entraste, en palabras.
 *
 * Una fecha exacta no dice nada útil aquí ("2 de agosto" no te ayuda a
 * reconocer una sala); "hace 10 min" sí.
 */
function cuando(ms: number, idioma: string): string {
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
