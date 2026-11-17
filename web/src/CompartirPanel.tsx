import { useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { AccesoDeLink, EstadoDeRol, Member, Rol } from "./socket.js";
import { useTextos } from "./i18n.js";

/**
 * Compartir la sala, y los roles.
 *
 * Los roles son opcionales: vienen apagados y la sala se comparte como
 * siempre, con un link y todos editando. Solo el dueño ve el panel; para los
 * demás el botón copia el link y ya, como antes.
 *
 * Prendidos, el dueño decide qué da el link (editar o solo ver), tiene un link
 * aparte para editar, y le cambia el rol a quien esté en la sala. Lo de cada
 * quien se guarda en el server: apagar y volver a prender no lo pierde.
 */
export function CompartirPanel({
  roomId,
  estado,
  members,
  yo,
  socket,
  conCuenta,
}: {
  roomId: string | null;
  estado: EstadoDeRol | null;
  members: Member[];
  yo: Member | null;
  socket: Socket | null;
  conCuenta: boolean;
}) {
  const { t } = useTextos();
  const [abierto, setAbierto] = useState(false);
  const [copiado, setCopiado] = useState<string | null>(null);
  const [correo, setCorreo] = useState("");
  const [rolInvitado, setRolInvitado] = useState<"editor" | "lector">("editor");
  const [errorInvitar, setErrorInvitar] = useState<string | null>(null);
  const cajaRef = useRef<HTMLDivElement>(null);
  const esDueno = estado?.rol === "dueno";

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
    if (!socket) return;
    const alFallar = ({ message }: { message: string }) => setErrorInvitar(message);
    socket.on("sala:invitar-error", alFallar);
    return () => {
      socket.off("sala:invitar-error", alFallar);
    };
  }, [socket]);

  useEffect(() => {
    if (!copiado) return;
    const id = setTimeout(() => setCopiado(null), 2000);
    return () => clearTimeout(id);
  }, [copiado]);

  const base = `${window.location.origin}${window.location.pathname}#/sala/${roomId ?? ""}`;

  const copiar = (que: string, texto: string) => {
    void navigator.clipboard.writeText(texto);
    setCopiado(que);
  };

  // Quien no es dueño: el botón de siempre, que copia el link.
  if (!esDueno) {
    return (
      <button
        className={`invitar ${copiado ? "copiado" : ""}`}
        onClick={() => copiar("boton", base)}
        disabled={!roomId}
      >
        {copiado ? t.copiado : t.copiarLink}
      </button>
    );
  }

  const activos = !!estado?.rolesActivos;
  const acceso: AccesoDeLink = estado?.acceso ?? "editar";

  // Una fila por persona y no por pestaña; sin el dueño, que no se cambia.
  const personas: Member[] = [];
  const vistas = new Set<string>();
  for (const m of members) {
    const clave = m.persona ?? m.socketId;
    if (m.rol === "dueno" || clave === yo?.persona || vistas.has(clave)) continue;
    vistas.add(clave);
    personas.push(m);
  }

  const nombreDeRol = (r: Rol) => (r === "dueno" ? t.rolDueno : r === "editor" ? t.rolEditor : t.rolLector);

  return (
    <div className="publicar-panel compartir-panel" ref={cajaRef}>
      <button
        className={`invitar ${abierto ? "activo" : ""}`}
        onClick={() => setAbierto((v) => !v)}
        aria-expanded={abierto}
      >
        {t.copiarLink}
      </button>
      {abierto && (
        <div className="publicar-caja compartir-caja">
          <div className="publicar-cab">{t.compartirTitulo}</div>

          {/* Con los roles prendidos se comparte invitando (o con el link que
              da lo que diga "Quien llega con el link puede"). Un link para
              copiar ahí al lado se leía como una tercera forma de invitar. */}
          {!activos && (
            <>
              <span className="compartir-etiqueta">{t.linkDeLaSala}</span>
              <div className="publicar-url">
                <span className="compartir-link">{base}</span>
                <button className="publicar-copiar" onClick={() => copiar("sala", base)}>
                  {copiado === "sala" ? t.copiado : t.copiar}
                </button>
              </div>
            </>
          )}

          <label className="compartir-switch">
            <span>
              <strong>{t.rolesTitulo}</strong>
              <small>{activos ? t.rolesPrendidos : t.rolesApagados}</small>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={activos}
              onChange={(e) => socket?.emit("sala:roles", { activos: e.target.checked })}
            />
          </label>

          {activos && (
            <>
              <span className="compartir-etiqueta">{t.elLinkDa}</span>
              <div className="switch-vista compartir-acceso" role="radiogroup" aria-label={t.elLinkDa}>
                {(["editar", "ver"] as const).map((a) => (
                  <button
                    key={a}
                    type="button"
                    className={`switch-op${acceso === a ? " activa" : ""}`}
                    aria-pressed={acceso === a}
                    onClick={() => socket?.emit("sala:acceso", { acceso: a })}
                  >
                    {a === "editar" ? t.accesoEditar : t.accesoVer}
                  </button>
                ))}
              </div>

              <span className="compartir-etiqueta">{t.invitarTitulo}</span>
              <form
                className="compartir-invitar"
                onSubmit={(e) => {
                  e.preventDefault();
                  const c = correo.trim();
                  if (!c) return;
                  setErrorInvitar(null);
                  socket?.emit("sala:invitar", { correo: c, rol: rolInvitado });
                  setCorreo("");
                }}
              >
                <input
                  type="email"
                  value={correo}
                  onChange={(e) => setCorreo(e.target.value)}
                  placeholder={t.invitarPlaceholder}
                  aria-label={t.invitarTitulo}
                />
                <select
                  value={rolInvitado}
                  onChange={(e) => setRolInvitado(e.target.value as "editor" | "lector")}
                  aria-label={t.rolesTitulo}
                >
                  <option value="editor">{t.rolEditor}</option>
                  <option value="lector">{t.rolLector}</option>
                </select>
                <button type="submit" disabled={!correo.trim()}>
                  {t.invitar}
                </button>
              </form>
              {errorInvitar && <p className="publicar-error">{errorInvitar}</p>}
              {(estado?.invitados?.length ?? 0) > 0 && (
                <ul className="compartir-personas">
                  {estado!.invitados!.map((i) => (
                    <li key={i.correo}>
                      <span className="compartir-nombre" title={i.correo}>
                        {i.correo}
                      </span>
                      <select
                        value={i.rol}
                        aria-label={`${t.rolesTitulo}: ${i.correo}`}
                        onChange={(e) => socket?.emit("sala:invitar", { correo: i.correo, rol: e.target.value })}
                      >
                        <option value="editor">{t.rolEditor}</option>
                        <option value="lector">{t.rolLector}</option>
                      </select>
                      <button
                        className="compartir-mini"
                        onClick={() => socket?.emit("sala:invitar", { correo: i.correo, rol: null })}
                      >
                        {t.quitarInvitado}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="publicar-nota">{t.invitarNota}</p>

              <span className="compartir-etiqueta">{t.personasEnSala}</span>
              {personas.length === 0 ? (
                <p className="publicar-nota">{t.nadieMas}</p>
              ) : (
                <ul className="compartir-personas">
                  {personas.map((m) => (
                    <li key={m.persona ?? m.socketId}>
                      <span className="compartir-punto" style={{ background: m.color }} aria-hidden="true" />
                      <span className="compartir-nombre">{m.name}</span>
                      <select
                        value={m.rol ?? "editor"}
                        aria-label={`${t.rolesTitulo}: ${m.name}`}
                        onChange={(e) => socket?.emit("sala:rol", { socketId: m.socketId, rol: e.target.value })}
                      >
                        {(["editor", "lector"] as const).map((r) => (
                          <option key={r} value={r}>
                            {nombreDeRol(r)}
                          </option>
                        ))}
                      </select>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {!conCuenta && <p className="publicar-nota compartir-aviso">{t.duenoSinCuenta}</p>}
        </div>
      )}
    </div>
  );
}
