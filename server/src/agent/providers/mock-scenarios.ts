import { MockProvider } from "./mock.js";

/**
 * Guion del agente simulado — SOLO para los demos automatizados.
 *
 * El server NO lo usa: siempre corre con el agente real, así no hay camino
 * falso en producción. Esto existe para que las verificaciones
 * (demo:concurrency, demo:historial, demo:persistence) no gasten API key.
 */
export function createDevMock(): MockProvider {
  return new MockProvider().scenario({
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
