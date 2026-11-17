import { anclasDe, textoDeAnclas, anclaDelMensaje, parseIntent, tituloDesde, MAX_ANCLAS } from "../rooms.js";

/**
 * Demo: seleccionar varios elementos del preview para un mismo mensaje.
 * Uso: npm run demo:seleccion-multiple
 *
 * Lo que se protege:
 * - Que con UN elemento todo quede exactamente como antes (el texto que lee
 *   el agente, lo que se guarda del mensaje).
 * - Que con varios el agente los reciba todos, numerados igual que en la sala.
 * - Que una pestaña o un mensaje en cola de antes (`anchor`, uno solo) siga
 *   llegando bien.
 * - Que lo que manda el navegador se limpie: basura, repetidos y el tope.
 *
 * Sin server: las funciones puras de rooms.ts.
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  [ok] ${name}`);
  } else {
    fail++;
    console.log(`  [X]  ${name} ${detail}`);
  }
}

const boton = { selector: "main > button.comprar", tag: "button", text: "Comprar", path: "main > button.comprar" };
const titulo = { selector: "h1#titulo", tag: "h1", text: "Mi tienda", path: "h1#titulo" };
const foto = { selector: "main > img:nth-of-type(2)", tag: "img", text: "", path: "main > img:nth-of-type(2)" };

console.log("=== Selección múltiple ===\n");

console.log("1. Un elemento: igual que siempre");
check(
  "el texto para el agente no cambió",
  textoDeAnclas([boton]) ===
    `[El usuario seleccionó este elemento del preview: <button> con el texto "Comprar", ubicado en "main > button.comprar". Encuentra el código correspondiente y aplica el cambio que pide abajo a ESE elemento.]`,
  textoDeAnclas([boton]),
);
check("se guarda su ruta, como antes", anclaDelMensaje([boton]) === "main > button.comprar");
check("sin elementos no se guarda nada", anclaDelMensaje([]) === undefined);

console.log("\n2. Varios elementos");
const t = textoDeAnclas([boton, titulo, foto]);
check("dice cuántos", t.startsWith("[El usuario seleccionó 3 elementos del preview:"), t);
check("los numera en orden", t.includes('1) <button> con el texto "Comprar"') && t.includes('2) <h1> con el texto "Mi tienda"') && t.includes("3) <img>, ubicado en"), t);
check("pide el cambio en todos", t.includes("a ESOS elementos"), t);
const guardado = anclaDelMensaje([boton, titulo, foto])!;
check("el mensaje guarda las tres rutas", guardado === "3 elementos: main > button.comprar · h1#titulo · main > img:nth-of-type(2)", guardado);
const largos = Array.from({ length: 8 }, (_, i) => ({ ...boton, selector: `s${i}`, path: `main > section.muy-larga-${"x".repeat(60)}-${i}` }));
check("y se recorta si es muy largo", anclaDelMensaje(largos)!.length <= 300);

console.log("\n3. Lo que llega del navegador");
check("la lista pasa igual", JSON.stringify(anclasDe({ anchors: [boton, titulo] })) === JSON.stringify([boton, titulo]));
check("`anchor` de antes es una lista de uno", JSON.stringify(anclasDe({ anchor: boton })) === JSON.stringify([boton]));
check("sin nada, vacía", anclasDe({}).length === 0 && anclasDe({ anchor: null }).length === 0);
check("basura se descarta", anclasDe({ anchors: [42, "x", null, { tag: "p" }, boton] }).length === 1);
check("los repetidos cuentan una vez", anclasDe({ anchors: [boton, boton, titulo] }).length === 2);
const muchos = Array.from({ length: 12 }, (_, i) => ({ ...boton, selector: `s${i}` }));
check(`se topa en ${MAX_ANCLAS}`, anclasDe({ anchors: muchos }).length === MAX_ANCLAS);
check("sin path usa el selector", anclasDe({ anchors: [{ selector: "a.x", tag: "a" }] })[0]?.path === "a.x");

console.log("\n4. Con elementos anclados el mensaje es una orden");
check("con varios, aunque no lleve @", parseIntent("pónganlos rojos", anclasDe({ anchors: [boton, titulo] }).length > 0).kind === "spawn");
check("sin elementos sigue siendo plática", parseIntent("pónganlos rojos", false).kind === "talk");

console.log("\n5. El nombre automático de la sala sale de lo que escribió la persona");
const pedido = `${textoDeAnclas([boton, titulo, foto])}\n\npónganlos rojos y más grandes`;
check("no del texto de los elementos", tituloDesde(pedido) === "Pónganlos rojos y más grandes", tituloDesde(pedido));
check("con uno, igual", tituloDesde(`${textoDeAnclas([boton])}\n\nhaz una tienda de café`) === "Tienda de café", tituloDesde(`${textoDeAnclas([boton])}\n\nhaz una tienda de café`));
check("sin nada antepuesto, como siempre", tituloDesde("Hazme una página de mi graduación") === "Página de mi graduación", tituloDesde("Hazme una página de mi graduación"));

console.log(`\n${pass} pasaron, ${fail} fallaron`);
process.exit(fail > 0 ? 1 : 0);
