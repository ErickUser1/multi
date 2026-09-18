import { cifrar, descifrar, hayLlave, SinLlave } from "../cripto.js";

/**
 * Demo: el cifrado de lo que Multi guarda a disco.
 * Uso: npm run demo:cripto
 *
 * Lo que importa comprobar aquí es que un token guardado NO se pueda leer con
 * otra llave, porque esa es la única razón por la que este módulo existe. Lo
 * demás (que dé la vuelta completa, que detecte manipulación) es lo que sostiene
 * esa promesa.
 *
 * No necesita red, ni servidor, ni base de datos: pone la llave en el entorno y
 * prueba el módulo.
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

// Un token de los de verdad, para que el tamaño y el alfabeto sean realistas.
const TOKEN = "sbp_v0_" + "a1b2c3d4e5f6".repeat(4);

async function main() {
  console.log("\n=== cifrado de secretos ===\n");

  console.log("1. Sin llave configurada, no se puede guardar nada");
  delete process.env.MULTI_LLAVE;
  check("hayLlave dice que no", !hayLlave());
  let tiro = false;
  try {
    cifrar("lo que sea");
  } catch (e) {
    tiro = e instanceof SinLlave;
  }
  check("cifrar avisa en vez de guardar en claro", tiro);

  console.log("\n2. Con llave, da la vuelta completa");
  process.env.MULTI_LLAVE = "una frase larga que alguien puso en su .env";
  check("hayLlave dice que sí", hayLlave());
  const guardado = cifrar(TOKEN);
  check("vuelve igual", descifrar(guardado) === TOKEN, String(descifrar(guardado)));

  console.log("\n3. Lo guardado no se parece al original");
  check("el token no se ve", !guardado.includes(TOKEN));
  check("ni un trozo suyo", !guardado.includes("a1b2c3d4"));
  check("cabe en una columna de texto", /^[A-Za-z0-9_.\-]+$/.test(guardado), guardado.slice(0, 40));

  console.log("\n4. Dos cifrados del mismo texto son distintos");
  // Si el IV no fuera aleatorio, dos salas con el mismo token se verían iguales
  // en la base, y eso ya dice algo que no debería decirse.
  check("no se repiten", cifrar(TOKEN) !== cifrar(TOKEN));

  console.log("\n5. Con otra llave no se lee");
  process.env.MULTI_LLAVE = "otra frase completamente distinta";
  check("devuelve null, no basura", descifrar(guardado) === null, String(descifrar(guardado)));

  console.log("\n6. Un valor manipulado se detecta");
  process.env.MULTI_LLAVE = "una frase larga que alguien puso en su .env";
  const partes = guardado.split(".");
  // Cambiar un carácter de los datos: con CBC esto devolvería basura silenciosa.
  const ultimo = partes[2];
  const tocado = [partes[0], partes[1], (ultimo[0] === "A" ? "B" : "A") + ultimo.slice(1)].join(".");
  check("no lo da por bueno", descifrar(tocado) === null, String(descifrar(tocado)));

  console.log("\n7. Un texto que no salió de aquí tampoco pasa");
  check("formato inválido", descifrar("cualquier cosa") === null);
  check("vacío", descifrar("") === null);

  console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\ndemo falló:", err);
  process.exit(1);
});
