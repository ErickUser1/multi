import { useEffect, useState } from "react";
import type * as Y from "yjs";
import { leerGrafica, graficaSvg, type Grafica } from "./grafica";
import { useTextos } from "../i18n";

interface Objeto {
  tipo: "grafica" | "diagrama";
  fuente: string;
}

/**
 * Los datos de una gráfica, como tabla: etiquetas en filas, series en columnas.
 *
 * Escribe directo en el mapa de objetos del Y.Doc: cada celda que cambias le
 * llega a todos y la gráfica se redibuja para la sala entera, sin "guardar".
 * Si otro cambia los datos mientras está abierto, la tabla se actualiza.
 */
export function EditorDeGrafica({ objetos, ref_, alCerrar }: { objetos: Y.Map<Objeto>; ref_: string; alCerrar: () => void }) {
  const { t } = useTextos();
  const leer = (): Grafica =>
    leerGrafica(objetos.get(ref_)?.fuente ?? "") ?? {
      tipo: "barras",
      titulo: "",
      etiquetas: ["A", "B"],
      series: [{ nombre: "Serie 1", datos: [0, 0] }],
    };
  const [g, setG] = useState<Grafica>(leer);

  useEffect(() => {
    const alCambiar = (e: Y.YMapEvent<Objeto>) => {
      if (e.keysChanged.has(ref_) && !e.transaction.local) setG(leer());
    };
    objetos.observe(alCambiar);
    return () => objetos.unobserve(alCambiar);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objetos, ref_]);

  const guardar = (nueva: Grafica) => {
    setG(nueva);
    objetos.set(ref_, { tipo: "grafica", fuente: JSON.stringify(nueva) });
  };
  const filas = g.etiquetas.length;

  const celda = (s: number, i: number, valor: string) => {
    const series = g.series.map((x, k) =>
      k === s ? { ...x, datos: Array.from({ length: filas }, (_, j) => (j === i ? Number(valor) || 0 : x.datos[j] ?? 0)) } : x,
    );
    guardar({ ...g, series });
  };

  return (
    <div className="doc-dialogo" role="dialog" aria-label={t.docDatosGrafica}>
      <div className="doc-dialogo-caja">
        <div className="doc-dialogo-cab">
          <strong>{t.docDatosGrafica}</strong>
          <button type="button" className="doc-boton" onClick={alCerrar}>
            {t.docListo}
          </button>
        </div>
        <div className="doc-grafica-campos">
          <label>
            {t.docTipoGrafica}
            <select value={g.tipo} onChange={(e) => guardar({ ...g, tipo: e.target.value as Grafica["tipo"] })}>
              <option value="barras">{t.docBarras}</option>
              <option value="lineas">{t.docLineas}</option>
              <option value="pastel">{t.docPastel}</option>
            </select>
          </label>
          <label>
            {t.docTituloGrafica}
            <input value={g.titulo ?? ""} onChange={(e) => guardar({ ...g, titulo: e.target.value })} />
          </label>
        </div>
        <div className="doc-grafica-tabla">
          <table>
            <thead>
              <tr>
                <th />
                {g.series.map((s, k) => (
                  <th key={k}>
                    <input
                      value={s.nombre ?? ""}
                      aria-label={t.docNombreSerie}
                      onChange={(e) =>
                        guardar({ ...g, series: g.series.map((x, j) => (j === k ? { ...x, nombre: e.target.value } : x)) })
                      }
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {g.etiquetas.map((et, i) => (
                <tr key={i}>
                  <th>
                    <input
                      value={et}
                      aria-label={t.docEtiqueta}
                      onChange={(e) => guardar({ ...g, etiquetas: g.etiquetas.map((x, j) => (j === i ? e.target.value : x)) })}
                    />
                  </th>
                  {g.series.map((s, k) => (
                    <td key={k}>
                      <input
                        inputMode="decimal"
                        value={String(s.datos[i] ?? 0)}
                        onChange={(e) => celda(k, i, e.target.value)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="doc-grafica-acciones">
          <button
            type="button"
            className="doc-boton"
            onClick={() =>
              guardar({
                ...g,
                etiquetas: [...g.etiquetas, String.fromCharCode(65 + (filas % 26))],
                series: g.series.map((s) => ({ ...s, datos: [...s.datos.slice(0, filas), 0] })),
              })
            }
          >
            {t.docAgregarFila}
          </button>
          <button
            type="button"
            className="doc-boton"
            disabled={filas <= 1}
            onClick={() =>
              guardar({ ...g, etiquetas: g.etiquetas.slice(0, -1), series: g.series.map((s) => ({ ...s, datos: s.datos.slice(0, filas - 1) })) })
            }
          >
            {t.docQuitarFila}
          </button>
          {g.tipo !== "pastel" && (
            <>
              <button
                type="button"
                className="doc-boton"
                onClick={() => guardar({ ...g, series: [...g.series, { nombre: `Serie ${g.series.length + 1}`, datos: g.etiquetas.map(() => 0) }] })}
              >
                {t.docAgregarSerie}
              </button>
              <button
                type="button"
                className="doc-boton"
                disabled={g.series.length <= 1}
                onClick={() => guardar({ ...g, series: g.series.slice(0, -1) })}
              >
                {t.docQuitarSerie}
              </button>
            </>
          )}
        </div>
        <figure className="doc-grafica doc-grafica-previa" dangerouslySetInnerHTML={{ __html: graficaSvg(JSON.stringify(g)) ?? "" }} />
      </div>
    </div>
  );
}
