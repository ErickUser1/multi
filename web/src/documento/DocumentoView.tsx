import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEditor, EditorContent } from "@tiptap/react";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import type { Socket } from "socket.io-client";
import { SERVER_URL } from "../socket";
import { useTextos } from "../i18n";
import { crearRenderer } from "./markdown";
import { extensionesDelDocumento } from "./esquema";
import { conVistas } from "./vistas";
import { ProveedorDocumento, type EstadoDeGuardado } from "./proveedor";
import { MarcasDeAgentes, llaveMarcas, type DondeEscribe } from "./marcas";
import { Barra } from "./Barra";
import { EditorDeGrafica } from "./EditorDeGrafica";
import { Comentarios, type Comentario, type Hilo } from "./Comentarios";
import { ResaltadoDeComentarios, llaveResaltado } from "./resaltado";
import { anclaDeSeleccion, rangoDeAncla, type Ancla } from "./anclas";
import type { Agent } from "../socket";

/**
 * El documento de la sala, vivo y editable por todos a la vez.
 *
 * Es un editor (TipTap) conectado al Y.Doc de la sala: lo que escribe cada
 * persona y cada agente aparece en el momento en las pantallas de los demás,
 * con su cursor y su color. No hay "guardar": cada cambio viaja solo.
 */
export function DocumentoView({
  roomId,
  socket,
  yo,
  agents,
}: {
  roomId: string;
  socket: Socket;
  yo: { name: string; color: string };
  agents: Agent[];
}) {
  const { t } = useTextos();
  // Cada recarga del server (volver atrás) estrena proveedor y Y.Doc.
  const [intento, setIntento] = useState(0);
  const [listo, setListo] = useState(false);
  const [noHay, setNoHay] = useState(false);
  const [guardado, setGuardado] = useState<EstadoDeGuardado>("guardado");
  const [impresion, setImpresion] = useState<string | null>(null);
  const [graficaAbierta, setGraficaAbierta] = useState<string | null>(null);
  const abrirGrafica = useRef<(ref: string) => void>(() => {});
  abrirGrafica.current = setGraficaAbierta;

  // Comentarios: los hilos, cuál está activo, y el que se está escribiendo.
  const [comentarios, setComentarios] = useState<Comentario[]>([]);
  const [activo, setActivo] = useState<string | null>(null);
  const [borrador, setBorrador] = useState<{ ancla: Ancla; cita: string } | null>(null);
  const [panel, setPanel] = useState(() => window.matchMedia?.("(min-width: 1100px)").matches ?? true);
  // Dónde va el botón "Comentar" (junto a lo seleccionado), o null si no hay selección.
  const [botonComentar, setBotonComentar] = useState<{ top: number; left: number } | null>(null);
  // Sube cuando cambia el documento: el orden de los hilos y si su texto sigue ahí.
  const [cambiosDoc, setCambiosDoc] = useState(0);
  const cuerpoRef = useRef<HTMLDivElement>(null);
  const activar = useRef<(hilo: string) => void>(() => {});

  const proveedor = useMemo(() => {
    void intento;
    return new ProveedorDocumento(socket, {
      editable: true,
      alSincronizar: () => setListo(true),
      alNoHaber: () => setNoHay(true),
      alRecargar: () => {
        setListo(false);
        setGraficaAbierta(null);
        setIntento((n) => n + 1);
      },
      alGuardar: setGuardado,
    });
  }, [socket, intento]);
  useEffect(() => () => proveedor.destruir(), [proveedor]);

  const urlImagen = useMemo(
    () => (nombre: string) => `${SERVER_URL}/rooms/${roomId}/documento/imagenes/${encodeURIComponent(nombre)}`,
    [roomId],
  );

  const editor = useEditor(
    {
      editable: true,
      extensions: [
        ...conVistas(
          // Los ids de los bloques nuevos los pone el server (ver esquema.ts).
          extensionesDelDocumento(),
          {
            objetos: proveedor.ydoc.getMap("objetos"),
            urlImagen,
            escribiendo: t.docEscribiendo,
            alAbrirGrafica: (ref) => abrirGrafica.current(ref),
          },
        ),
        Collaboration.configure({ document: proveedor.ydoc, field: "contenido" }),
        CollaborationCaret.configure({ provider: { awareness: proveedor.awareness }, user: yo }),
        MarcasDeAgentes.configure({ fragmento: proveedor.ydoc.getXmlFragment("contenido") }),
        ResaltadoDeComentarios.configure({ alActivar: (hilo) => activar.current(hilo) }),
      ],
      editorProps: { attributes: { class: "doc-md", spellcheck: "true" } },
    },
    [proveedor],
  );

  // Si cambia mi nombre o color (me renombré), mi cursor también.
  useEffect(() => {
    editor?.commands.updateUser?.(yo);
  }, [editor, yo.name, yo.color]); // eslint-disable-line react-hooks/exhaustive-deps

  // Dónde escribe cada agente.
  useEffect(() => {
    if (!editor) return;
    const enAgente = (d: DondeEscribe) => {
      if (!editor.isDestroyed) {
        editor.view.dispatch(editor.state.tr.setMeta(llaveMarcas, { ...d, etiqueta: `${d.agente} · ${t.docEscribiendo}` }));
      }
    };
    socket.on("doc:agente", enAgente);
    return () => {
      socket.off("doc:agente", enAgente);
    };
  }, [editor, socket, t]);

  // Los comentarios de la sala: al abrir (y al recargar el documento), y los
  // nuevos por el socket.
  useEffect(() => {
    let vivo = true;
    fetch(`${SERVER_URL}/rooms/${roomId}/comentarios`)
      .then((r) => (r.ok ? r.json() : { comentarios: [] }))
      .then((d: { comentarios: Comentario[] }) => vivo && setComentarios(d.comentarios))
      .catch(() => {});
    const enNuevo = (c: Comentario) => setComentarios((cs) => (cs.some((x) => x.id === c.id) ? cs : [...cs, c]));
    const enResuelto = ({ hilo, resuelto }: { hilo: string; resuelto: boolean }) =>
      setComentarios((cs) => cs.map((c) => (c.id === hilo ? { ...c, resuelto } : c)));
    socket.on("comentario:nuevo", enNuevo);
    socket.on("comentario:resuelto", enResuelto);
    return () => {
      vivo = false;
      socket.off("comentario:nuevo", enNuevo);
      socket.off("comentario:resuelto", enResuelto);
    };
  }, [roomId, socket, proveedor]);

  // El editor avisa cuando cambia el documento o la selección.
  useEffect(() => {
    if (!editor) return;
    const enCambio = () => setCambiosDoc((n) => n + 1);
    const enSeleccion = () => {
      const a = anclaDeSeleccion(editor.state);
      const cuerpo = cuerpoRef.current;
      if (!a || !cuerpo || !editor.isFocused) return setBotonComentar(null);
      const coords = editor.view.coordsAtPos(editor.state.selection.to);
      const caja = cuerpo.getBoundingClientRect();
      setBotonComentar({ top: coords.top - caja.top, left: Math.min(coords.right - caja.left + 8, caja.width - 120) });
    };
    editor.on("update", enCambio);
    editor.on("selectionUpdate", enSeleccion);
    editor.on("blur", () => setTimeout(() => setBotonComentar(null), 150));
    return () => {
      editor.off("update", enCambio);
      editor.off("selectionUpdate", enSeleccion);
    };
  }, [editor]);

  // Los hilos, en el orden en que aparece su texto en la hoja.
  const hilos: Hilo[] = useMemo(() => {
    void cambiosDoc;
    const raices = comentarios.filter((c) => c.id === c.hiloId);
    const lista = raices.map((raiz) => {
      let ancla: Ancla | null = null;
      try {
        ancla = raiz.ancla ? (JSON.parse(raiz.ancla) as Ancla) : null;
      } catch {
        ancla = null;
      }
      const rango = editor && ancla ? rangoDeAncla(editor.state, ancla) : null;
      return {
        raiz,
        ancla,
        desde: rango?.from ?? Number.MAX_SAFE_INTEGER,
        sinTexto: !!ancla && !rango,
        respuestas: comentarios.filter((c) => c.hiloId === raiz.id && c.id !== raiz.id),
      };
    });
    lista.sort((a, b) => a.desde - b.desde || a.raiz.creado - b.raiz.creado);
    return lista;
  }, [comentarios, editor, cambiosDoc]);

  // El resaltado en la hoja sigue a los hilos abiertos y al activo.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const visibles = hilos
      .filter((h) => !h.raiz.resuelto)
      .flatMap((h) => {
        try {
          return h.raiz.ancla ? [{ hilo: h.raiz.id, ancla: JSON.parse(h.raiz.ancla) as Ancla }] : [];
        } catch {
          return [];
        }
      });
    editor.view.dispatch(editor.state.tr.setMeta(llaveResaltado, { hilos: visibles, activo }));
  }, [editor, hilos, activo]);

  activar.current = (hilo: string) => {
    setActivo(hilo);
    setPanel(true);
  };

  /** Activar un hilo desde el panel: la hoja se mueve a su texto. */
  const irAHilo = (hilo: string) => {
    setActivo(hilo);
    const raiz = comentarios.find((c) => c.id === hilo);
    if (!editor || !raiz?.ancla) return;
    try {
      const r = rangoDeAncla(editor.state, JSON.parse(raiz.ancla) as Ancla);
      if (r) (editor.view.domAtPos(r.from).node as HTMLElement).parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
    } catch {
      /* el ancla no se entiende: el hilo se ve igual */
    }
  };

  const empezarComentario = () => {
    if (!editor) return;
    const a = anclaDeSeleccion(editor.state);
    if (!a) return;
    setBorrador(a);
    setActivo(null);
    setPanel(true);
    setBotonComentar(null);
  };

  const enviarComentario = (texto: string) => {
    if (!borrador) return;
    socket.emit("comentario", { id: crypto.randomUUID(), ancla: borrador.ancla, cita: borrador.cita, texto });
    setBorrador(null);
  };

  const insertarGrafica = () => {
    if (!editor) return;
    const ref = Math.random().toString(36).slice(2, 10);
    const objetos = proveedor.ydoc.getMap("objetos");
    // Los datos y el bloque en la MISMA transacción: nadie ve un bloque sin datos.
    proveedor.ydoc.transact(() => {
      objetos.set(ref, {
        tipo: "grafica",
        fuente: JSON.stringify({
          tipo: "barras",
          titulo: "",
          etiquetas: ["A", "B", "C"],
          series: [{ nombre: "Serie 1", datos: [3, 5, 2] }],
        }),
      });
      // Después de lo seleccionado, nunca encima: si había una gráfica
      // seleccionada (la que acabas de editar), insertar no la reemplaza.
      const { to } = editor.state.selection;
      editor.chain().focus().insertContentAt(to, { type: "grafica", attrs: { ref } }).run();
    });
    setGraficaAbierta(ref);
  };

  // El PDF sale de la exportación en markdown, con el mismo renderer de
  // siempre: lo que se imprime no depende del editor.
  const imprimir = async () => {
    const r = await fetch(`${SERVER_URL}/rooms/${roomId}/documento`).catch(() => null);
    if (!r?.ok) return;
    const { markdown } = (await r.json()) as { markdown: string };
    setImpresion(crearRenderer(urlImagen)(markdown));
  };
  useEffect(() => {
    if (impresion === null) return;
    // Un cuadro después: que la copia ya esté en la página cuando se abra el diálogo.
    const id = requestAnimationFrame(() => {
      window.print();
      setImpresion(null);
    });
    return () => cancelAnimationFrame(id);
  }, [impresion]);

  if (noHay) return <div className="doc-estado">{t.docSinLeer}</div>;

  return (
    <div className="documento">
      <div className="doc-barra">
        {editor && listo && <Barra editor={editor} alInsertarGrafica={insertarGrafica} />}
        <button
          type="button"
          className={`doc-boton com-boton ${panel ? "activo" : ""}`}
          aria-pressed={panel}
          onClick={() => setPanel((p) => !p)}
        >
          {t.docComentarios}
          {hilos.filter((h) => !h.raiz.resuelto).length > 0 && ` · ${hilos.filter((h) => !h.raiz.resuelto).length}`}
        </button>
        <span className={`doc-guardado ${guardado}`} aria-live="polite">
          {guardado === "guardado" ? t.docGuardado : guardado === "guardando" ? t.docGuardando : t.docSinConexion}
        </span>
        <button type="button" className="doc-boton" title={t.docTituloPdf} onClick={() => void imprimir()}>
          {t.docPdf}
        </button>
      </div>
      <div className="doc-cuerpo" ref={cuerpoRef}>
        <div className="doc-scroll">
          {!listo && <div className="doc-estado">{t.docCargando}</div>}
          <article className="doc-hoja" hidden={!listo}>
            <EditorContent editor={editor} />
          </article>
        </div>
        {botonComentar && (
          <button
            type="button"
            className="doc-comentar"
            style={{ top: botonComentar.top, left: botonComentar.left }}
            // mousedown: con click, el editor pierde la selección antes.
            onMouseDown={(e) => {
              e.preventDefault();
              empezarComentario();
            }}
          >
            {t.docComentar}
          </button>
        )}
        {panel && (
          <Comentarios
            hilos={hilos}
            activo={activo}
            borrador={borrador}
            agents={agents}
            alActivar={irAHilo}
            alComentar={enviarComentario}
            alCancelarBorrador={() => setBorrador(null)}
            alResponder={(hilo, texto) => socket.emit("comentario", { id: crypto.randomUUID(), hilo, texto })}
            alResolver={(hilo, resuelto) => socket.emit("comentario:resolver", { hilo, resuelto })}
          />
        )}
      </div>
      {graficaAbierta && (
        <EditorDeGrafica objetos={proveedor.ydoc.getMap("objetos")} ref_={graficaAbierta} alCerrar={() => setGraficaAbierta(null)} />
      )}
      {/* Para imprimir va una copia fuera de la Sala: la sala recorta lo que no
          cabe en pantalla, y el PDF necesita el documento entero. En pantalla
          esta copia no se ve. */}
      {impresion !== null &&
        createPortal(
          <div className="doc-impresion">
            <article className="doc-hoja">
              <div className="doc-md" dangerouslySetInnerHTML={{ __html: impresion }} />
            </article>
          </div>,
          document.body,
        )}
    </div>
  );
}
