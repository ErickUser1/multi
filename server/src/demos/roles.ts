import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Demo: los roles de una sala (dueño, editor, lector).
 * Uso: npm run demo:roles
 *
 * Lo que se protege:
 * - Que las salas de antes (sin dueño) sigan abiertas: todos editan.
 * - Que con los roles apagados (lo de siempre al crear) todos editen, y el
 *   dueño siga siendo dueño para poder prenderlos.
 * - Que el dueño se reconozca por su llave o su cuenta, y por nada más: el id
 *   del navegador se puede inventar.
 * - El orden: lo que el dueño da a alguien pesa más que el link.
 * - Que apagar y volver a prender los roles no pierda lo que el dueño dio.
 *
 * Sin server: las funciones de engine/roles.ts y la base, en un archivo temporal.
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

async function main() {
  console.log("=== Roles ===\n");
  const raiz = await mkdtemp(join(tmpdir(), "multi-roles-"));
  process.env.MULTI_DB = join(raiz, "multi.db");
  process.env.MULTI_SIN_AISLAMIENTO = "1";
  const { nuevaLlave, nuevoTokenEditar, hashLlave, rolEnSala, puedeEditar, claveDePersona, identidadDe } =
    await import("../engine/roles.js");
  const { createRoom } = await import("../rooms.js");
  const { getStorage } = await import("../storage/index.js");
  const storage = await getStorage();
  const dirs: string[] = [];

  try {
    console.log("1. Una sala de antes, sin dueño");
    const vieja = await createRoom();
    dirs.push(vieja.workspace.dir);
    let p = await storage.permisosDeSala(vieja.id);
    check("no tiene dueño", p.duenoLlave === null);
    check("cualquiera edita", rolEnSala(p, {}) === "editor");
    check("aunque traiga una llave inventada", rolEnSala(p, { llave: "lo-que-sea" }) === "editor");

    console.log("\n2. Una sala nueva: dueño, y roles apagados");
    const sala = await createRoom();
    dirs.push(sala.workspace.dir);
    const llave = nuevaLlave();
    const token = nuevoTokenEditar();
    await storage.fijarDueno(sala.id, { llave: hashLlave(llave), usuario: "u-erick", tokenEditar: token });
    p = await storage.permisosDeSala(sala.id);
    check("se guarda el hash, no la llave", p.duenoLlave === hashLlave(llave) && p.duenoLlave !== llave);
    check("los roles empiezan apagados", p.activos === false);
    check("el link da editar", p.acceso === "editar");
    check("con su llave es dueño", rolEnSala(p, { llave }) === "dueno");
    check("con su cuenta, desde otra compu, también", rolEnSala(p, { usuarioId: "u-erick" }) === "dueno");
    check("los demás editan, como antes", rolEnSala(p, { clienteId: "c-alumno-123" }) === "editor");
    check("una llave equivocada no es dueño", rolEnSala(p, { llave: nuevaLlave() }) === "editor");
    check("un hash en lugar de la llave tampoco", rolEnSala(p, { llave: p.duenoLlave! }) === "editor");

    console.log("\n3. El dueño prende los roles y pone el link en solo ver");
    await storage.activarRoles(sala.id, true);
    await storage.cambiarAcceso(sala.id, "ver");
    p = await storage.permisosDeSala(sala.id);
    check("quedan prendidos", p.activos === true && p.acceso === "ver");
    check("quien llega por el link solo ve", rolEnSala(p, { clienteId: "c-alumno-123" }) === "lector");
    check("y no puede editar", !puedeEditar(rolEnSala(p, { clienteId: "c-alumno-123" })));
    check("con el link para editar, edita", rolEnSala(p, { tokenEditar: token }) === "editor");
    check("con un código inventado, no", rolEnSala(p, { tokenEditar: "inventado" }) === "lector");
    check("el dueño sigue siendo dueño", rolEnSala(p, { llave }) === "dueno");

    console.log("\n4. Lo que el dueño da a cada quien pesa más que el link");
    const ana = { clienteId: "c-ana-navegador" };
    const beto = { usuarioId: "u-beto", clienteId: "c-beto-navegador" };
    await storage.fijarRol(sala.id, claveDePersona(ana)!, "editor");
    await storage.fijarRol(sala.id, claveDePersona(beto)!, "lector");
    p = await storage.permisosDeSala(sala.id);
    check("a Ana (sin cuenta) le dio editar", rolEnSala(p, ana) === "editor");
    check("con cuenta se guarda por la cuenta", claveDePersona(beto) === "u:u-beto");
    check("a Beto lo dejó en lector aunque traiga el link de editar", rolEnSala(p, { ...beto, tokenEditar: token }) === "lector");
    check("Beto desde otro navegador sigue siendo lector", rolEnSala(p, { usuarioId: "u-beto", clienteId: "c-otro" }) === "lector");
    await storage.fijarRol(sala.id, claveDePersona(beto)!, null);
    p = await storage.permisosDeSala(sala.id);
    check("quitarle el rol lo regresa a lo que da el link", rolEnSala(p, beto) === "lector" && !("u:u-beto" in p.roles));

    console.log("\n5. Apagar los roles: todos editan; prenderlos: vuelve lo de antes");
    await storage.activarRoles(sala.id, false);
    p = await storage.permisosDeSala(sala.id);
    check("apagados, el link de solo ver ya no frena a nadie", rolEnSala(p, { clienteId: "c-alumno-123" }) === "editor");
    check("ni lo que se le había dado a alguien", rolEnSala(p, beto) === "editor");
    check("el dueño sigue siendo dueño (para volver a prenderlos)", rolEnSala(p, { llave }) === "dueno");
    await storage.activarRoles(sala.id, true);
    p = await storage.permisosDeSala(sala.id);
    check("prendidos otra vez, Ana sigue de editora", rolEnSala(p, ana) === "editor");
    check("y el link sigue en solo ver", rolEnSala(p, { clienteId: "c-alumno-123" }) === "lector");

    console.log("\n6. Un código nuevo para el link de editar");
    const otro = nuevoTokenEditar();
    await storage.cambiarTokenEditar(sala.id, otro);
    p = await storage.permisosDeSala(sala.id);
    check("el viejo deja de servir", rolEnSala(p, { tokenEditar: token }) === "lector");
    check("el nuevo sí", rolEnSala(p, { tokenEditar: otro }) === "editor");

    console.log("\n7. La cuenta del dueño se liga después, una sola vez");
    const sinCuenta = await createRoom();
    dirs.push(sinCuenta.workspace.dir);
    const llave2 = nuevaLlave();
    await storage.fijarDueno(sinCuenta.id, { llave: hashLlave(llave2), usuario: null, tokenEditar: nuevoTokenEditar() });
    await storage.ligarCuentaDeDueno(sinCuenta.id, "u-erick");
    await storage.ligarCuentaDeDueno(sinCuenta.id, "u-intruso");
    p = await storage.permisosDeSala(sinCuenta.id);
    check("queda la primera cuenta", p.duenoUsuario === "u-erick");
    check("y la segunda no se la roba", rolEnSala(p, { usuarioId: "u-intruso" }) === "editor");

    console.log("\n8. Invitar por correo (con cuenta de Google)");
    const { normalizarCorreo, invitadosDe } = await import("../engine/roles.js");
    check("el correo se normaliza", normalizarCorreo("  Ana.Lopez@Gmail.com ") === "ana.lopez@gmail.com");
    check("lo que no es correo se rechaza", normalizarCorreo("ana") === null && normalizarCorreo("a b@c.com") === null);
    await storage.fijarRol(sala.id, "e:profe@escuela.mx", "editor");
    await storage.fijarRol(sala.id, "e:grupo@escuela.mx", "lector");
    p = await storage.permisosDeSala(sala.id);
    const profe = identidadDe({ usuarioId: "u-profe", correo: "Profe@Escuela.mx" });
    check("la profe invitada de editora edita (el link está en solo ver)", rolEnSala(p, profe) === "editor");
    check("desde cualquier navegador", rolEnSala(p, { ...profe, clienteId: "c-otra-compu" }) === "editor");
    check("el invitado de lector es lector aunque traiga el link de editar", rolEnSala(p, { correo: "grupo@escuela.mx", tokenEditar: otro }) === "lector");
    check("alguien sin cuenta no se cuela con ese correo", rolEnSala(p, { clienteId: "e:profe@escuela.mx" }) === "lector");
    check("la lista de invitados sale ordenada", JSON.stringify(invitadosDe(p)) === JSON.stringify([{ correo: "grupo@escuela.mx", rol: "lector" }, { correo: "profe@escuela.mx", rol: "editor" }]));
    await storage.activarRoles(sala.id, false);
    p = await storage.permisosDeSala(sala.id);
    check("con los roles apagados el invitado de lector edita", rolEnSala(p, { correo: "grupo@escuela.mx" }) === "editor");
    await storage.activarRoles(sala.id, true);
    await storage.fijarRol(sala.id, "e:profe@escuela.mx", null);
    p = await storage.permisosDeSala(sala.id);
    check("quitar la invitación la regresa a lo que da el link", rolEnSala(p, profe) === "lector");

    console.log("\n9. Lo que llega del navegador se limpia");
    const id = identidadDe({ llave: 42, tokenEditar: "x".repeat(500), clienteId: "", usuarioId: "u-1" });
    check("solo strings razonables", id.llave === null && id.tokenEditar === null && id.clienteId === null && id.usuarioId === "u-1");
  } finally {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    await rm(raiz, { recursive: true, force: true });
  }

  console.log(`\n${pass} pasaron, ${fail} fallaron`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("demo falló:", err);
  process.exit(1);
});
