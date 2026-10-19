import type { RefObject } from "react";
import type { Textos } from "./i18n";

/**
 * Presentar: la vista previa en pantalla completa, hecho por Multti.
 *
 * Aparece solo cuando la vista previa trae diapositivas (data-diapositiva, lo
 * avisa el inspector). Antes cada agente resolvía la pantalla completa a su
 * manera (una tecla F, un botón, o nada), y cada presentación se manejaba
 * distinto. Las flechas siguen siendo las de la presentación: con el foco en el
 * iframe, el teclado le llega a ella.
 */
export function BotonPresentar({
  iframeRef,
  previewSrc,
  t,
}: {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  previewSrc: string;
  t: Textos;
}) {
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
      marco.contentWindow?.focus();
    } catch {
      window.open(previewSrc, "_blank", "noopener");
    }
  };

  return (
    <button className="vista-btn flotante con-texto" onClick={() => void presentar()} title={t.presPresentarTitulo}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M7 4.5v15l12-7.5z" />
      </svg>
      <span>{t.presPresentar}</span>
    </button>
  );
}
