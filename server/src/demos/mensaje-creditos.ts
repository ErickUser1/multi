import { explicarFallaDelProveedor, SIN_SALDO_DE_MULTI } from "../engine/fallas.js";

/**
 * Demo: a quien no puso key no se le dice que recargue "su" saldo.
 * Uso: npm run demo:mensaje-creditos
 *
 * El bug que cubre, visto en una sesión real: la key de respaldo (la de quien
 * corre Multi) se quedó sin saldo, y a una persona le salió dos veces "se
 * acabaron los créditos de tu cuenta. Pon otra key o recarga saldo". No tenía
 * cuenta ni key: el mensaje la mandaba a arreglar algo que no era suyo.
 *
 * Los textos de error son los reales de la API (o los que arman los proveedores
 * de Multi a partir de ellos).
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

const SIN_CREDITOS =
  'ProviderError: request inválido (400): {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}';
const KEY_MALA = "ProviderError: key inválida (401)";
const LIMITE = "ProviderError: rate limit (429)";
const TECHO = "ProviderError: openrouter: el techo de salida no cabe en el saldo de la key.";

/** Lo que no se le puede decir a quien no puso key. */
const LE_HABLA_DE_SU_CUENTA = /de tu cuenta|tu saldo|tu API key|pon otra key|recarga|el panel/i;

function main() {
  console.log("=== Mensajes de error según de quién es la key ===\n");

  console.log("1. Con la key de respaldo (la de Multi)");
  const sinCreditos = explicarFallaDelProveedor(SIN_CREDITOS, true);
  check("sin créditos: dice que el saldo es de Multi", sinCreditos === SIN_SALDO_DE_MULTI, sinCreditos);
  for (const [nombre, err] of [["sin créditos", SIN_CREDITOS], ["key inválida", KEY_MALA], ["límite de uso", LIMITE], ["techo de salida", TECHO]]) {
    const m = explicarFallaDelProveedor(err, true);
    check(`${nombre}: no le habla de SU cuenta ni de SU key`, !LE_HABLA_DE_SU_CUENTA.test(m), m);
  }

  console.log("\n2. Con la key propia de la persona: igual que antes");
  check("sin créditos: le dice que recargue", explicarFallaDelProveedor(SIN_CREDITOS, false).includes("recarga saldo"));
  check("key inválida: le dice que la revise", explicarFallaDelProveedor(KEY_MALA, false).includes("API key no es válida"));
  check("límite: le sugiere otra key", explicarFallaDelProveedor(LIMITE, false).includes("otra key"));

  console.log(`\n${pass} pasaron, ${fail} fallaron`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
