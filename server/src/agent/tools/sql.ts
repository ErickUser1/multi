import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Tool, ToolError, reqString } from "./base.js";
import { politicasAbiertas, type PoliticaAbierta } from "./politicas.js";

/**
 * Cambiar la estructura de la base que la sala conectó.
 *
 * Por qué existe: la llave que queda en el `.env` es la pública, y con ella se
 * leen y escriben DATOS pero no se crean tablas. Sin esta tool, el agente llega
 * hasta el esquema y ahí se para a pedirle a alguien que lo pegue a mano en el
 * panel de Supabase, que es justo la fricción que la integración venía a quitar.
 * Pasó en la primera prueba, y el agente lo dijo con todas sus letras.
 *
 * La credencial no entra al contenedor. El agente manda el SQL y quien lo corre
 * es el server, con el permiso que la sala ya concedió. Es la misma asimetría
 * de siempre: el agente pide, el motor decide con qué.
 *
 * Cada cambio queda además como archivo en `migraciones/`, con su fecha. Así la
 * base se puede rehacer desde cero, y el historial de la sala cuenta cómo llegó
 * a su forma actual en vez de solo cómo quedó.
 */
export const sqlTool: Tool = {
  spec: {
    name: "sql",
    description:
      "Corre SQL de ESTRUCTURA contra la base de datos de la sala: crear tablas, índices, " +
      "políticas de RLS, funciones. Para leer o escribir FILAS no uses esto, usa el cliente " +
      "de la base desde el código de la app con las variables del .env. " +
      "Toda tabla nueva nace con RLS activo, así que crea también sus políticas o la app " +
      "no va a poder leer nada. Nunca desactives RLS, y no escribas políticas using (true) " +
      "ni with check (true) para escribir: la base tiene login anónimo, así que cada fila " +
      "puede compararse con auth.uid().",
    input_schema: {
      type: "object",
      properties: {
        sql: {
          type: "string",
          description: "El SQL a ejecutar. Puede llevar varias sentencias.",
        },
        descripcion: {
          type: "string",
          description:
            "Qué hace este cambio, en pocas palabras y en minúsculas con guiones, " +
            "ej. crea-tabla-reseñas. Se usa para nombrar el archivo de migración.",
        },
      },
      required: ["sql", "descripcion"],
    },
  },
  async run(input, ctx) {
    const sql = reqString(input, "sql");
    const descripcion = reqString(input, "descripcion");

    if (!ctx.ejecutarSql) {
      throw new ToolError(
        "esta sala no tiene base de datos conectada. Se conecta desde el panel de Variables, " +
          "con el botón de Supabase. Dilo en el chat y sigue con lo que sí puedas hacer.",
      );
    }

    // Se revisa ANTES de correr: una política abierta de escritura que ya se
    // aplicó deja la base expuesta aunque el agente la corrija en la siguiente
    // vuelta, y mientras tanto cualquiera con la llave pública puede escribir.
    const abiertas = politicasAbiertas(sql);
    if (abiertas.escritura.length > 0) {
      throw new ToolError(
        `no se corrió nada: ${listar(abiertas.escritura)} deja que CUALQUIERA con la llave ` +
          "pública escriba, porque la llave va en el código de la app. Eso es RLS prendido que " +
          "no protege nada. La base tiene login anónimo: la app llama " +
          "supabase.auth.signInAnonymously() al arrancar si no hay sesión, cada fila guarda a " +
          "su dueño (una columna uuid con default auth.uid()), y la política compara contra " +
          "eso, ej. with check (auth.uid() = user_id). Si otra persona tiene que poder tocar " +
          "la fila (un familiar, un miembro del equipo), la política lo pregunta con un exists " +
          "sobre la tabla que guarda esa relación.",
      );
    }

    await ctx.ejecutarSql(sql);

    // La migración se guarda DESPUÉS de que corrió, no antes: un archivo que
    // describe un cambio que falló es peor que no tenerlo, porque quien rehaga
    // la base desde estos archivos acabaría con un esquema que nunca existió.
    const sello = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const limpia = descripcion
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);
    const dir = join(ctx.workspaceDir, "migraciones");
    await mkdir(dir, { recursive: true });
    const archivo = `${sello}-${limpia || "cambio"}.sql`;
    await writeFile(join(dir, archivo), sql.trim() + "\n", "utf8");

    ctx.emit?.({ type: "file:changed", path: `migraciones/${archivo}`, action: "write" });

    const listo = `listo. El cambio quedó en migraciones/${archivo}`;
    // Leer abierto sí puede ser lo correcto (un menú, un catálogo), así que no
    // se frena: se avisa, que es quien sabe qué guarda la tabla el que decide.
    if (abiertas.lectura.length === 0) return listo;
    return (
      `${listo}\n\nOjo: ${listar(abiertas.lectura)} deja que CUALQUIERA lea la tabla ` +
      "entera con la llave pública. Si es contenido público está bien. Si guarda datos de " +
      "personas (nombres, teléfonos, ubicaciones, mensajes), cámbiala ya por una que use " +
      "auth.uid(): que cada quien lea lo suyo y lo de quienes tiene vinculados."
    );
  },
};

function listar(politicas: PoliticaAbierta[]): string {
  const nombres = politicas.map((p) => `"${p.nombre}" (${p.para})`).join(", ");
  return politicas.length === 1 ? `la política ${nombres}` : `las políticas ${nombres}`;
}
