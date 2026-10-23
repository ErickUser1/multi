import { useEffect, useRef, useState } from "react";
import type { Textos } from "./i18n";

/**
 * Las versiones de un proyecto: el original y sus remixes.
 *
 * Por dentro cada remix es una sala aparte (ver createRemix en el server): así
 * el original sigue intacto mientras alguien experimenta, y nadie le cambia la
 * vista previa a los demás. Aquí se ve como lo que es para quien lo usa: una
 * versión del mismo proyecto, con un "Volver al original" y una lista para
 * brincar entre remixes.
 */

export interface RemixDeSala {
  id: string;
  nombre: string | null;
  createdAt: number;
}

export interface OrigenDeSala {
  id: string;
  nombre: string | null;
}

const irA = (id: string) => {
  window.location.hash = `#/sala/${id}`;
};

/** La línea bajo el nombre de la sala: de qué es remix, y sus remixes. */
export function VersionesSala({
  origen,
  remixes,
  t,
}: {
  origen: OrigenDeSala | null;
  remixes: RemixDeSala[];
  t: Textos;
}) {
  const [abierta, setAbierta] = useState(false);
  const cajaRef = useRef<HTMLDivElement>(null);

  // Cerrar al hacer click fuera o con Escape, como los demás paneles.
  useEffect(() => {
    if (!abierta) return;
    const fuera = (e: MouseEvent) => {
      if (cajaRef.current && !cajaRef.current.contains(e.target as Node)) setAbierta(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setAbierta(false);
    document.addEventListener("mousedown", fuera);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", fuera);
      document.removeEventListener("keydown", esc);
    };
  }, [abierta]);

  if (!origen && remixes.length === 0) return null;

  return (
    <div className="versiones">
      {origen && (
        <span className="versiones-origen">
          {t.remixDe(origen.nombre ?? origen.id)}
          <button className="versiones-volver" onClick={() => irA(origen.id)}>
            {t.volverAlOriginal}
          </button>
        </span>
      )}
      {remixes.length > 0 && (
        <div className="versiones-lista" ref={cajaRef}>
          <button className="versiones-boton" onClick={() => setAbierta((v) => !v)} aria-expanded={abierta}>
            {t.remixes(remixes.length)} <span aria-hidden="true">▾</span>
          </button>
          {abierta && (
            <ul className="versiones-menu">
              {remixes.map((r) => (
                <li key={r.id}>
                  <button
                    onClick={() => {
                      setAbierta(false);
                      irA(r.id);
                    }}
                  >
                    <span className="versiones-nombre">{r.nombre ?? r.id}</span>
                    <span className="versiones-fecha">
                      {new Date(r.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
