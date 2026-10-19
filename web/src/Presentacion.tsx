import { useEffect, useRef, useState, type RefObject } from "react";
import { SERVER_URL } from "./socket";
import type { Textos } from "./i18n";

/**
 * Descargar y presentar una presentación, hechos por Multti y no por el agente.
 *
 * Aparecen solos cuando la vista previa trae diapositivas (data-diapositiva,
 * lo avisa el inspector). Antes cada agente ponía su propio botón donde se le
 * ocurría y armaba los archivos a mano: una persona no lo encontró dos veces.
 * Los archivos salen del server (/rooms/:id/presentacion.pdf|pptx), que los
 * genera con el navegador de la sala a partir de lo que se ve.
 */
export function BotonesDePresentacion({
  roomId,
  iframeRef,
  previewSrc,
  t,
}: {
  roomId: string;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  previewSrc: string;
  t: Textos;
}) {
  const [menu, setMenu] = useState(false);
  const [preparando, setPreparando] = useState<"pdf" | "pptx" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const caja = useRef<HTMLDivElement | null>(null);

  // El menú se cierra al picar afuera, como cualquier otro.
  useEffect(() => {
    if (!menu) return;
    const fuera = (e: PointerEvent) => {
      if (caja.current && !caja.current.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("pointerdown", fuera);
    return () => document.removeEventListener("pointerdown", fuera);
  }, [menu]);

  const descargar = async (formato: "pdf" | "pptx") => {
    setPreparando(formato);
    setError(null);
    try {
      const r = await fetch(`${SERVER_URL}/rooms/${roomId}/presentacion.${formato}`);
      if (!r.ok) {
        const cuerpo = (await r.json().catch(() => null)) as { error?: string } | null;
        throw new Error(cuerpo?.error ?? `${r.status}`);
      }
      const blob = await r.blob();
      const nombre = nombreDeArchivo(r.headers.get("content-disposition")) ?? `presentacion.${formato}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = nombre;
      // Dentro de la página: suelto, hay navegadores que ignoran el nombre.
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setMenu(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreparando(null);
    }
  };

  const presentar = async () => {
    const marco = iframeRef.current;
    // El iPhone no deja poner un iframe en pantalla completa: ahí se abre la
    // vista previa sola en otra pestaña, que se puede girar y pasar con el dedo.
    if (!marco || !document.fullscreenEnabled || !marco.requestFullscreen) {
      window.open(previewSrc, "_blank", "noopener");
      return;
    }
    try {
      await marco.requestFullscreen();
      // Que las flechas del teclado le lleguen a la presentación y no a la sala.
      marco.contentWindow?.focus();
    } catch {
      window.open(previewSrc, "_blank", "noopener");
    }
  };

  return (
    <>
      <div className="descargar-presentacion" ref={caja}>
        <button
          className={`vista-btn flotante con-texto ${menu ? "on" : ""}`}
          onClick={() => setMenu((v) => !v)}
          title={t.presDescargarTitulo}
          aria-expanded={menu}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>{t.presDescargar}</span>
        </button>
        {menu && (
          <div className="menu-presentacion" role="menu">
            {(["pdf", "pptx"] as const).map((f) => (
              <button key={f} role="menuitem" disabled={preparando !== null} onClick={() => void descargar(f)}>
                {preparando === f ? t.presPreparando : f === "pdf" ? t.presPdf : t.presPptx}
              </button>
            ))}
            {error && <p className="menu-presentacion-error">{t.presError(error)}</p>}
          </div>
        )}
      </div>
      <button className="vista-btn flotante con-texto" onClick={() => void presentar()} title={t.presPresentarTitulo}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M7 4.5v15l12-7.5z" />
        </svg>
        <span>{t.presPresentar}</span>
      </button>
    </>
  );
}

/** El nombre que manda el server: el de filename*, que trae los acentos, si viene. */
function nombreDeArchivo(cabecera: string | null): string | null {
  if (!cabecera) return null;
  const utf8 = cabecera.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (utf8) {
    try {
      return decodeURIComponent(utf8);
    } catch {
      /* cae al sencillo */
    }
  }
  return cabecera.match(/filename="([^"]+)"/i)?.[1] ?? null;
}
