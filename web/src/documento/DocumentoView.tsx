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
import { TarjetaComentario, type Comentario, type Hilo } from "./Comentarios";
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
  soloYo,
}: {
  roomId: string;
  socket: Socket;
  yo: { name: string; color: string };
  agents: Agent[];
  /** Estoy solo en la sala: comentar le habla al agente por defecto. */
  soloYo: boolean;
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

  // Comentarios: los hilos, y la tarjeta abierta (un hilo, o uno nuevo sobre
  // lo seleccionado). La tarjeta flota junto a su texto, dentro de la hoja.
  const [comentarios, setComentarios] = useState<Comentario[]>([]);
  const [abierto, setAbierto] = useState<
    { tipo: "hilo"; hilo: string } | { tipo: "nuevo"; ancla: Ancla; cita: string } | null
  >(null);
  const [posTarjeta, setPosTarjeta] = useState<{ top: number; left: number; ancho: number } | null>(null);
  // Dónde va el botón "Comentar" (junto a lo seleccionado), o null si no hay selección.
  const [botonComentar, setBotonComentar] = useState<{ top: number; left: number } | null>(null);
  // Sube cuando cambia el documento: el orden de los hilos y si su texto sigue ahí.
  const [cambiosDoc, setCambiosDoc] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  // El comentario que acabo de mandar y todavía no vuelve del server.
  const pendiente = useRef<{ id: string; enviado: number } | null>(null);
  // Lo último de los comentarios y de mi nombre, para los avisos del socket.
  const comentariosRef = useRef<Comentario[]>([]);
  comentariosRef.current = comentarios;
  const yoRef = useRef(yo.name);
  yoRef.current = yo.name;
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
    const enNuevo = (c: Comentario) => {
      setComentarios((cs) => (cs.some((x) => x.id === c.id) ? cs : [...cs, c]));
      const raiz = c.id === c.hiloId;
      // Mi comentario nuevo: su tarjeta se abre en cuanto llega. Se reconoce
      // por el id que mandé, y si el server le puso otro (uno viejo que no lo
      // respeta), por ser mío y recién enviado.
      const p = pendiente.current;
      if (raiz && p && c.autor === yoRef.current && (c.id === p.id || Date.now() - p.enviado < 15_000)) {
        pendiente.current = null;
        setAbierto({ tipo: "hilo", hilo: c.id });
        return;
      }
      // Alguien (el agente, otra persona) contesta en un hilo que abrí yo: se
      // abre solo, si no estoy viendo otro.
      if (!raiz && c.autor !== yoRef.current) {
        const mia = comentariosRef.current.find((x) => x.id === c.hiloId && x.autor === yoRef.current);
        if (mia) setAbierto((a) => a ?? { tipo: "hilo", hilo: c.hiloId });
      }
    };
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

  /**
   * Dónde poner algo junto a una posición del documento, en coordenadas del
   * contenido que se desplaza: lo que se pone ahí se mueve con el texto.
   */
  const junto = (pos: number, ancho: number): { top: number; left: number } | null => {
    const caja = scrollRef.current;
    if (!editor || !caja) return null;
    const c = editor.view.coordsAtPos(pos);
    const r = caja.getBoundingClientRect();
    const left = Math.max(12, Math.min(c.left - r.left + caja.scrollLeft - 16, r.width - ancho - 12));
    return { top: c.bottom - r.top + caja.scrollTop + 6, left };
  };

  // El editor avisa cuando cambia el documento o la selección.
  useEffect(() => {
    if (!editor) return;
    const enCambio = () => setCambiosDoc((n) => n + 1);
    const enSeleccion = () => {
      const a = anclaDeSeleccion(editor.state);
      if (!a || !editor.isFocused) return setBotonComentar(null);
      const p = junto(editor.state.selection.to, 110);
      setBotonComentar(p ? { top: p.top - 4, left: p.left } : null);
    };
    const enBlur = () => setTimeout(() => setBotonComentar(null), 150);
    editor.on("update", enCambio);
    editor.on("selectionUpdate", enSeleccion);
    editor.on("blur", enBlur);
    return () => {
      editor.off("update", enCambio);
      editor.off("selectionUpdate", enSeleccion);
      editor.off("blur", enBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  const anclaDe = (c: Comentario | undefined): Ancla | null => {
    try {
      return c?.ancla ? (JSON.parse(c.ancla) as Ancla) : null;
    } catch {
      return null;
    }
  };

  // Los hilos, en el orden en que aparece su texto en la hoja.
  const hilos: (Hilo & { desde: number })[] = useMemo(() => {
    void cambiosDoc;
    const lista = comentarios
      .filter((c) => c.id === c.hiloId)
      .map((raiz) => {
        const ancla = anclaDe(raiz);
        const rango = editor && ancla ? rangoDeAncla(editor.state, ancla) : null;
        return {
          raiz,
          desde: rango?.from ?? Number.MAX_SAFE_INTEGER,
          sinTexto: !!ancla && !rango,
          respuestas: comentarios.filter((c) => c.hiloId === raiz.id && c.id !== raiz.id),
        };
      });
    lista.sort((a, b) => a.desde - b.desde || a.raiz.creado - b.raiz.creado);
    return lista;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comentarios, editor, cambiosDoc]);
  const abiertos = hilos.filter((h) => !h.raiz.resuelto);
  const hiloAbierto = abierto?.tipo === "hilo" ? hilos.find((h) => h.raiz.id === abierto.hilo) ?? null : null;

  // El resaltado en la hoja: los hilos sin resolver, y más fuerte el abierto.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const visibles = abiertos.flatMap((h) => {
      const ancla = anclaDe(h.raiz);
      return ancla ? [{ hilo: h.raiz.id, ancla }] : [];
    });
    editor.view.dispatch(
      editor.state.tr.setMeta(llaveResaltado, { hilos: visibles, activo: abierto?.tipo === "hilo" ? abierto.hilo : null }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, hilos, abierto]);

  // La tarjeta se pone debajo de su texto, y lo sigue si el texto se mueve.
  useEffect(() => {
    if (!abierto || !editor) return setPosTarjeta(null);
    const ancho = Math.min(340, (scrollRef.current?.clientWidth ?? 360) - 24);
    let hasta: number | null = null;
    if (abierto.tipo === "nuevo") {
      hasta = rangoDeAncla(editor.state, abierto.ancla)?.to ?? editor.state.selection.to;
    } else {
      const ancla = anclaDe(hiloAbierto?.raiz);
      hasta = ancla ? rangoDeAncla(editor.state, ancla)?.to ?? null : null;
    }
    // Un hilo cuyo texto ya no existe se abre arriba de la hoja.
    const p = hasta !== null ? junto(hasta, ancho) : { top: (scrollRef.current?.scrollTop ?? 0) + 12, left: 12 };
    setPosTarjeta(p ? { ...p, ancho } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abierto, hiloAbierto?.raiz.id, cambiosDoc, editor]);

  // Si cambia el ancho (girar el celular, mover el divisor), la tarjeta y el
  // botón se vuelven a acomodar.
  useEffect(() => {
    const alCambiar = () => setCambiosDoc((n) => n + 1);
    window.addEventListener("resize", alCambiar);
    return () => window.removeEventListener("resize", alCambiar);
  }, []);

  // Clic fuera de la tarjeta (y fuera de un texto comentado) la cierra.
  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(".com-tarjeta, .doc-comentar, .doc-comentado, .com-boton")) return;
      setAbierto(null);
    };
    document.addEventListener("mousedown", fuera);
    return () => document.removeEventListener("mousedown", fuera);
  }, [abierto]);

  // Tocar un texto comentado abre su hilo.
  activar.current = (hilo: string) => setAbierto({ tipo: "hilo", hilo });

  /** El botón de la barra: va al siguiente hilo sin resolver, en orden del documento. */
  const siguienteHilo = () => {
    if (!abiertos.length || !editor) return;
    const actual = abierto?.tipo === "hilo" ? abiertos.findIndex((h) => h.raiz.id === abierto.hilo) : -1;
    const h = abiertos[(actual + 1) % abiertos.length];
    setAbierto({ tipo: "hilo", hilo: h.raiz.id });
    if (h.desde !== Number.MAX_SAFE_INTEGER) {
      (editor.view.domAtPos(h.desde).node as HTMLElement).parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  };

  const empezarComentario = () => {
    if (!editor) return;
    const a = anclaDeSeleccion(editor.state);
    if (!a) return;
    setAbierto({ tipo: "nuevo", ...a });
    setBotonComentar(null);
  };

  const enviar = (texto: string) => {
    if (!abierto) return;
    const id = crypto.randomUUID();
    if (abierto.tipo === "nuevo") {
      pendiente.current = { id, enviado: Date.now() };
      socket.emit("comentario", { id, ancla: abierto.ancla, cita: abierto.cita, texto });
      // El hilo nuevo se queda abierto: llega con este mismo id.
      setAbierto({ tipo: "hilo", hilo: id });
    } else {
      socket.emit("comentario", { id, hilo: abierto.hilo, texto });
    }
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
          className="doc-boton com-boton"
          title={t.docSiguienteComentario}
          disabled={abiertos.length === 0}
          onClick={siguienteHilo}
        >
          {t.docComentarios}
          {abiertos.length > 0 && ` · ${abiertos.length}`}
        </button>
        <span className={`doc-guardado ${guardado}`} aria-live="polite">
          {guardado === "guardado" ? t.docGuardado : guardado === "guardando" ? t.docGuardando : t.docSinConexion}
        </span>
        <button type="button" className="doc-boton" title={t.docTituloPdf} onClick={() => void imprimir()}>
          {t.docPdf}
        </button>
      </div>
      <div className="doc-cuerpo">
        <div className="doc-scroll" ref={scrollRef}>
          {!listo && <div className="doc-estado">{t.docCargando}</div>}
          <article className="doc-hoja" hidden={!listo}>
            <EditorContent editor={editor} />
          </article>
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
          {posTarjeta && abierto && (abierto.tipo === "nuevo" || hiloAbierto) && (
            <TarjetaComentario
              key={abierto.tipo === "hilo" ? abierto.hilo : "nuevo"}
              hilo={hiloAbierto}
              pos={posTarjeta}
              agents={agents}
              soloYo={soloYo}
              alCerrar={() => setAbierto(null)}
              alEnviar={enviar}
              alResolver={(resuelto) => {
                if (abierto.tipo !== "hilo") return;
                socket.emit("comentario:resolver", { hilo: abierto.hilo, resuelto });
                if (resuelto) setAbierto(null);
              }}
            />
          )}
        </div>
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
