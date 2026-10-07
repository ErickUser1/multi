/**
 * Las gráficas del documento, dibujadas aquí como SVG.
 *
 * El agente escribe un bloque ```grafica con JSON y esto lo pinta. Propio y no
 * una librería de gráficas: tres tipos cubren casi todo lo que cabe en un
 * documento, pesa nada, y el mismo dibujo puede salir igual al exportar.
 *
 * Todo texto que viene del JSON pasa por `esc`: lo escribió un modelo, y se
 * mete como HTML.
 */

export interface Grafica {
  tipo: "barras" | "lineas" | "pastel";
  titulo?: string;
  etiquetas: string[];
  series: { nombre?: string; datos: number[] }[];
}

const COLORES = ["#ff4d1c", "#4f9dff", "#3ecf8e", "#f5b83d", "#b07cff", "#ff6fa8", "#5ad1d1"];

function esc(t: unknown): string {
  return String(t ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Lee y valida el JSON del bloque. null si no se entiende. */
export function leerGrafica(texto: string): Grafica | null {
  let g: unknown;
  try {
    g = JSON.parse(texto);
  } catch {
    return null;
  }
  if (!g || typeof g !== "object") return null;
  const o = g as Record<string, unknown>;
  const tipo = o.tipo === "lineas" || o.tipo === "pastel" ? o.tipo : "barras";
  const etiquetas = Array.isArray(o.etiquetas) ? o.etiquetas.map((e) => String(e)).slice(0, 60) : [];
  const series = (Array.isArray(o.series) ? o.series : [])
    .map((s) => s as { nombre?: unknown; datos?: unknown })
    .filter((s) => Array.isArray(s.datos))
    .map((s) => ({
      nombre: typeof s.nombre === "string" ? s.nombre : undefined,
      datos: (s.datos as unknown[]).map((d) => (typeof d === "number" && Number.isFinite(d) ? d : 0)).slice(0, 60),
    }))
    .slice(0, 8);
  if (series.length === 0 || etiquetas.length === 0) return null;
  return { tipo, titulo: typeof o.titulo === "string" ? o.titulo : undefined, etiquetas, series };
}

function numero(n: number): string {
  if (Math.abs(n) >= 1000) return n.toLocaleString("es-MX", { maximumFractionDigits: 0 });
  return String(Math.round(n * 100) / 100);
}

function leyenda(series: Grafica["series"], y: number): string {
  if (series.length < 2) return "";
  let x = 60;
  return series
    .map((s, i) => {
      const t = esc(s.nombre ?? `Serie ${i + 1}`);
      const parte = `<rect x="${x}" y="${y - 10}" width="12" height="12" rx="2" fill="${COLORES[i % COLORES.length]}"/><text x="${x + 18}" y="${y}" class="g-texto">${t}</text>`;
      x += 30 + t.length * 7;
      return parte;
    })
    .join("");
}

function ejes(g: Grafica): string {
  const W = 760;
  const H = 360;
  const izq = 60;
  const der = 20;
  const arriba = g.titulo ? 44 : 20;
  const abajo = 56 + (g.series.length > 1 ? 24 : 0);
  const ancho = W - izq - der;
  const alto = H - arriba - abajo;
  const todos = g.series.flatMap((s) => s.datos);
  const max = Math.max(0, ...todos);
  const min = Math.min(0, ...todos);
  const rango = max - min || 1;
  const yDe = (v: number) => arriba + alto - ((v - min) / rango) * alto;

  let svg = "";
  // Rejilla con cinco marcas.
  for (let i = 0; i <= 4; i++) {
    const v = min + (rango * i) / 4;
    const y = yDe(v);
    svg += `<line x1="${izq}" x2="${W - der}" y1="${y}" y2="${y}" class="g-rejilla"/>`;
    svg += `<text x="${izq - 8}" y="${y + 4}" text-anchor="end" class="g-texto">${esc(numero(v))}</text>`;
  }

  const n = g.etiquetas.length;
  const paso = ancho / n;
  g.etiquetas.forEach((e, i) => {
    const x = izq + paso * i + paso / 2;
    svg += `<text x="${x}" y="${arriba + alto + 20}" text-anchor="middle" class="g-texto">${esc(e.slice(0, 18))}</text>`;
  });

  if (g.tipo === "barras") {
    const k = g.series.length;
    const anchoBarra = Math.max(2, (paso * 0.7) / k);
    g.series.forEach((s, si) => {
      s.datos.slice(0, n).forEach((v, i) => {
        const x = izq + paso * i + paso * 0.15 + anchoBarra * si;
        const y0 = yDe(0);
        const y = yDe(v);
        svg += `<rect x="${x}" y="${Math.min(y, y0)}" width="${anchoBarra - 2}" height="${Math.abs(y0 - y)}" rx="2" fill="${COLORES[si % COLORES.length]}"><title>${esc(e(g, i))}: ${esc(numero(v))}</title></rect>`;
      });
    });
  } else {
    g.series.forEach((s, si) => {
      const puntos = s.datos.slice(0, n).map((v, i) => `${izq + paso * i + paso / 2},${yDe(v)}`);
      const color = COLORES[si % COLORES.length];
      svg += `<polyline points="${puntos.join(" ")}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>`;
      s.datos.slice(0, n).forEach((v, i) => {
        svg += `<circle cx="${izq + paso * i + paso / 2}" cy="${yDe(v)}" r="3.5" fill="${color}"><title>${esc(e(g, i))}: ${esc(numero(v))}</title></circle>`;
      });
    });
  }

  svg += leyenda(g.series, H - 12);
  return marco(g, W, H, svg);
}

function e(g: Grafica, i: number): string {
  return g.etiquetas[i] ?? "";
}

function pastel(g: Grafica): string {
  const W = 760;
  const H = 340;
  const datos = g.series[0].datos.slice(0, g.etiquetas.length).map((v) => Math.max(0, v));
  const total = datos.reduce((a, b) => a + b, 0) || 1;
  const cx = 200;
  const cy = (g.titulo ? 44 : 20) + 130;
  const r = 120;
  let angulo = -Math.PI / 2;
  let svg = "";
  datos.forEach((v, i) => {
    const color = COLORES[i % COLORES.length];
    const parte = (v / total) * Math.PI * 2;
    const fin = angulo + parte;
    if (parte >= Math.PI * 2 - 1e-6) {
      svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>`;
    } else if (parte > 0) {
      const x1 = cx + r * Math.cos(angulo);
      const y1 = cy + r * Math.sin(angulo);
      const x2 = cx + r * Math.cos(fin);
      const y2 = cy + r * Math.sin(fin);
      const grande = parte > Math.PI ? 1 : 0;
      svg += `<path d="M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${grande} 1 ${x2},${y2} Z" fill="${color}"><title>${esc(g.etiquetas[i])}: ${esc(numero(v))}</title></path>`;
    }
    angulo = fin;
    const pct = Math.round((v / total) * 1000) / 10;
    const ly = cy - r + 10 + i * 24;
    svg += `<rect x="380" y="${ly - 11}" width="14" height="14" rx="3" fill="${color}"/>`;
    svg += `<text x="402" y="${ly}" class="g-texto">${esc(g.etiquetas[i].slice(0, 36))} · ${pct}%</text>`;
  });
  return marco(g, W, H, svg);
}

function marco(g: Grafica, W: number, H: number, cuerpo: string): string {
  const titulo = g.titulo
    ? `<text x="${W / 2}" y="26" text-anchor="middle" class="g-titulo">${esc(g.titulo)}</text>`
    : "";
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(g.titulo ?? "Gráfica")}" xmlns="http://www.w3.org/2000/svg">${titulo}${cuerpo}</svg>`;
}

/** El SVG de la gráfica, o null si el JSON no se entiende. */
export function graficaSvg(texto: string): string | null {
  const g = leerGrafica(texto);
  if (!g) return null;
  return g.tipo === "pastel" ? pastel(g) : ejes(g);
}
