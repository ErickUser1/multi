import { useEffect, useRef, useState } from "react";
import { SERVER_URL } from "./socket.js";
import { useTextos } from "./i18n.js";

/**
 * Publicar la app de la sala, y dónde quedó.
 *
 * Un panel y no solo un botón porque el link es un DATO de la sala, no una
 * noticia: antes salía en el chat y al día siguiente estaba enterrado entre los
 * mensajes, así que nadie sabía si su sala seguía en vivo ni dónde verla.
 *
 * Aquí se abre cuando haga falta y siempre dice lo mismo: si está publicada,
 * dónde, y el botón para volver a subir lo último.
 */

export function PublicarPanel({
  roomId,
  urlPublicada,
  publicando,
  puedePublicar,
  onPublicar,
}: {
  roomId: string | null;
  urlPublicada: string | null;
  publicando: "compilando" | "subiendo" | null;
  /** Si la sala tiene algo guardado que valga la pena subir. */
  puedePublicar: boolean;
  onPublicar: () => void;
}) {
  const { t } = useTextos();
  const [abierto, setAbierto] = useState(false);
  const [copiado, setCopiado] = useState(false);
  const cajaRef = useRef<HTMLDivElement>(null);

  // Cerrar al hacer click fuera o con Escape, como los demás paneles.
  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: MouseEvent) => {
      if (cajaRef.current && !cajaRef.current.contains(e.target as Node)) setAbierto(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setAbierto(false);
    document.addEventListener("mousedown", fuera);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", fuera);
      document.removeEventListener("keydown", esc);
    };
  }, [abierto]);

  useEffect(() => {
    if (!copiado) return;
    const id = setTimeout(() => setCopiado(false), 2000);
    return () => clearTimeout(id);
  }, [copiado]);

  const copiar = () => {
    if (!urlPublicada) return;
    void navigator.clipboard.writeText(urlPublicada);
    setCopiado(true);
  };

  return (
    <div className="publicar-panel" ref={cajaRef}>
      {/* El botón dice el estado, no solo la acción: de un vistazo se sabe si la
          sala está en vivo sin tener que abrir nada. */}
      <button
        className={`invitar ${urlPublicada ? "publicada" : ""}`}
        onClick={() => setAbierto((v) => !v)}
        disabled={!roomId}
        title={t.publicarTitulo}
      >
        {publicando ? t.etapaDeploy[publicando] : urlPublicada ? t.enVivo : t.publicar}
      </button>

      {abierto && (
        <div className="publicar-caja">
          <div className="publicar-cab">
            <span className={`publicar-punto ${urlPublicada ? "vivo" : ""}`} aria-hidden="true" />
            {urlPublicada ? t.publicadaTitulo : t.sinPublicarTitulo}
          </div>

          {urlPublicada ? (
            <>
              <div className="publicar-url">
                <a href={urlPublicada} target="_blank" rel="noreferrer">
                  {urlPublicada.replace(/^https:\/\//, "")}
                </a>
                <button className="publicar-copiar" onClick={copiar}>
                  {copiado ? t.copiado : t.copiarLink}
                </button>
              </div>
              {/* Lo mismo que dice Lovable, y por lo mismo: la gente supone que
                  lo que ve en el preview ya está afuera, y no lo está. */}
              <p className="publicar-nota">{t.publicarNotaViva}</p>
            </>
          ) : (
            <p className="publicar-nota">{t.publicarNota}</p>
          )}

          <button
            className="publicar-btn"
            onClick={onPublicar}
            disabled={!puedePublicar || !!publicando}
          >
            {publicando
              ? t.etapaDeploy[publicando]
              : urlPublicada
                ? t.republicar
                : t.publicar}
          </button>
        </div>
      )}
    </div>
  );
}
