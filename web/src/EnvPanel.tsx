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

export function EnvPanel({ roomId }: { roomId: string }) {
  const { t } = useTextos();
  const [abierto, setAbierto] = useState(false);
  const [vars, setVars] = useState<Variable[]>([]);
  const [guardando, setGuardando] = useState(false);
  const [guardado, setGuardado] = useState(false);
  const cajaRef = useRef<HTMLDivElement>(null);

  // Se leen al abrir y no al montar: son de la sala, así que pueden haber
  // cambiado por otra persona desde la última vez.
  useEffect(() => {
    if (!abierto) return;
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
    setGuardado(false);
  };

  const agregar = () => {
    setVars((prev) => [...prev, { nombre: "", valor: "" }]);
    setGuardado(false);
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
                placeholder={t.envValor}
                value={v.valor}
                onChange={(e) => cambiar(i, "valor", e.target.value)}
                spellCheck={false}
              />
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
        </div>
      )}
    </div>
  );
}
