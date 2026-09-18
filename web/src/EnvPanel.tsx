import { useEffect, useRef, useState } from "react";
import { SERVER_URL } from "./socket.js";
import { useTextos } from "./i18n.js";

/**
 * Las variables de entorno del proyecto de la sala: su `.env`.
 *
 * Aquí va lo que la app necesita para hablar con algo de fuera: la base de datos
 * de alguien, la key de un proveedor si la app usa IA, un token de pagos. Multi
 * no sabe qué significan; las escribe y el proyecto (y el agente) las leen.
 *
 * Por qué un panel y no el chat: el chat se guarda, se le muestra a todos y se
 * manda al modelo, así que una credencial dictada ahí queda escrita para
 * siempre. Esto va directo al `.env` del workspace, que el .gitignore excluye.
 *
 * Son de la SALA, no tuyas. A diferencia de tu API key (que es personal y vive
 * en este navegador), estas las usa el proyecto entero: quien entre trabaja
 * contra la misma base. Y el agente las puede leer, porque el proyecto necesita
 * conectarse. El panel lo dice, para que nadie meta aquí algo que no quiera
 * compartir con la sala.
 */

interface Variable {
  nombre: string;
  valor: string;
}

/** Por dónde va la conexión con Supabase, tal como la ve el panel. */
export interface EstadoSupabase {
  /** Quien corre este Multi configuró la integración. Si no, no se ofrece nada. */
  configurado: boolean;
  /** El proyecto de esta sala, o null si todavía no hay. */
  proyecto: string | null;
  /** Qué está pasando ahora mismo, si es que algo. */
  etapa?: "creando" | "levantando" | "protegiendo" | null;
  segundos?: number;
  /**
   * La contraseña de la base, y SOLO durante la sesión en que se creó.
   *
   * Supabase no la devuelve por su API, así que este es el único momento en que
   * alguien la puede copiar. No se guarda en el navegador a propósito: si se
   * pierde, se resetea desde el panel de Supabase, que es mejor que dejarla
   * tirada en un localStorage.
   */
  password?: string | null;
  error?: string | null;
}

export function EnvPanel({
  roomId,
  supabase,
  onConectarSupabase,
  onDesconectarSupabase,
}: {
  roomId: string;
  supabase: EstadoSupabase;
  onConectarSupabase: () => void;
  onDesconectarSupabase: () => void;
}) {
  const { t } = useTextos();
  const [abierto, setAbierto] = useState(false);
  const [vars, setVars] = useState<Variable[]>([]);
  const [guardando, setGuardando] = useState(false);
  const [guardado, setGuardado] = useState(false);
  /**
   * Qué valores están a la vista, por índice de fila.
   *
   * Se enmascara lo que se leyó del server, no lo que se está escribiendo: si
   * ocultara mientras alguien pega una credencial, no habría manera de
   * comprobar que se pegó completa, que es justo cuando más importa verla.
   */
  const [visibles, setVisibles] = useState<Set<number>>(new Set());
  const cajaRef = useRef<HTMLDivElement>(null);

  // Se leen al abrir y no al montar: son de la sala, así que pueden haber
  // cambiado por otra persona desde la última vez.
  useEffect(() => {
    if (!abierto) return;
    // Cada apertura empieza tapada, aunque la vez pasada se hubiera revelado.
    setVisibles(new Set());
    fetch(`${SERVER_URL}/rooms/${roomId}/env`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { variables: Variable[] } | null) => d && setVars(d.variables))
      .catch(() => {
        // Sin respuesta se abre vacío: se puede escribir igual, y guardar dirá
        // si el server no está.
      });
  }, [abierto, roomId]);

  // Cerrar al hacer click fuera o con Escape, como cualquier panel.
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

  const cambiar = (i: number, campo: keyof Variable, valor: string) => {
    setVars((prev) => prev.map((v, j) => (j === i ? { ...v, [campo]: valor } : v)));
    setGuardado(false);
  };

  const quitar = (i: number) => {
    setVars((prev) => prev.filter((_, j) => j !== i));
    // Las filas se identifican por posición, así que borrar una corre a las de
    // abajo: sin esto, tapar la 2 acabaría destapando la 3.
    setVisibles((prev) => {
      const s = new Set<number>();
      for (const j of prev) {
        if (j < i) s.add(j);
        else if (j > i) s.add(j - 1);
      }
      return s;
    });
    setGuardado(false);
  };

  const agregar = () => {
    setVars((prev) => {
      // La fila nueva nace a la vista: es la que se está por escribir.
      setVisibles((v) => new Set(v).add(prev.length));
      return [...prev, { nombre: "", valor: "" }];
    });
    setGuardado(false);
  };

  const alternarVisible = (i: number) => {
    setVisibles((prev) => {
      const s = new Set(prev);
      if (!s.delete(i)) s.add(i);
      return s;
    });
  };

  const guardar = async () => {
    setGuardando(true);
    try {
      // Las filas en blanco no se mandan: son las que quedan al darle a "agregar"
      // y arrepentirse, y no tiene sentido escribirlas en el archivo.
      const limpias = vars.filter((v) => v.nombre.trim());
      const r = await fetch(`${SERVER_URL}/rooms/${roomId}/env`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ variables: limpias }),
      });
      if (!r.ok) throw new Error(String(r.status));
      const d = (await r.json()) as { variables: Variable[] };
      // Se pinta lo que el server dejó, no lo que se escribió: si descartó un
      // nombre inválido, hay que verlo aquí y no descubrirlo cuando la app falle.
      setVars(d.variables);
      // Ya guardadas, se tapan: dejarlas a la vista es lo que acaba en una
      // pantalla compartida un rato después.
      setVisibles(new Set());
      setGuardado(true);
    } catch (e) {
      alert(t.envNoSePudo + String(e));
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="env-panel" ref={cajaRef}>
      <button className="invitar" onClick={() => setAbierto((v) => !v)} title={t.envTitulo}>
        {t.envBoton}
      </button>

      {abierto && (
        <div className="env-caja">
          <div className="env-cab">{t.envTitulo}</div>
          <p className="env-nota">{t.envNota}</p>

          {vars.length === 0 && <p className="env-vacio">{t.envVacio}</p>}

          {vars.map((v, i) => (
            <div key={i} className="env-fila">
              <input
                className="env-nombre"
                placeholder={t.envNombre}
                value={v.nombre}
                onChange={(e) => cambiar(i, "nombre", e.target.value)}
                spellCheck={false}
              />
              <input
                className="env-valor"
                type={visibles.has(i) ? "text" : "password"}
                placeholder={t.envValor}
                value={v.valor}
                onChange={(e) => cambiar(i, "valor", e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
              <button
                className="env-ojo"
                onClick={() => alternarVisible(i)}
                title={visibles.has(i) ? t.envOcultar : t.envVer}
                aria-label={`${visibles.has(i) ? t.envOcultar : t.envVer}: ${v.nombre}`}
              >
                {visibles.has(i) ? <IconoOjoTachado /> : <IconoOjo />}
              </button>
              <button
                className="env-quitar"
                onClick={() => quitar(i)}
                title={t.envQuitar}
                aria-label={`${t.envQuitar}: ${v.nombre}`}
              >
                ×
              </button>
            </div>
          ))}

          <div className="env-acciones">
            <button className="env-agregar" onClick={agregar}>
              {t.envAgregar}
            </button>
            <button className="env-guardar" onClick={guardar} disabled={guardando}>
              {guardando ? t.envGuardando : guardado ? t.envGuardado : t.guardar}
            </button>
          </div>

          {/* El proyecto lee el .env al arrancar, así que un cambio no se nota
              hasta que el dev server se reinicia. Decirlo evita el rato de creer
              que la variable no se guardó. */}
          {guardado && <p className="env-reinicio">{t.envReinicio}</p>}

          {/* Supabase va aquí abajo y no en su propio panel: quien viene a
              buscar cómo conectar una base entra por Variables, que es donde el
              agente le dijo que mirara. Si quien hospeda este Multi no lo
              configuró, no existe: igual que el botón de entrar con cuenta. */}
          {supabase.configurado && (
            <div className="env-supabase">
              <div className="env-cab">{t.sbTitulo}</div>

              {supabase.etapa ? (
                <p className="env-nota">
                  {supabase.etapa === "creando" && t.sbCreando}
                  {supabase.etapa === "levantando" && t.sbLevantando}
                  {supabase.etapa === "protegiendo" && t.sbProtegiendo}
                  {/* Los segundos solo aparecen en la espera larga, que es la
                      que hace dudar de si sigue vivo. */}
                  {supabase.etapa === "levantando" && supabase.segundos
                    ? ` (${supabase.segundos}s)`
                    : ""}
                </p>
              ) : supabase.proyecto ? (
                <>
                  <p className="env-nota">{t.sbConectado(supabase.proyecto)}</p>
                  <div className="env-acciones">
                    <button className="env-quitar-sb" onClick={onDesconectarSupabase}>
                      {t.sbDesconectar}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="env-nota">{t.sbNota}</p>
                  <div className="env-acciones">
                    <button className="env-guardar" onClick={onConectarSupabase}>
                      {t.sbConectar}
                    </button>
                  </div>
                </>
              )}

              {/* La contraseña se enseña una vez y ya: Supabase no la devuelve
                  nunca por su API, así que este es el único momento en que se
                  puede copiar. */}
              {supabase.password && (
                <div className="env-password">
                  <p className="env-nota">{t.sbPassword}</p>
                  <input readOnly value={supabase.password} onFocus={(e) => e.target.select()} />
                </div>
              )}

              {supabase.error && <p className="env-error">{supabase.error}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* Dibujados a mano y no traídos de una librería de iconos: son dos, y el panel
   no usa ninguna. */
function IconoOjo() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function IconoOjoTachado() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}
