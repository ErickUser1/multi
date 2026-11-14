import { existsSync } from "node:fs";
import { io as ioClient, type Socket } from "socket.io-client";
import { getStorage } from "./storage/index.js";
import type { TipoDePlantilla } from "./storage/types.js";

/**
 * Arma las plantillas solas: crea una sala por plantilla, le pide el proyecto al
 * agente con un buen prompt, espera a que termine y la registra.
 *
 *   npm run crear-plantillas                      → las 6
 *   npm run crear-plantillas -- juego web         → solo esos tipos
 *   npm run crear-plantillas -- --sin-registrar   → las arma pero no las registra
 *
 * Corre en el server, contra el Multti que ya está prendido (MULTI_URL, por
 * defecto http://localhost:4000), y usa la key del .env como cualquier sala:
 * cuesta lo mismo que pedirlas a mano. Las seis van en paralelo.
 *
 * Al final dice el link de cada sala. Si alguna no te gusta, entra, pídele
 * cambios al agente, o quítala con `npm run plantillas -- quitar <sala>`.
 */

// El .env del server, para leer WEB_ORIGIN (la dirección pública de los links).
if (existsSync(".env")) process.loadEnvFile(".env");

const SERVER = process.env.MULTI_URL ?? "http://localhost:4000";
/** Para los links que se imprimen: la dirección pública si está en el .env. */
const PUBLICA = (process.env.WEB_ORIGIN ?? SERVER).replace(/\/$/, "");
/** Lo más que se espera a un agente. Un juego con niveles puede tardar. */
const ESPERA_MAX_MS = 45 * 60_000;
/** Cuánto tiene que quedarse quieto el agente para darlo por terminado. */
const QUIETO_MS = 20_000;

interface Receta {
  tipo: TipoDePlantilla;
  titulo: string;
  descripcion: string;
  prompt: string;
}

const RECETAS: Receta[] = [
  {
    tipo: "presentacion",
    titulo: "Sistema solar",
    descripcion: "Diapositivas para clase, listas para proyectar",
    prompt:
      "Haz una presentación de 10 diapositivas sobre el sistema solar para una clase de secundaria. Que se vea profesional y moderna: fondo oscuro tipo espacio, tipografía grande y legible, una imagen o ilustración en cada diapositiva, datos curiosos de cada planeta y una diapositiva final con un mini quiz de 3 preguntas. Transiciones suaves entre diapositivas y flechas para avanzar. Cuando termines, revisa con ver_preview que cada diapositiva se vea bien y arregla lo que no.",
  },
  {
    tipo: "app",
    titulo: "Inventario de tiendita",
    descripcion: "Agrega, edita y busca productos; avisa cuando algo se acaba",
    prompt:
      "Haz una app para llevar el inventario de una tiendita: agregar productos con nombre, precio, cantidad y categoría, editarlos, borrarlos y buscarlos. Que avise en rojo cuando un producto tenga menos de 5 piezas y que muestre arriba el total de productos y el valor del inventario. Que los datos se guarden aunque recargue la página. Diseño limpio y moderno, que se vea bien en celular. Agrega 10 productos de ejemplo para que no se vea vacía. Revisa con ver_preview que todo funcione.",
  },
  {
    tipo: "dashboard",
    titulo: "Ventas de una cafetería",
    descripcion: "Gráficas y números que cambian con un filtro por mes",
    prompt:
      "Haz un dashboard de ventas de una cafetería con datos de ejemplo de los últimos 6 meses: tarjetas arriba con ventas totales, ticket promedio, producto más vendido y crecimiento contra el mes pasado; una gráfica de línea de ventas por mes, una de barras de productos más vendidos y una de dona por método de pago. Filtro por mes que actualice todo. Que se vea como un dashboard profesional, con buenos colores y que se entienda de un vistazo. Revisa con ver_preview que las gráficas se vean bien.",
  },
  {
    tipo: "reporte",
    titulo: "Reporte de proyecto escolar",
    descripcion: "Documento formal con tabla de resultados y bibliografía APA",
    prompt:
      "Haz un documento: un reporte de proyecto escolar sobre el reciclaje en mi escuela. Con portada, índice, introducción, objetivos, metodología (encuesta a 50 alumnos), resultados con una tabla de datos, análisis, conclusiones, recomendaciones y bibliografía en formato APA. Redacción formal, como para entregarlo a un profesor.",
  },
  {
    tipo: "juego",
    titulo: "Naves espaciales",
    descripcion: "Arcade con oleadas, power-ups, niveles y récord",
    prompt:
      "Haz un juego arcade de naves espaciales: la nave se mueve con las flechas o tocando la pantalla en celular, dispara con espacio, vienen oleadas de enemigos cada vez más rápidas, hay power-ups, marcador, vidas, 3 niveles y pantalla de game over con el mejor puntaje guardado. Que los gráficos se vean lo mejor posible, con estilo pixel art, explosiones y fondo de estrellas en movimiento. Revisa con ver_preview que se pueda jugar.",
  },
  {
    tipo: "web",
    titulo: "Graduación 2027",
    descripcion: "Página de evento con cuenta regresiva, mapa y registro",
    prompt:
      "Haz la página de un evento: la fiesta de graduación generación 2027. Con portada llamativa, cuenta regresiva en vivo para el 20 de junio de 2027, sección de qué incluye, galería de fotos, ubicación con mapa, preguntas frecuentes y un formulario para confirmar asistencia que guarde las respuestas. Diseño elegante y moderno, que se vea increíble en celular. Revisa con ver_preview que todo se vea bien.",
  },
];

interface AgenteVisto {
  name: string;
  state: string;
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Arma una plantilla. Devuelve el id de la sala si el agente terminó. */
async function armar(r: Receta): Promise<string | null> {
  const res = await fetch(`${SERVER}/rooms`, { method: "POST" });
  if (!res.ok) throw new Error(`no se pudo crear la sala (${res.status})`);
  const { id } = (await res.json()) as { id: string };
  const log = (msg: string) => console.log(`[${r.tipo.padEnd(12)}] ${msg}`);
  log(`sala ${id} → ${PUBLICA}/#/sala/${id}`);

  const socket: Socket = ioClient(SERVER, { transports: ["websocket"] });
  let agentes: AgenteVisto[] = [];
  let ultimoCambio = Date.now();
  let empezo = false;
  socket.on("agents", (p: { agents?: AgenteVisto[] }) => {
    agentes = p.agents ?? [];
    ultimoCambio = Date.now();
    if (agentes.some((a) => a.state === "working")) empezo = true;
  });
  // Cualquier archivo que cambie también es señal de que sigue trabajando.
  socket.on("file:changed", () => (ultimoCambio = Date.now()));

  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no se pudo entrar a la sala")), 20_000);
      socket.on("connect", () => socket.emit("join", { roomId: id, name: "Multti" }));
      socket.on("joined", () => {
        clearTimeout(t);
        resolve();
      });
    });
    socket.emit("room:rename", { nombre: r.titulo });
    socket.emit("chat", { text: r.prompt });
    log("prompt enviado, el agente está trabajando…");

    const limite = Date.now() + ESPERA_MAX_MS;
    while (Date.now() < limite) {
      await esperar(5000);
      const trabajando = agentes.some((a) => a.state === "working");
      if (empezo && !trabajando && Date.now() - ultimoCambio > QUIETO_MS) {
        log("terminó");
        return id;
      }
    }
    log(`se pasó de ${ESPERA_MAX_MS / 60_000} min; revísala a mano`);
    return null;
  } finally {
    socket.disconnect();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const registrar = !args.includes("--sin-registrar");
  const tipos = args.filter((a) => !a.startsWith("--"));
  const recetas = tipos.length ? RECETAS.filter((r) => tipos.includes(r.tipo)) : RECETAS;
  if (recetas.length === 0) {
    console.error(`no conozco esos tipos. Tipos: ${RECETAS.map((r) => r.tipo).join(", ")}`);
    process.exit(1);
  }

  console.log(`Armando ${recetas.length} plantilla(s) en ${SERVER}. Esto tarda unos minutos.\n`);
  const resultados = await Promise.all(
    recetas.map(async (r) => {
      try {
        return { r, id: await armar(r) };
      } catch (err) {
        console.error(`[${r.tipo}] falló:`, err instanceof Error ? err.message : err);
        return { r, id: null };
      }
    }),
  );

  const storage = await getStorage();
  console.log("\nResultado:");
  for (const { r, id } of resultados) {
    if (!id) {
      console.log(`  ✗ ${r.titulo}: no quedó`);
      continue;
    }
    if (registrar) {
      await storage.agregarPlantilla({
        roomId: id,
        tipo: r.tipo,
        titulo: r.titulo,
        descripcion: r.descripcion,
        agregada: Date.now(),
      });
    }
    console.log(`  ✓ ${r.titulo}: ${PUBLICA}/#/sala/${id}${registrar ? " (registrada)" : ""}`);
  }
  console.log(
    "\nRevisa que cada una se vea bien. Para quitar una: npm run plantillas -- quitar <sala>.\n" +
      "El reporte no tiene vista previa que capturar: si quieres foto, agrégala con --imagen.",
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
