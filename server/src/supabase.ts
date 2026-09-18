import { createHash, randomBytes } from "node:crypto";

/**
 * Conectar una sala con Supabase, para que su app tenga base de datos.
 *
 * El problema que resuelve: hoy, cuando una app necesita guardar datos que
 * varias personas comparten, el agente pide credenciales por el panel de
 * Variables. Quien no sabe qué es una anon key se queda ahí, y quien sí sabe
 * puede pegar la equivocada — Supabase da dos llaves, y la `service_role` se
 * salta todas las reglas de acceso. Nada distinguía una de otra.
 *
 * Con esto la persona aprieta un botón, autoriza en Supabase, y Multi crea el
 * proyecto y saca la llave correcta. Nadie pega nada a mano.
 *
 * El proyecto es DE LA PERSONA, no de Multi: vive en su cuenta, lo ve en su
 * panel, y si desconecta aquí, allá sigue existiendo. Multi guarda el permiso
 * para administrarlo, no la propiedad.
 *
 * Por qué integrar y no construir un backend propio: eso es lo que hizo Base44,
 * y son meses de trabajo más infraestructura permanente. Lo que Multi aporta
 * está en `armarRls` de más abajo, que es donde la integración de Lovable se
 * queda corta.
 */

const API = "https://api.supabase.com";

export interface CredencialSupabase {
  clientId: string;
  clientSecret: string;
}

/**
 * Las credenciales del `.env`, o null si quien corre Multi no las puso.
 *
 * Se lee en cada llamada y no al arrancar, igual que `credencialDeGoogle`:
 * agregarlas no debe obligar a reiniciar. Sin ellas no aparece el botón de
 * conectar y Multi funciona igual que siempre.
 */
export function credencialDeSupabase(): CredencialSupabase | null {
  const clientId = process.env.SUPABASE_CLIENT_ID;
  const clientSecret = process.env.SUPABASE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

// ── El ida y vuelta con Supabase ────────────────────────────────────────────

/**
 * Lo que está en vuelo mientras la persona decide en la pantalla de Supabase.
 *
 * Igual que en `cuentas.ts`, vive en memoria y dura lo que tarda alguien en
 * apretar un botón: si el server reinicia a media autorización, se vuelve a
 * intentar. Lo que se guarda aquí, además del vencimiento, es a qué SALA
 * pertenece esta vuelta (el callback es uno solo para todas) y el verificador
 * de PKCE, que no puede viajar por la URL.
 */
interface EnVuelo {
  expira: number;
  roomId: string;
  verificador: string;
}
const enVuelo = new Map<string, EnVuelo>();
const VIDA_STATE_MS = 10 * 60 * 1000;

function limpiarStates(): void {
  const ahora = Date.now();
  for (const [s, v] of enVuelo) if (v.expira < ahora) enVuelo.delete(s);
}

/**
 * Arranca una autorización: devuelve el `state` que va en la URL y el
 * `code_challenge` que Supabase va a exigir de vuelta.
 *
 * PKCE porque su documentación lo recomienda con énfasis: el verificador se
 * queda aquí y solo el hash viaja, así que un código interceptado en la vuelta
 * no sirve sin el secreto que nunca salió del server.
 */
export function nuevaAutorizacion(roomId: string): { state: string; challenge: string } {
  limpiarStates();
  const state = randomBytes(16).toString("base64url");
  const verificador = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verificador).digest("base64url");
  enVuelo.set(state, { expira: Date.now() + VIDA_STATE_MS, roomId, verificador });
  return { state, challenge };
}

/** ¿Esta vuelta corresponde a una ida nuestra? Consume el state: es de un solo uso. */
export function consumirState(state: string | undefined): EnVuelo | null {
  if (!state) return null;
  const v = enVuelo.get(state);
  // Se borra SIEMPRE, aunque esté vencido: así un replay falla incluso si el
  // original era válido. Mismo criterio que en cuentas.ts.
  enVuelo.delete(state);
  if (!v || v.expira < Date.now()) return null;
  return v;
}

/** A dónde mandar a la persona para que Supabase le pregunte si nos deja administrar su cuenta. */
export function urlDeAutorizacion(
  cred: CredencialSupabase,
  state: string,
  challenge: string,
  redirectUri: string,
): string {
  const params = new URLSearchParams({
    client_id: cred.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${API}/v1/oauth/authorize?${params}`;
}

export interface Tokens {
  acceso: string;
  refresco: string;
  /** Cuándo caduca el de acceso, en milisegundos. */
  expiraEn: number;
}

/**
 * La credencial del cliente como cabecera básica.
 *
 * Así lo pide el estándar y así lo documenta Supabase: el secreto va en la
 * cabecera y no en el cuerpo.
 */
function basica(cred: CredencialSupabase): string {
  return `Basic ${Buffer.from(`${cred.clientId}:${cred.clientSecret}`).toString("base64")}`;
}

function aTokens(datos: Record<string, unknown>): Tokens | null {
  const acceso = datos.access_token;
  const refresco = datos.refresh_token;
  if (typeof acceso !== "string" || typeof refresco !== "string") return null;
  // Si no dice cuánto dura, se asume corto y se refresca antes: equivocarse por
  // abajo cuesta una llamada de más, por arriba cuesta un 401 en mitad de algo.
  const segundos = typeof datos.expires_in === "number" ? datos.expires_in : 3600;
  return { acceso, refresco, expiraEn: Date.now() + segundos * 1000 };
}

/** Cambia el código que Supabase devolvió por los tokens. Null si no lo acepta. */
export async function intercambiarCodigo(
  cred: CredencialSupabase,
  code: string,
  verificador: string,
  redirectUri: string,
): Promise<Tokens | null> {
  try {
    const res = await fetch(`${API}/v1/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basica(cred),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: verificador,
      }),
    });
    if (!res.ok) {
      console.error(`[supabase] rechazó el código: ${res.status}`);
      return null;
    }
    return aTokens((await res.json()) as Record<string, unknown>);
  } catch (err) {
    console.error("[supabase] no se pudo hablar con la API:", err);
    return null;
  }
}

/**
 * Renueva el token de acceso con el de refresco.
 *
 * Devuelve null también cuando la persona revocó el acceso desde su panel de
 * Supabase. Quien llama lo trata como desconexión y no como un fallo pasajero:
 * reintentar no va a arreglarlo, hay que volver a autorizar.
 */
export async function refrescar(
  cred: CredencialSupabase,
  refreshToken: string,
): Promise<Tokens | null> {
  try {
    const res = await fetch(`${API}/v1/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basica(cred),
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
    });
    if (!res.ok) {
      console.error(`[supabase] no renovó el token: ${res.status}`);
      return null;
    }
    return aTokens((await res.json()) as Record<string, unknown>);
  } catch (err) {
    console.error("[supabase] no se pudo renovar el token:", err);
    return null;
  }
}

// ── La Management API ───────────────────────────────────────────────────────

export class FalloDeSupabase extends Error {}

async function pedir<T>(acceso: string, ruta: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${ruta}`, {
    ...init,
    headers: {
      authorization: `Bearer ${acceso}`,
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const detalle = await res.text().catch(() => "");
    throw new FalloDeSupabase(`${ruta} respondió ${res.status}: ${detalle.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export interface Organizacion {
  id: string;
  name: string;
  slug?: string;
}

export async function organizaciones(acceso: string): Promise<Organizacion[]> {
  return pedir<Organizacion[]>(acceso, "/v1/organizations");
}

export interface Proyecto {
  id: string;
  /** El identificador corto que va en la URL de la base. */
  ref?: string;
  name: string;
  status?: string;
  region?: string;
}

/**
 * Crea un proyecto y devuelve su referencia.
 *
 * La contraseña de Postgres la genera quien llama y se guarda cifrada, porque
 * Supabase NO la devuelve nunca: su documentación dice que no se puede
 * recuperar por la API. Si se pierde, se pierde para siempre, y la única salida
 * es resetearla desde su panel.
 */
export async function crearProyecto(
  acceso: string,
  datos: { nombre: string; organizacion: string; password: string; region: string },
): Promise<Proyecto> {
  return pedir<Proyecto>(acceso, "/v1/projects", {
    method: "POST",
    body: JSON.stringify({
      name: datos.nombre,
      organization_slug: datos.organizacion,
      db_pass: datos.password,
      region: datos.region,
    }),
  });
}

/** Cómo va el aprovisionamiento. Un proyecto recién creado tarda en estar listo. */
export async function estadoDeProyecto(acceso: string, ref: string): Promise<string> {
  const p = await pedir<Proyecto>(acceso, `/v1/projects/${ref}`);
  return p.status ?? "UNKNOWN";
}

/**
 * Espera a que el proyecto termine de levantarse.
 *
 * Tarda minutos, no segundos: hay que crear una base de verdad del otro lado.
 * `onEspera` existe para que la sala vea que sigue vivo, igual que `onEtapa` en
 * `publicar.ts`: una espera que se entiende se siente mucho más corta.
 */
export async function esperarProyecto(
  acceso: string,
  ref: string,
  onEspera?: (segundos: number) => void,
  topeMs = 10 * 60 * 1000,
): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < topeMs) {
    const estado = await estadoDeProyecto(acceso, ref).catch(() => "UNKNOWN");
    if (estado === "ACTIVE_HEALTHY") return;
    onEspera?.(Math.round((Date.now() - t0) / 1000));
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new FalloDeSupabase("el proyecto tardó demasiado en levantarse");
}

/**
 * La llave PÚBLICA del proyecto, la que va al navegador.
 *
 * Solo se lee la `anon`, y la `service_role` se ignora a propósito aunque venga
 * en la misma respuesta: esa se salta todas las reglas de acceso, y una app de
 * puro front no tiene dónde esconderla — lo que el navegador usa, el navegador
 * lo enseña. Si no se lee, no se puede filtrar.
 */
export async function anonKey(acceso: string, ref: string): Promise<string> {
  const llaves = await pedir<{ name: string; api_key: string }[]>(
    acceso,
    `/v1/projects/${ref}/api-keys`,
  );
  const anon = llaves.find((k) => k.name === "anon");
  if (!anon) throw new FalloDeSupabase("el proyecto no devolvió su llave pública");
  return anon.api_key;
}

/** Corre SQL en el proyecto. */
export async function ejecutarSql(acceso: string, ref: string, query: string): Promise<void> {
  await pedir(acceso, `/v1/projects/${ref}/database/query`, {
    method: "POST",
    body: JSON.stringify({ query }),
  });
}

/**
 * Deja el proyecto de modo que TODA tabla nueva nazca con RLS activo.
 *
 * Esta es la pieza que separa esto de la integración de Lovable, y es una sola
 * sentencia. El problema que cubre está medido: ellos crean las tablas con
 * `CREATE TABLE` y no activan Row Level Security, así que cualquiera con la
 * llave pública lee la base entera. En enero de 2025 eso expuso más de 170 de
 * sus apps, y en auditorías de 2026 el 63% seguía con fallas críticas o altas.
 *
 * No hay ajuste de proyecto que se pueda prender por API (el endpoint de
 * configuración de Postgres no expone nada de RLS). Lo que la casilla de su
 * panel hace por debajo es esto: un event trigger, que Supabase documentó en
 * 2025 justo para las tablas creadas por herramientas externas.
 *
 * `FORCE` y no solo `ENABLE` porque en Supabase el dueño de la tabla se salta
 * las políticas, y el dueño es quien las crea. Sin FORCE, quedarían activas
 * para todos menos para el camino que más importa vigilar.
 */
export async function armarRls(acceso: string, ref: string): Promise<void> {
  await ejecutarSql(
    acceso,
    ref,
    `
    create or replace function public.multi_rls_automatico()
      returns event_trigger
      language plpgsql
      as $$
    declare obj record;
    begin
      for obj in
        select * from pg_event_trigger_ddl_commands()
        where command_tag = 'CREATE TABLE' and schema_name = 'public'
      loop
        execute format('alter table %s enable row level security', obj.object_identity);
        execute format('alter table %s force row level security', obj.object_identity);
      end loop;
    end;
    $$;

    drop event trigger if exists multi_rls_automatico;
    create event trigger multi_rls_automatico
      on ddl_command_end
      when tag in ('CREATE TABLE')
      execute function public.multi_rls_automatico();
    `,
  );
}

/** La URL pública de la base de un proyecto. */
export function urlDelProyecto(ref: string): string {
  return `https://${ref}.supabase.co`;
}

/** Una contraseña de Postgres que nadie va a teclear, así que puede ser larga. */
export function nuevaPassword(): string {
  return randomBytes(24).toString("base64url");
}
