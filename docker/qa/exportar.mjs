/**
 * Exporta la presentación de la sala a PDF o a PowerPoint.
 *
 * Antes lo hacía el agente: armaba la presentación una segunda vez con
 * pptxgenjs y una tercera con jspdf, a ciegas, y le ponía su propio botón. Una
 * persona hizo tres presentaciones así en un día y en una no encontró el botón
 * dos veces. Ahora el agente solo diseña y el archivo sale de lo que el
 * navegador ya dibujó: idéntico a la pantalla, siempre, y sin gastarle nada.
 *
 * El contrato con la página (lo pide el prompt, ver <presentaciones>):
 *   - cada diapositiva es un elemento [data-diapositiva] de 1920×1080;
 *   - la página muestra la diapositiva n cuando la dirección termina en #n;
 *   - flechas y contadores van FUERA de las diapositivas.
 *
 * Uso: node exportar.mjs <json en base64>
 *   { url, formato: "pdf" | "pptx" }
 * Imprime UNA línea de JSON: { ok, archivo (base64), diapositivas, titulo } o
 * { ok: false, error }.
 */
import { PDFDocument } from "pdf-lib";
import PptxGenJS from "pptxgenjs";
import { salir, tope, leerPedido, abrirNavegador } from "./comun.mjs";

const ANCHO = 1920;
const ALTO = 1080;
/** Una presentación de 70 diapositivas pasa de un minuto; más que esto es otra cosa. */
const TOPE_MS = 110_000;
/** Hoja de PowerPoint de 16:9: 13.333 × 7.5 pulgadas, o sea 144 px por pulgada. */
const PX_POR_PULGADA = 144;
/** Y la letra: la hoja mide 960 pt de ancho para 1920 px, medio punto por px. */
const PT_POR_PX = 0.5;

tope(TOPE_MS, `la presentación tardó más de ${TOPE_MS / 1000}s en exportarse`);
const { url, formato } = await leerPedido("exportar");
if (formato !== "pdf" && formato !== "pptx") await salir({ ok: false, error: "formato desconocido" });

const navegador = await abrirNavegador();

/**
 * Lo que se le inyecta a la página para fotografiar UNA diapositiva: todo lo
 * demás invisible (flechas, contadores, la barra del agente) sin moverlo, y sin
 * animaciones que dejen la diapositiva a medio aparecer.
 */
const CSS_SOLO_LA_ACTIVA = `
  *, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }
  * { visibility: hidden !important; }
  [data-multtti-activa], [data-multtti-activa] * { visibility: visible !important; }
`;
/** Y para el fondo del PowerPoint: el texto desaparece, porque va encima como texto editable. */
const CSS_SIN_TEXTO = `
  [data-multtti-activa] *:not(svg):not(svg *), [data-multtti-activa] {
    color: transparent !important; -webkit-text-fill-color: transparent !important;
    text-shadow: none !important; text-decoration-color: transparent !important;
  }
`;

try {
  const pagina = await navegador.newPage({ viewport: { width: ANCHO, height: ALTO }, deviceScaleFactor: 1 });
  await pagina.goto(`${url}#1`, { waitUntil: "load", timeout: 30_000 });
  await pagina.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});

  const total = await pagina.evaluate(() => document.querySelectorAll("[data-diapositiva]").length);
  if (total === 0) {
    await salir({
      ok: false,
      error: "la vista previa no tiene diapositivas: ninguna está marcada con data-diapositiva",
    });
  }
  const titulo = (await pagina.title()) || "presentacion";
  await pagina.addStyleTag({ content: CSS_SOLO_LA_ACTIVA });

  const pdfs = [];
  const pptx = formato === "pptx" ? new PptxGenJS() : null;
  if (pptx) {
    pptx.layout = "LAYOUT_WIDE";
    pptx.title = titulo;
  }

  for (let n = 1; n <= total; n++) {
    const caja = await mostrar(pagina, n);
    if (!caja) {
      await salir({
        ok: false,
        error: `la diapositiva ${n} no aparece con #${n}: la página tiene que mostrarla cuando la dirección termina en #${n}`,
      });
    }

    if (formato === "pdf") {
      await pagina.emulateMedia({ media: "screen" });
      pdfs.push(
        await pagina.pdf({ width: `${ANCHO}px`, height: `${ALTO}px`, printBackground: true, pageRanges: "1" }),
      );
      continue;
    }

    // PowerPoint: primero el texto, después la foto sin él.
    const bloques = await leerTexto(pagina, caja);
    const quitar = await pagina.addStyleTag({ content: CSS_SIN_TEXTO });
    const fondo = await pagina.screenshot({ type: "jpeg", quality: 88, clip: caja });
    await quitar.evaluate((el) => el.remove());

    const hoja = pptx.addSlide();
    hoja.background = { data: `image/jpeg;base64,${fondo.toString("base64")}` };
    for (const b of bloques) agregarTexto(hoja, b);
    // Las notas del presentador viven ocultas en la diapositiva (data-notas).
    const notas = await pagina.evaluate(() =>
      [...document.querySelectorAll("[data-multtti-activa] [data-notas]")]
        .map((e) => e.textContent.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join("\n\n"),
    );
    if (notas) hoja.addNotes(notas);
  }

  let archivo;
  if (formato === "pdf") {
    const junto = await PDFDocument.create();
    for (const bytes of pdfs) {
      const uno = await PDFDocument.load(bytes);
      const [p] = await junto.copyPages(uno, [0]);
      junto.addPage(p);
    }
    archivo = Buffer.from(await junto.save()).toString("base64");
  } else {
    archivo = await pptx.write({ outputType: "base64" });
  }

  await navegador.close();
  await salir({ ok: true, archivo, diapositivas: total, titulo });
} catch (err) {
  await navegador?.close().catch(() => {});
  await salir({ ok: false, error: String(err).split("\n")[0].slice(0, 300) });
}

/**
 * Pide la diapositiva n como lo haría la persona (#n) y espera a que se vea.
 * Devuelve su caja en la página, o null si no apareció.
 */
async function mostrar(pagina, n) {
  const visible = () =>
    pagina.evaluate((n) => {
      const d = document.querySelectorAll("[data-diapositiva]")[n - 1];
      document.querySelectorAll("[data-multtti-activa]").forEach((e) => e.removeAttribute("data-multtti-activa"));
      if (!d) return null;
      d.setAttribute("data-multtti-activa", "");
      const r = d.getBoundingClientRect();
      const cs = getComputedStyle(d);
      if (r.width < 10 || r.height < 10 || cs.display === "none" || cs.opacity === "0") return null;
      return { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.min(r.width, innerWidth), height: Math.min(r.height, innerHeight) };
    }, n);

  await pagina.evaluate((n) => {
    location.hash = `#${n}`;
  }, n);
  await esperarQueSeAcomode(pagina);
  let caja = await visible();
  if (!caja) {
    // Hay presentaciones que leen #n solo al cargar: se recarga ahí mismo.
    await pagina.reload({ waitUntil: "load" });
    await pagina.addStyleTag({ content: CSS_SOLO_LA_ACTIVA });
    await esperarQueSeAcomode(pagina);
    caja = await visible();
  }
  return caja;
}

async function esperarQueSeAcomode(pagina) {
  await pagina.evaluate(async () => {
    await document.fonts?.ready;
    await Promise.all(
      [...document.images]
        .filter((i) => !i.complete)
        .map((i) => new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 5000); })),
    );
  });
  await pagina.waitForTimeout(250);
}

/**
 * Los bloques de texto de la diapositiva, como el navegador los dibujó.
 *
 * Un bloque es un elemento que no es "inline" y tiene texto propio: un título,
 * un párrafo, un item. Sus spans (un acento de color, una negrita) entran como
 * tramos del mismo bloque con su propio estilo. El texto de los SVG no se toca:
 * va en la foto del fondo, junto con su dibujo.
 */
async function leerTexto(pagina, caja) {
  return pagina.evaluate((caja) => {
    const raiz = document.querySelector("[data-multtti-activa]");
    const bloques = [];
    const esInline = (el) => getComputedStyle(el).display.startsWith("inline") && el.tagName !== "IMG";
    const color = (c) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return { hex: "000000", alfa: 1 };
      const [r, g, b, a = "1"] = m[1].split(/[ ,/]+/).filter(Boolean);
      const hex = [r, g, b].map((v) => Math.round(parseFloat(v)).toString(16).padStart(2, "0")).join("");
      return { hex, alfa: parseFloat(a) };
    };
    const tramosDe = (el, estiloPadre) => {
      const tramos = [];
      for (const nodo of el.childNodes) {
        if (nodo.nodeType === Node.TEXT_NODE) {
          const t = nodo.textContent.replace(/\s+/g, " ");
          if (t.trim() || (t === " " && tramos.length)) tramos.push({ texto: t, ...estiloPadre });
        } else if (nodo.nodeType === Node.ELEMENT_NODE) {
          if (nodo.tagName === "BR") tramos.push({ texto: "\n", ...estiloPadre });
          else if (nodo.closest("svg")) continue;
          else if (esInline(nodo)) tramos.push(...tramosDe(nodo, estilo(nodo)));
        }
      }
      return tramos;
    };
    const estilo = (el) => {
      const cs = getComputedStyle(el);
      return {
        color: color(cs.color),
        negrita: parseInt(cs.fontWeight, 10) >= 600,
        cursiva: cs.fontStyle === "italic",
        tamano: parseFloat(cs.fontSize),
        mayusculas: cs.textTransform === "uppercase",
      };
    };
    for (const el of [raiz, ...raiz.querySelectorAll("*")]) {
      if (el.closest("svg") || el.closest("[data-notas]") || esInline(el)) continue;
      const tieneTextoPropio = [...el.childNodes].some(
        (n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim(),
      ) || [...el.children].some((c) => esInline(c) && c.textContent.trim() && !c.closest("svg"));
      if (!tieneTextoPropio) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const pl = parseFloat(cs.paddingLeft), pr = parseFloat(cs.paddingRight);
      const pt = parseFloat(cs.paddingTop), pb = parseFloat(cs.paddingBottom);
      const tramos = tramosDe(el, estilo(el));
      if (!tramos.some((t) => t.texto.trim())) continue;
      const tam = parseFloat(cs.fontSize);
      const alto = cs.lineHeight === "normal" ? tam * 1.2 : parseFloat(cs.lineHeight);
      bloques.push({
        x: r.left + pl - caja.x,
        y: r.top + pt - caja.y,
        ancho: r.width - pl - pr,
        alto: r.height - pt - pb,
        letra: cs.fontFamily.split(",")[0].replace(/["']/g, "").trim(),
        alinear: ["center", "right", "justify"].includes(cs.textAlign) ? cs.textAlign : "left",
        interlineado: alto,
        espaciado: cs.letterSpacing === "normal" ? 0 : parseFloat(cs.letterSpacing),
        tramos,
      });
    }
    return bloques;
  }, caja);
}

function agregarTexto(hoja, b) {
  const pulgadas = (px) => px / PX_POR_PULGADA;
  // Las letras del sistema no existen en PowerPoint con ese nombre: se usa la
  // equivalente que sí tiene casi cualquier computadora.
  const genericas = { "system-ui": "Segoe UI", "sans-serif": "Arial", serif: "Georgia", monospace: "Consolas", "-apple-system": "Segoe UI" };
  const letra = genericas[b.letra] ?? b.letra;
  // Un poco de holgura: PowerPoint mide la letra distinto y sin esto la última
  // palabra de cada línea brinca a la siguiente.
  const holgura = 1.04;
  const tramos = b.tramos.map((t, i, todos) => ({
    text: (t.mayusculas ? t.texto.toUpperCase() : t.texto).replace(/^ +/, i === 0 ? "" : " ").replace(/ +$/, i === todos.length - 1 ? "" : " "),
    options: {
      color: t.color.hex,
      transparency: Math.round((1 - t.color.alfa) * 100),
      bold: t.negrita,
      italic: t.cursiva,
      fontSize: t.tamano * PT_POR_PX,
      breakLine: false,
    },
  }));
  hoja.addText(tramos, {
    x: pulgadas(b.x),
    y: pulgadas(b.y),
    w: pulgadas(b.ancho * holgura),
    h: pulgadas(b.alto),
    fontFace: letra,
    align: b.alinear,
    valign: "top",
    margin: 0,
    lineSpacing: b.interlineado * PT_POR_PX,
    charSpacing: b.espaciado * PT_POR_PX,
    fit: "none",
    wrap: true,
  });
}
