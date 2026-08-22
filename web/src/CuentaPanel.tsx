import { useRef, useState } from "react";
import { useTextos } from "./i18n";
import {
  cambiarFoto,
  cambiarNombre,
  entrarConGoogle,
  salir,
  urlDeFoto,
  type Usuario,
} from "./cuenta";
import { prepararImagen, ACEPTADOS, esImagenAceptada } from "./imagenes";

/**
 * El botón de cuenta de la barra, que con sesión es tu perfil.
 *
 * Sin sesión es discreto a propósito: tener cuenta es opcional y no es lo que
 * trae a nadie a Multi, así que el chip no dice "regístrate" ni pone insignias.
 * Con sesión se convierte en tu cara, y al abrirlo puedes cambiar tu nombre y
 * tu foto.
 *
 * Si quien hospeda este Multi no configuró el inicio de sesión, el botón
 * directamente no existe: no tiene sentido ofrecer algo que va a fallar.
 */
export function CuentaPanel(props: {
  usuario: Usuario | null;
  configurado: boolean;
  onCambio: (u: Usuario) => void;
}) {
  const { t } = useTextos();
  const [abierto, setAbierto] = useState(false);
  /**
   * Lo escrito en el input, o `null` si nadie lo ha tocado y vale el del perfil.
   *
   * No se arranca con `useState(props.usuario?.nombre)`: eso se evalúa al montar
   * el panel, y para entonces la cuenta todavía no ha llegado del server. El
   * campo se quedaba vacío para siempre aunque el perfil sí tuviera nombre.
   */
  const [escrito, setEscrito] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const archivoRef = useRef<HTMLInputElement | null>(null);
  const nombre = escrito ?? props.usuario?.nombre ?? "";

  if (!props.configurado) return null;

  const foto = urlDeFoto(props.usuario?.foto);

  const guardarNombre = async () => {
    const limpio = nombre.trim();
    if (!limpio || limpio === props.usuario?.nombre) return;
    setGuardando(true);
    const actualizado = await cambiarNombre(limpio);
    setGuardando(false);
    if (actualizado) {
      props.onCambio(actualizado);
      // Se suelta lo escrito para que el input vuelva a reflejar el perfil.
      setEscrito(null);
    }
  };

  const elegirFoto = async (archivo: File | undefined) => {
    if (!archivo) return;
    if (!esImagenAceptada(archivo)) {
      setError(t.fotoFormato);
      return;
    }
    setError(null);
    setGuardando(true);
    // Se reduce en el navegador antes de subirla: una foto de cámara son varios
    // MB para pintarse a 34 píxeles, y el server la rechazaría por tamaño.
    const lista = await prepararImagen(archivo, { lado: 256 });
    const res = await cambiarFoto(lista.mediaType, lista.data);
    setGuardando(false);
    if ("error" in res) setError(res.error);
    else props.onCambio(res.usuario);
  };

  if (!abierto) {
    return (
      <button
        className={`key-chip ${props.usuario ? "listo" : ""}`}
        onClick={() => setAbierto(true)}
        title={props.usuario ? props.usuario.correo : t.cuentaNota}
      >
        {props.usuario ? (
          <>
            {foto ? <img className="cuenta-foto" src={foto} alt="" /> : null}
            {props.usuario.nombre.split(" ")[0]}
          </>
        ) : (
          t.entrar
        )}
      </button>
    );
  }

  return (
    <div className="key-panel">
      <div className="key-cab">
        <span>{props.usuario ? t.miPerfil : t.entrar}</span>
        <button className="key-x" onClick={() => setAbierto(false)}>
          {t.cerrar}
        </button>
      </div>

      {props.usuario ? (
        <>
          <div className="perfil-foto-fila">
            {foto ? (
              <img className="cuenta-foto-grande" src={foto} alt="" />
            ) : (
              <div className="cuenta-foto-grande cuenta-sin-foto">
                {props.usuario.nombre.slice(0, 1).toUpperCase()}
              </div>
            )}
            <button
              className="key-olvidar"
              disabled={guardando}
              onClick={() => archivoRef.current?.click()}
            >
              {t.cambiarFoto}
            </button>
            <input
              ref={archivoRef}
              type="file"
              accept={ACEPTADOS.join(",")}
              style={{ display: "none" }}
              onChange={(e) => {
                void elegirFoto(e.target.files?.[0]);
                // Se limpia para que elegir el MISMO archivo otra vez vuelva a
                // disparar el evento.
                e.target.value = "";
              }}
            />
          </div>

          <div className="perfil-nombre">
            <input
              className="name-input"
              value={nombre}
              maxLength={40}
              disabled={guardando}
              onChange={(e) => setEscrito(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void guardarNombre();
              }}
            />
            <button
              className="perfil-guardar"
              disabled={guardando || !nombre.trim() || nombre.trim() === props.usuario.nombre}
              onClick={() => void guardarNombre()}
            >
              {t.guardar}
            </button>
          </div>

          {error ? <p className="key-nota key-error">{error}</p> : null}
          <p className="key-nota">{props.usuario.correo}</p>

          <button
            className="key-olvidar perfil-salir"
            onClick={() => {
              // Recargar y no solo limpiar el estado: la sesión vive en una
              // cookie que este código no puede tocar, así que quien manda sobre
              // quién eres es el server. Volver a preguntarle es lo único que
              // deja a las dos partes de acuerdo.
              void salir().then(() => window.location.reload());
            }}
          >
            {t.cerrarSesion}
          </button>
        </>
      ) : (
        <>
          <p className="key-nota">{t.cuentaNota}</p>
          <button className="key-guardar" onClick={entrarConGoogle}>
            {t.entrarConGoogle}
          </button>
        </>
      )}
    </div>
  );
}
