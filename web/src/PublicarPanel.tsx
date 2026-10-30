import { useEffect, useRef, useState } from "react";
import { SERVER_URL, type EnLaComunidad } from "./socket.js";
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

/**
 * El nombre tal como va a quedar en la dirección: `nombre.pages.dev`.
 *
 * Lo mismo que hace `nombreDeApp` en el server (engine/publicar.ts), para que lo
 * que se ve mientras se escribe sea lo que va a salir. El server lo vuelve a
 * filtrar: esto es solo para enseñarlo.
 */
export function nombreDeApp(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 58)
    .replace(/-+$/g, "");
}

export function PublicarPanel({
  roomId,
  nombreDeSala,
  urlPublicada,
  publicando,
  puedePublicar,
  errorDeNombre,
  onPublicar,
  comunidad,
  autorSugerido,
  onCompartir,
  onQuitarDeComunidad,
}: {
  roomId: string | null;
  /** Con lo que arranca el campo del nombre: el nombre de la sala, o su id. */
  nombreDeSala: string | null;
  urlPublicada: string | null;
  publicando: "compilando" | "subiendo" | null;
  /** Si la sala tiene algo guardado que valga la pena subir. */
  puedePublicar: boolean;
  /** Por qué el server no aceptó el nombre, para decirlo junto al campo. */
  errorDeNombre: string | null;
  onPublicar: (nombre?: string) => void;
  /** Si ya está en la comunidad, y cómo. */
  comunidad: EnLaComunidad | null;
  /** Con qué nombre sale de entrada quien comparte: el suyo en la sala. */
  autorSugerido: string;
  /** Devuelve el error, o null si salió. */
  onCompartir: (autor: string) => Promise<string | null>;
  onQuitarDeComunidad: () => Promise<void>;
}) {
  const { t } = useTextos();
  const [abierto, setAbierto] = useState(false);
  const [copiado, setCopiado] = useState(false);
  /** Si está abierto el paso de confirmar antes de compartir con la comunidad. */
  const [confirmando, setConfirmando] = useState(false);
  const [autor, setAutor] = useState<string | null>(null);
  const [compartiendo, setCompartiendo] = useState(false);
  const [errorComunidad, setErrorComunidad] = useState<string | null>(null);

  const compartir = async () => {
    setCompartiendo(true);
    setErrorComunidad(null);
    const error = await onCompartir((autor ?? autorSugerido).trim());
    setCompartiendo(false);
    if (error) setErrorComunidad(error);
    else setConfirmando(false);
  };

  const quitar = async () => {
    if (!confirm(t.confirmarQuitarComunidad)) return;
    setCompartiendo(true);
    await onQuitarDeComunidad();
    setCompartiendo(false);
  };
  const cajaRef = useRef<HTMLDivElement>(null);
  /**
   * El nombre que se escribe, solo antes de la primera publicación: Cloudflare
   * no deja renombrar un proyecto, así que después el link se queda como está.
   * Null mientras nadie lo toca, y ahí se usa el de la sala.
   */
  const [escrito, setEscrito] = useState<string | null>(null);
  const sugerido = nombreDeApp(nombreDeSala ?? roomId ?? "");
  const nombre = escrito ?? sugerido;
  const direccion = nombreDeApp(nombre);

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
            <>
              <label className="publicar-nombre">
                <span>{t.publicarNombre}</span>
                <input
                  value={nombre}
                  onChange={(e) => setEscrito(e.target.value)}
                  maxLength={80}
                  placeholder={sugerido}
                  disabled={!!publicando}
                  spellCheck={false}
                  aria-invalid={!!errorDeNombre || !direccion}
                />
              </label>
              <p className={`publicar-direccion ${direccion ? "" : "mal"}`}>
                {direccion ? `${direccion}.pages.dev` : t.publicarNombreVacio}
              </p>
              {errorDeNombre && <p className="publicar-error">{errorDeNombre}</p>}
              <p className="publicar-nota">{t.publicarNombreNota}</p>
              <p className="publicar-nota">{t.publicarNota}</p>
            </>
          )}

          <button
            className="publicar-btn"
            onClick={() => onPublicar(urlPublicada ? undefined : direccion)}
            disabled={!puedePublicar || !!publicando || (!urlPublicada && !direccion)}
          >
            {publicando
              ? t.etapaDeploy[publicando]
              : urlPublicada
                ? t.republicar
                : t.publicar}
          </button>

          {urlPublicada && (
            <>
              {/* La comunidad: que salga en Explorar, para que cualquiera la
                  juegue y entre a construir. Solo si quien publica quiere, y
                  diciendo claro qué significa antes de hacerlo. */}
              <div className="comunidad">
                <div className="comunidad-estado">
                  <span className={`publicar-punto ${comunidad && !comunidad.oculta ? "vivo" : ""}`} aria-hidden="true" />
                  {comunidad ? (comunidad.oculta ? t.comunidadOculta : t.comunidadEstadoEn) : t.comunidadEstadoNo}
                </div>
                {comunidad ? (
                  <div className="comunidad-acciones">
                    <a href="#/explorar">{t.verEnExplorar}</a>
                    <button onClick={quitar} disabled={compartiendo}>
                      {t.quitarDeComunidad}
                    </button>
                  </div>
                ) : confirmando ? (
                  <div className="comunidad-form">
                    <p className="comunidad-categoria">
                      {t.comunidadCategoria}: <strong>{t.categoriaJuego}</strong>
                    </p>
                    <label className="publicar-nombre">
                      <span>{t.comunidadAutor}</span>
                      <input
                        value={autor ?? autorSugerido}
                        onChange={(e) => setAutor(e.target.value)}
                        maxLength={40}
                        disabled={compartiendo}
                        spellCheck={false}
                      />
                    </label>
                    <p className="publicar-nota">{t.comunidadAviso}</p>
                    {errorComunidad && <p className="publicar-error">{errorComunidad}</p>}
                    <div className="comunidad-acciones">
                      <button className="comunidad-confirmar" onClick={compartir} disabled={compartiendo}>
                        {compartiendo ? t.compartiendo : t.compartirConfirmar}
                      </button>
                      <button onClick={() => setConfirmando(false)} disabled={compartiendo}>
                        {t.cancelar}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button className="comunidad-compartir" onClick={() => setConfirmando(true)} disabled={!!publicando}>
                    {t.compartirConComunidad}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
