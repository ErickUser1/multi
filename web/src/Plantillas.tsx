import { useEffect, useState } from "react";
import { SERVER_URL } from "./socket.js";
import { useTextos } from "./i18n.js";

/**
 * Las plantillas: salas armadas para que la gente vea qué se puede hacer en
 * Multti y empiece desde ahí, en vez de frente a una caja vacía.
 *
 * "Usar plantilla" crea una sala NUEVA con una copia del proyecto (el server
 * hace un remix sin liga al original). La plantilla misma nunca se abre para
 * editar: si se pudiera entrar, el primero que llegara la cambiaría para todos.
 */

export type TipoDePlantilla = "presentacion" | "app" | "dashboard" | "reporte" | "juego" | "web";

export interface Plantilla {
  id: string;
  tipo: TipoDePlantilla;
  titulo: string;
  descripcion: string;
  /** Ruta de la captura en el server, o null si todavía no hay. */
  miniatura: string | null;
}

/**
 * La lista se pide una vez por visita y se comparte: la sala vacía, la
 * pantalla de inicio y la página la usan, y cambian casi nunca.
 */
let pedido: Promise<Plantilla[]> | null = null;

function pedirPlantillas(): Promise<Plantilla[]> {
  pedido ??= fetch(`${SERVER_URL}/plantillas`)
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((d: { plantillas: Plantilla[] }) => d.plantillas)
    .catch(() => {
      pedido = null; // que la siguiente pantalla lo vuelva a intentar
      return [];
    });
  return pedido;
}

/** Las plantillas, o null mientras llegan. Un error se ve como lista vacía. */
export function usePlantillas(): Plantilla[] | null {
  const [lista, setLista] = useState<Plantilla[] | null>(null);
  useEffect(() => {
    let vivo = true;
    void pedirPlantillas().then((l) => vivo && setLista(l));
    return () => {
      vivo = false;
    };
  }, []);
  return lista;
}

/** Crea la sala desde la plantilla y entra a ella. Devuelve si se pudo. */
export async function usarPlantilla(id: string): Promise<boolean> {
  try {
    const r = await fetch(`${SERVER_URL}/plantillas/${id}/usar`, { method: "POST" });
    const d = (await r.json().catch(() => null)) as { id?: string } | null;
    if (!r.ok || !d?.id) return false;
    window.location.hash = `#/sala/${d.id}`;
    return true;
  } catch {
    return false;
  }
}

/**
 * Las tarjetas. Sin `conBoton` son solo para ver (por ejemplo, a quien llegó
 * por el link de una sala: mandarlo a otra sala lo separaría de su equipo).
 */
export function TarjetasDePlantillas({
  plantillas,
  conBoton = true,
  compactas = false,
}: {
  plantillas: Plantilla[];
  conBoton?: boolean;
  compactas?: boolean;
}) {
  const { t } = useTextos();
  const [usando, setUsando] = useState<string | null>(null);

  const usar = async (id: string) => {
    if (usando) return;
    setUsando(id);
    const ok = await usarPlantilla(id);
    if (!ok) alert(t.plantillaFallo);
    setUsando(null);
  };

  return (
    <ul className={`plantillas-lista${compactas ? " compactas" : ""}`}>
      {plantillas.map((p) => (
        <li key={p.id} className="plantilla-tarjeta">
          <div className="plantilla-foto">
            {p.miniatura ? (
              <img src={`${SERVER_URL}${p.miniatura}`} alt="" loading="lazy" />
            ) : (
              // Sin captura todavía: el tipo, para que la tarjeta no se vea rota.
              <span aria-hidden="true">{t.tipoDePlantilla[p.tipo] ?? p.titulo}</span>
            )}
          </div>
          <div className="plantilla-info">
            <span className="plantilla-tipo">{t.tipoDePlantilla[p.tipo] ?? p.tipo}</span>
            <h3>{p.titulo}</h3>
            {!compactas && p.descripcion && <p>{p.descripcion}</p>}
          </div>
          {conBoton && (
            <button className="plantilla-usar" onClick={() => void usar(p.id)} disabled={!!usando}>
              {usando === p.id ? t.usandoPlantilla : t.usarPlantilla}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** La página `#/plantillas`, con todas. */
export function PaginaPlantillas() {
  const { t } = useTextos();
  const plantillas = usePlantillas();

  return (
    <div className="explorar">
      <header className="explorar-cab">
        <a className="explorar-volver" href="#/">
          ← {t.volverAMultti}
        </a>
        <h1>{t.plantillasTitulo}</h1>
        <p>{t.plantillasSub}</p>
      </header>
      {plantillas === null ? (
        <p className="explorar-vacio">{t.explorarCargando}</p>
      ) : plantillas.length === 0 ? (
        <p className="explorar-vacio">{t.plantillasVacio}</p>
      ) : (
        <TarjetasDePlantillas plantillas={plantillas} />
      )}
    </div>
  );
}
