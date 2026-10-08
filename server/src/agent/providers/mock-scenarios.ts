import { MockProvider } from "./mock.js";

/**
 * Guion del agente simulado — SOLO para los demos automatizados.
 *
 * El server NO lo usa: siempre corre con el agente real, así no hay camino
 * falso en producción. Esto existe para que las verificaciones
 * (demo:concurrency, demo:historial, demo:persistence) no gasten API key.
 */
/**
 * Lo que el agente simulado escribe en cada sección del documento, en orden.
 * Trae de todo lo que el documento sabe pintar, más intentos de colar código,
 * para que las pruebas de navegador vean que nada se ejecuta.
 */
const SECCIONES_SIMULADAS = [
  "## Resumen\n\nMulti es una **sala** donde varias personas construyen con IA. [Sitio](https://example.com)\n\n<img src=x onerror=\"window.__xss=1\">\n\n[malo](javascript:window.__xss=2)",
  '## Datos\n\n| Condición | Alumnos | Errores |\n| --- | --- | --- |\n| Solo | 13 | 6 |\n| Multi | 15 | 3 |\n\n```grafica\n{"tipo":"barras","titulo":"Errores <b>por</b> condición","etiquetas":["Solo","Multi"],"series":[{"nombre":"Errores","datos":[6,3]},{"nombre":"Aciertos","datos":[7,12]}]}\n```',
  '## Flujo\n\n```diagrama\n<svg viewBox="0 0 300 80" xmlns="http://www.w3.org/2000/svg" onload="window.__xss=3"><script>window.__xss=4</script><rect x="5" y="5" width="120" height="50" rx="6" fill="#ff4d1c" fill-opacity="0.18" stroke="currentColor"/><text data-id="t1" x="20" y="35" fill="currentColor">Persona</text><a href="javascript:window.__xss=5"><text x="160" y="35" fill="currentColor">Agente</text></a></svg>\n```\n\n![logo](imagenes/punto.png)',
];

/** La primera sección pendiente del índice que devuelve leer_documento. */
function primeraPendiente(leido: string): { id: string; huella: string; titulo: string } | null {
  const m = leido.match(/## «([^»]+)» seccion=(\S+) huella_seccion=(\S+) \(PENDIENTE\)/);
  return m ? { titulo: m[1], id: m[2], huella: m[3] } : null;
}

export function createDevMock(): MockProvider {
  return new MockProvider()
    .scenario({
      // Un documento: esqueleto primero y luego cada sección, leyendo los ids
      // de lo que devuelve la tool anterior, como lo hace el agente real.
      match: (t) => /propuesta|documento|reporte/i.test(t),
      reply: () => [
        { type: "text", text: "Lo armo como documento." },
        {
          type: "tool_use",
          id: "",
          name: "iniciar_documento",
          input: {
            titulo: "Propuesta de Multi",
            secciones: [
              { titulo: "Resumen", intencion: "Qué es Multi" },
              { titulo: "Datos", intencion: "Los números del piloto" },
              { titulo: "Flujo", intencion: "Cómo trabaja la sala" },
            ],
          },
        },
      ],
      seguir: (resultado) => {
        if (/^sección «/.test(resultado)) {
          return [{ type: "tool_use", id: "", name: "leer_documento", input: {} }];
        }
        const p = primeraPendiente(resultado);
        if (!p) return null;
        const i = ["Resumen", "Datos", "Flujo"].indexOf(p.titulo);
        return [
          { type: "text", text: `Ahora ${p.titulo.toLowerCase()}.` },
          {
            type: "tool_use",
            id: "",
            name: "escribir_seccion",
            input: { seccion: p.id, huella: p.huella, markdown: SECCIONES_SIMULADAS[i] ?? `## ${p.titulo}\n\nTexto.` },
          },
        ];
      },
    })
    .scenario({
    match: () => true,
    // ESCRIBE el archivo (no edita buscando texto): así cada turno produce un
    // cambio real y se puede ejercitar el historial varias veces. Con edit_file
    // solo funcionaría la primera vez — el texto buscado ya no estaría.
    reply: (userText) => [
      { type: "text", text: "Voy a tocar el App.jsx…" },
      {
        type: "tool_use",
        id: "",
        name: "write_file",
        input: {
          path: "src/App.jsx",
          content: [
            "export default function App() {",
            "  return (",
            "    <main style={{ fontFamily: 'system-ui', padding: 48, textAlign: 'center' }}>",
            "      <h1>Hola Multi</h1>",
            `      <p>${escapeJsx(userText).slice(0, 120)}</p>`,
            "    </main>",
            "  )",
            "}",
            "",
          ].join("\n"),
        },
      },
    ],
  });
}

/** Evita romper el JSX con caracteres que tienen significado ahí. */
function escapeJsx(s: string): string {
  return s.replace(/[<>{}]/g, "");
}
