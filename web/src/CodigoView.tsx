import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import python from "highlight.js/lib/languages/python";
import markdown from "highlight.js/lib/languages/markdown";
import bash from "highlight.js/lib/languages/bash";
import sql from "highlight.js/lib/languages/sql";
import yaml from "highlight.js/lib/languages/yaml";
import { SERVER_URL } from "./socket.js";
import { useTextos } from "./i18n.js";

/**
 * El código del proyecto de la sala, de solo lectura y en vivo.
 *
 * Va en su propio chunk (App.tsx lo carga con `lazy`): el resaltado de sintaxis
 * pesa, y quien nunca aprieta "Código" no tiene por qué bajarlo.
 *
 * Solo lectura a propósito: quien cambia el código es el agente. Editarlo a
 * mano a la vez que un agente escribe el mismo archivo es un conflicto que hoy
 * nadie resuelve, y se perdería trabajo de alguno de los dos.
 */

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("css", css);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("python", python);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("yaml", yaml);

const LENGUAJE_POR_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  css: "css",
  scss: "css",
  html: "xml",
  svg: "xml",
  xml: "xml",
  vue: "xml",
  svelte: "xml",
  py: "python",
  md: "markdown",
  sh: "bash",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
};

type Archivo =
  | { ruta: string; contenido: string; tamano: number }
  | { ruta: string; binario: true }
  | { ruta: string; grande: true; tamano: number };

/** El que se abre solo al entrar: el corazón de la app, si se encuentra. */
const PREFERIDOS = ["src/App.tsx", "src/App.jsx", "src/main.tsx", "index.html", "app.py", "main.py", "package.json"];

function elegirInicial(archivos: string[]): string | null {
  return PREFERIDOS.find((p) => archivos.includes(p)) ?? archivos[0] ?? null;
}

function resaltar(ruta: string, contenido: string): string {
  const ext = ruta.split(".").pop()?.toLowerCase() ?? "";
  const lang = LENGUAJE_POR_EXTENSION[ext];
  try {
    return lang
      ? hljs.highlight(contenido, { language: lang, ignoreIllegals: true }).value
      : hljs.highlightAuto(contenido).value;
  } catch {
    // Si el resaltador se atraganta, se ve sin color, pero se ve.
    return contenido.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  }
}

/** Las rutas como árbol de carpetas, para pintarlas plegables. */
interface Nodo {
  nombre: string;
  ruta: string;
  hijos: Map<string, Nodo>;
  esArchivo: boolean;
}

function armarArbol(archivos: string[]): Nodo {
  const raiz: Nodo = { nombre: "", ruta: "", hijos: new Map(), esArchivo: false };
  for (const ruta of archivos) {
    let actual = raiz;
    const partes = ruta.split("/");
    partes.forEach((parte, i) => {
      const esArchivo = i === partes.length - 1;
      const sub = partes.slice(0, i + 1).join("/");
      if (!actual.hijos.has(parte)) {
        actual.hijos.set(parte, { nombre: parte, ruta: sub, hijos: new Map(), esArchivo });
      }
      actual = actual.hijos.get(parte)!;
    });
  }
  return raiz;
}

/** Carpetas primero, luego archivos, cada grupo en orden alfabético. */
function ordenados(nodo: Nodo): Nodo[] {
  return [...nodo.hijos.values()].sort((a, b) =>
    a.esArchivo === b.esArchivo ? a.nombre.localeCompare(b.nombre) : a.esArchivo ? 1 : -1,
  );
}

export function CodigoView({ roomId, socket }: { roomId: string; socket: Socket }) {
  const { t } = useTextos();
  const [archivos, setArchivos] = useState<string[] | null>(null);
  const [abierto, setAbierto] = useState<string | null>(null);
  const [archivo, setArchivo] = useState<Archivo | null>(null);
  const [cerradas, setCerradas] = useState<Set<string>>(new Set());
  const [recien, setRecien] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);
  /** Lo que hay que avisar del .zip: que no hay nada guardado, o que falta lo de ahorita. */
  const [avisoZip, setAvisoZip] = useState<string | null>(null);
  const abiertoRef = useRef<string | null>(null);
  abiertoRef.current = abierto;

  const base = `${SERVER_URL}/rooms/${encodeURIComponent(roomId)}/codigo`;

  const cargarLista = useCallback(async () => {
    try {
      const r = await fetch(base);
      if (!r.ok) return;
      const { archivos: lista } = (await r.json()) as { archivos: string[] };
      setArchivos(lista);
      setAbierto((actual) => (actual && lista.includes(actual) ? actual : elegirInicial(lista)));
    } catch {
      // Sin red: se queda lo último que se vio.
    }
  }, [base]);

  const cargarArchivo = useCallback(
    async (ruta: string) => {
      try {
        const r = await fetch(`${base}/archivo?ruta=${encodeURIComponent(ruta)}`);
        if (!r.ok) return;
        const a = (await r.json()) as Archivo;
        // Pudo llegar tarde, cuando la persona ya había abierto otro.
        if (abiertoRef.current === ruta) setArchivo(a);
      } catch {
        // Igual que arriba.
      }
    },
    [base],
  );

  useEffect(() => {
    void cargarLista();
  }, [cargarLista]);

  useEffect(() => {
    setArchivo(null);
    if (abierto) void cargarArchivo(abierto);
  }, [abierto, cargarArchivo]);

  // En vivo: lo que el agente escribe aparece aquí sin recargar. La lista se
  // pide una vez por ráfaga y no por archivo, porque un turno toca muchos
  // archivos seguidos.
  useEffect(() => {
    let espera: ReturnType<typeof setTimeout> | null = null;
    let apagarMarca: ReturnType<typeof setTimeout> | null = null;
    const alCambiar = ({ path }: { path?: string }) => {
      if (path) {
        setRecien(path);
        if (apagarMarca) clearTimeout(apagarMarca);
        apagarMarca = setTimeout(() => setRecien(null), 2500);
        if (path === abiertoRef.current) void cargarArchivo(path);
      }
      if (espera) clearTimeout(espera);
      espera = setTimeout(() => void cargarLista(), 500);
    };
    socket.on("file:changed", alCambiar);
    return () => {
      socket.off("file:changed", alCambiar);
      if (espera) clearTimeout(espera);
      if (apagarMarca) clearTimeout(apagarMarca);
    };
  }, [socket, cargarArchivo, cargarLista]);

  const arbol = useMemo(() => armarArbol(archivos ?? []), [archivos]);
  const html = useMemo(
    () => (archivo && "contenido" in archivo ? resaltar(archivo.ruta, archivo.contenido) : ""),
    [archivo],
  );
  const lineas = archivo && "contenido" in archivo ? archivo.contenido.split("\n").length : 0;

  /**
   * Descargar el proyecto como .zip.
   *
   * Pregunta antes cómo está la sala: el .zip sale de lo último guardado, así
   * que si un agente está a media escritura se avisa que eso no viaja, y si la
   * sala no ha guardado nada todavía se dice en vez de bajar un error.
   */
  const descargar = async () => {
    const sala = `${SERVER_URL}/rooms/${encodeURIComponent(roomId)}`;
    try {
      const r = await fetch(`${sala}/export/estado`);
      const estado = (await r.json()) as { hayCommits: boolean; cambiosSinCommitear: boolean };
      if (!estado.hayCommits) {
        setAvisoZip(t.zipSalaVacia);
        return;
      }
      setAvisoZip(estado.cambiosSinCommitear ? t.zipTrabajoSinGuardar : null);
      const a = document.createElement("a");
      a.href = `${sala}/export`;
      a.download = "";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      setAvisoZip(t.zipFallo);
    }
  };

  useEffect(() => {
    if (!avisoZip) return;
    const id = setTimeout(() => setAvisoZip(null), 5000);
    return () => clearTimeout(id);
  }, [avisoZip]);

  const copiar = async () => {
    if (!archivo || !("contenido" in archivo)) return;
    try {
      await navigator.clipboard.writeText(archivo.contenido);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1500);
    } catch {
      // Sin permiso de portapapeles: no pasa nada, se puede seleccionar a mano.
    }
  };

  const pintarNodo = (nodo: Nodo, nivel: number): React.ReactNode =>
    ordenados(nodo).map((n) =>
      n.esArchivo ? (
        <button
          key={n.ruta}
          type="button"
          className={`codigo-item${n.ruta === abierto ? " on" : ""}${n.ruta === recien ? " recien" : ""}`}
          style={{ paddingLeft: 10 + nivel * 12 }}
          onClick={() => setAbierto(n.ruta)}
          title={n.ruta}
        >
          {n.nombre}
        </button>
      ) : (
        <div key={n.ruta}>
          <button
            type="button"
            className="codigo-item carpeta"
            style={{ paddingLeft: 10 + nivel * 12 }}
            onClick={() =>
              setCerradas((prev) => {
                const s = new Set(prev);
                if (s.has(n.ruta)) s.delete(n.ruta);
                else s.add(n.ruta);
                return s;
              })
            }
          >
            {cerradas.has(n.ruta) ? "▸" : "▾"} {n.nombre}
          </button>
          {!cerradas.has(n.ruta) && pintarNodo(n, nivel + 1)}
        </div>
      ),
    );

  if (archivos === null) return <div className="codigo-vacio">{t.codigoCargando}</div>;
  if (archivos.length === 0) return <div className="codigo-vacio">{t.codigoSinArchivos}</div>;

  return (
    <div className="codigo">
      <nav className="codigo-arbol" aria-label={t.vistaCodigo}>
        {pintarNodo(arbol, 0)}
      </nav>
      {/* En el teléfono no cabe el árbol al lado: se vuelve un selector. */}
      <select
        className="codigo-selector"
        value={abierto ?? ""}
        onChange={(e) => setAbierto(e.target.value)}
        aria-label={t.codigoElegir}
      >
        {archivos.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <section className="codigo-archivo">
        <div className="codigo-cab">
          <span className="codigo-ruta">{abierto}</span>
          {archivo && "contenido" in archivo && (
            <button type="button" className="codigo-copiar" onClick={copiar}>
              {copiado ? t.codigoCopiado : t.codigoCopiar}
            </button>
          )}
          <button type="button" className="codigo-copiar" onClick={() => void descargar()} title={t.descargarZipTitulo}>
            {t.descargarZip}
          </button>
        </div>
        {avisoZip && <div className="codigo-aviso">{avisoZip}</div>}
        {!archivo ? (
          <div className="codigo-vacio">{t.codigoCargando}</div>
        ) : "binario" in archivo ? (
          <div className="codigo-vacio">{t.codigoBinario}</div>
        ) : "grande" in archivo ? (
          <div className="codigo-vacio">{t.codigoGrande}</div>
        ) : (
          <div className="codigo-cuerpo">
            <pre className="codigo-numeros" aria-hidden="true">
              {Array.from({ length: lineas }, (_, i) => i + 1).join("\n")}
            </pre>
            {/* El HTML sale de highlight.js, que escapa el contenido del archivo
                y solo agrega sus <span> de color: no hay HTML del proyecto que
                llegue a pintarse como tal. */}
            <pre className="codigo-texto hljs">
              <code dangerouslySetInnerHTML={{ __html: html }} />
            </pre>
          </div>
        )}
      </section>
    </div>
  );
}
