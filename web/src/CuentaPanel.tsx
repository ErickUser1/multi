import { useState } from "react";
import { useTextos } from "./i18n";
import { entrarConGoogle, salir, type Usuario } from "./cuenta";

/**
 * El botón de cuenta de la barra.
 *
 * Es discreto a propósito: tener cuenta es opcional y no es lo que trae a nadie
 * a Multi. Quien no la quiera no debería sentir que le falta algo, y por eso el
 * chip sin sesión no dice "regístrate" ni pone un contador de nada.
 *
 * Si quien hospeda este Multi no configuró el inicio de sesión, el botón
 * directamente no existe: no tiene sentido ofrecer algo que va a fallar.
 */
export function CuentaPanel(props: { usuario: Usuario | null; configurado: boolean }) {
  const { t } = useTextos();
  const [abierto, setAbierto] = useState(false);

  if (!props.configurado) return null;

  if (!abierto) {
    return (
      <button
        className={`key-chip ${props.usuario ? "listo" : ""}`}
        onClick={() => setAbierto(true)}
        title={props.usuario ? props.usuario.correo : t.cuentaNota}
      >
        {props.usuario ? (
          <>
            {props.usuario.foto ? (
              <img className="cuenta-foto" src={props.usuario.foto} alt="" />
            ) : null}
            {props.usuario.nombre.split(" ")[0]}
          </>
        ) : (
          t.miCuenta
        )}
      </button>
    );
  }

  return (
    <div className="key-panel">
      <div className="key-cab">
        <span>{t.miCuenta}</span>
        <button className="key-x" onClick={() => setAbierto(false)}>
          {t.cerrar}
        </button>
      </div>

      {props.usuario ? (
        <>
          <div className="key-puesta">
            <div className="key-puesta-info">
              {props.usuario.foto ? (
                <img className="cuenta-foto-grande" src={props.usuario.foto} alt="" />
              ) : null}
              <code>{props.usuario.nombre}</code>
              <span className="key-puesta-modelo">{props.usuario.correo}</span>
            </div>
            <button
              className="key-olvidar"
              onClick={() => {
                // Recargar y no solo limpiar el estado: la sesión vive en una
                // cookie que este código no puede tocar, así que quien manda
                // sobre quién eres es el server. Volver a preguntarle es lo
                // único que deja las dos partes de acuerdo.
                void salir().then(() => window.location.reload());
              }}
            >
              {t.cerrarSesion}
            </button>
          </div>
          <p className="key-nota">{t.salasGuardadas}</p>
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
