import type { Room } from "../rooms.js";
import {
  configurarCupo,
  esperarLugarParaTurno,
  formarParaPreview,
  hacerLugar,
  hayLugarPara,
  ocupaLugar,
  posicionEnFila,
  reiniciarCupo,
  revisar,
  sePuedeDormirYa,
} from "../engine/cupo.js";

/**
 * Verifica el tope de salas activas y su fila.
 * Uso: npm run demo:tope-salas
 *
 * Lo que se protege, en orden de gravedad:
 * - Que una sala que ya trabaja NUNCA espere ni se duerma para hacerle lugar a
 *   otra. El tope existe para que no se caiga nadie; si le corta algo a quien
 *   ya estaba, hizo lo mismo que venía a evitar.
 * - Que la fila avance: la que espera entra sola, en orden, y un lugar que se
 *   apartó y no se usó vuelve.
 * - Que con el tope apagado (0) todo sea como antes.
 *
 * Las salas son de mentira, como en demo:dormir: el tope solo mira campos del
 * Room, así que no hacen falta contenedores ni dev servers.
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

interface Opciones {
  conGente?: boolean;
  conPreview?: boolean;
  agenteTrabajando?: boolean;
  previewBooting?: boolean;
  publicando?: boolean;
  turnosEnCurso?: number;
  vaciaHaceMin?: number;
}

function sala(id: string, o: Opciones = {}): Room {
  const members = new Map<string, unknown>();
  if (o.conGente) members.set("sock-" + id, { name: "alguien" });
  return {
    id,
    preview: o.conPreview ? ({ stop: async () => {} } as never) : null,
    members,
    coordinator: { activeKeys: () => (o.agenteTrabajando ? [id + ":agente-1"] : []) },
    previewBooting: o.previewBooting ?? false,
    publicando: o.publicando ? "compilando" : null,
    turnosEnCurso: o.turnosEnCurso ?? 0,
    vaciaDesde: o.conGente ? undefined : Date.now() - (o.vaciaHaceMin ?? 1) * 60_000,
  } as unknown as Room;
}

/** Arma el entorno del tope con estas salas. Devuelve qué se durmió y a quién se le dio lugar. */
function entorno(salas: Room[]) {
  const dormidas: string[] = [];
  const conLugar: string[] = [];
  reiniciarCupo();
  configurarCupo({
    salas: () => salas,
    dormir: async (r) => {
      dormidas.push(r.id);
      r.preview = null;
    },
    alHaberLugar: (r) => conLugar.push(r.id),
  });
  return { dormidas, conLugar };
}

async function main(): Promise<void> {
  console.log("=== Tope de salas activas ===\n");
  process.env.MULTI_MAX_SALAS_ACTIVAS = "3";

  console.log("1. Lleno: la 4ª se forma");
  {
    const a = sala("a", { conGente: true, conPreview: true });
    const b = sala("b", { conGente: true, conPreview: true });
    const c = sala("c", { conGente: true, conPreview: true });
    const d = sala("d", { conGente: true });
    const salas = [a, b, c, d];
    const { dormidas } = entorno(salas);
    check("con 3 trabajando, la 4ª no tiene lugar", !hayLugarPara(d));
    check("no se puede hacer lugar: las 3 tienen gente", !(await hacerLugar()));
    check("y no se durmió a nadie que estuviera dentro", dormidas.length === 0, JSON.stringify(dormidas));
    check("se forma en el lugar 1", formarParaPreview(d) === 1);
    check("formarse dos veces no la repite", formarParaPreview(d) === 1 && posicionEnFila("d") === 1);
  }

  console.log("\n2. Una sala que ya trabaja nunca espera");
  {
    const a = sala("a", { conGente: true, conPreview: true });
    const b = sala("b", { conGente: true, conPreview: true });
    const c = sala("c", { conGente: true, conPreview: true });
    entorno([a, b, c, sala("d", { conGente: true })]);
    check("su vista previa o su turno pasan aunque esté lleno", hayLugarPara(a) && hayLugarPara(c));
    const conTurno = sala("t", { turnosEnCurso: 1 });
    check("un agente trabajando cuenta como ocupar lugar", ocupaLugar(conTurno));
  }

  console.log("\n3. Para hacer lugar solo se duermen salas vacías e inactivas");
  {
    const vieja = sala("vacia-vieja", { conPreview: true, vaciaHaceMin: 20 });
    const reciente = sala("vacia-reciente", { conPreview: true, vaciaHaceMin: 2 });
    const llena = sala("con-gente", { conGente: true, conPreview: true });
    const nueva = sala("nueva", { conGente: true });
    const salas = [reciente, vieja, llena, sala("otra", { conGente: true, conPreview: true }), nueva];
    // 4 ocupando con tope 3: hay que dormir 2 para dejarle lugar a la nueva.
    const { dormidas } = entorno(salas);
    check("la nueva no cabe todavía", !hayLugarPara(nueva));
    check("hacer lugar lo consigue", await hacerLugar());
    check("se durmieron justo las dos vacías", dormidas.sort().join(",") === "vacia-reciente,vacia-vieja", JSON.stringify(dormidas));
    check("la de gente siguió con su vista previa", llena.preview !== null);
    check("y ahora la nueva sí cabe", hayLugarPara(nueva));

    const intocables = [
      sala("con-agente", { conPreview: true, agenteTrabajando: true }),
      sala("instalando", { conPreview: true, previewBooting: true }),
      sala("publicando", { conPreview: true, publicando: true }),
      sala("con-turno", { conPreview: true, turnosEnCurso: 1 }),
      sala("con-gente", { conGente: true, conPreview: true }),
    ];
    for (const r of intocables) check(`no se duerme: ${r.id}`, !sePuedeDormirYa(r));
    const { dormidas: d2 } = entorno([...intocables, sala("nueva", { conGente: true })]);
    await hacerLugar();
    check("aunque esté lleno, ninguna de esas se duerme", d2.length === 0, JSON.stringify(d2));
  }

  console.log("\n4. La fila avanza en orden");
  {
    const a = sala("a", { conGente: true, conPreview: true });
    const b = sala("b", { conGente: true, conPreview: true });
    const c = sala("c", { conGente: true, conPreview: true });
    const d = sala("d", { conGente: true });
    const e = sala("e", { conGente: true });
    const { conLugar } = entorno([a, b, c, d, e]);
    formarParaPreview(d);
    formarParaPreview(e);
    check("d es la 1 y e la 2", posicionEnFila("d") === 1 && posicionEnFila("e") === 2);
    await revisar();
    check("lleno: nadie entra todavía", conLugar.length === 0);
    a.preview = null; // se paró la vista previa de a
    await revisar();
    check("al liberarse un lugar entra la primera (d)", conLugar.join(",") === "d", JSON.stringify(conLugar));
    check("e sigue formada, ahora en el lugar 1", posicionEnFila("e") === 1);
    check("d tiene su lugar apartado mientras arranca", ocupaLugar(d));
    check("y por eso e no se le cuela", !hayLugarPara(e));

    d.reservaHasta = Date.now() - 1; // el arranque de d nunca llegó
    check("un lugar apartado que no se usó caduca solo", !ocupaLugar(d));
  }

  console.log("\n5. Una sala que se quedó sin nadie sale de la fila");
  {
    const salas = [
      sala("a", { conGente: true, conPreview: true }),
      sala("b", { conGente: true, conPreview: true }),
      sala("c", { conGente: true, conPreview: true }),
    ];
    const sola = sala("se-fueron", { conGente: true });
    const { conLugar } = entorno([...salas, sola]);
    formarParaPreview(sola);
    sola.members.clear();
    salas[0].preview = null;
    await revisar();
    check("no se le gasta el lugar a una sala vacía", conLugar.length === 0 && posicionEnFila("se-fueron") === 0);
  }

  console.log("\n6. Los turnos esperan su lugar, y se pueden interrumpir");
  {
    const salas = [
      sala("a", { conGente: true, conPreview: true }),
      sala("b", { conGente: true, conPreview: true }),
      sala("c", { conGente: true, conPreview: true }),
    ];
    const f = sala("f", { conGente: true });
    const g = sala("g", { conGente: true });
    entorno([...salas, f, g]);
    let entro = false;
    const espera = esperarLugarParaTurno(f).then(() => {
      entro = true;
    });
    const ctrl = new AbortController();
    const esperaG = esperarLugarParaTurno(g, ctrl.signal).then(
      () => "entró",
      () => "cancelada",
    );
    check("f en el lugar 1, g en el 2", posicionEnFila("f") === 1 && posicionEnFila("g") === 2);
    ctrl.abort();
    check("interrumpir a g la cancela", (await esperaG) === "cancelada");
    check("y la saca de la fila", posicionEnFila("g") === 0);
    await revisar();
    check("lleno: f sigue esperando", !entro);
    salas[1].preview = null;
    await revisar();
    await espera;
    check("al haber lugar, el turno de f entra", entro);
    check("con su lugar apartado", ocupaLugar(f));
  }

  console.log("\n7. Con el tope en 0, como antes");
  {
    process.env.MULTI_MAX_SALAS_ACTIVAS = "0";
    const muchas = Array.from({ length: 50 }, (_, i) => sala("s" + i, { conGente: true, conPreview: true }));
    const nueva = sala("nueva", { conGente: true });
    const { dormidas } = entorno([...muchas, nueva]);
    check("nadie espera", hayLugarPara(nueva));
    check("y no se duerme a nadie", (await hacerLugar()) && dormidas.length === 0);
    delete process.env.MULTI_MAX_SALAS_ACTIVAS;
    check("sin configurar, el tope es 20", (() => {
      const veinte = Array.from({ length: 20 }, (_, i) => sala("v" + i, { conGente: true, conPreview: true }));
      const otra = sala("otra", { conGente: true });
      entorno([...veinte, otra]);
      const lleno = !hayLugarPara(otra);
      veinte[0].preview = null;
      return lleno && hayLugarPara(otra);
    })());
  }

  reiniciarCupo();
  console.log(`\n${pass} ok, ${fail} fallaron`);
  if (fail > 0) process.exit(1);
}

void main();
