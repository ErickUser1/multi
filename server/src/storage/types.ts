import type { Message } from "../agent/providers/types.js";

/**
 * Capa de persistencia de Multi.
 *
 * Abstracta a propósito: SQLite es el default (clonas el repo y corre, cero
 * setup — importante para open source), pero la interfaz deja la puerta abierta
 * a Postgres/Supabase cuando haya varios servidores.
 */

export interface StoredRoom {
  id: string;
  workspaceDir: string;
  createdAt: number;
  lastActiveAt: number;
  /**
   * Cómo le dice la gente a esta sala. Null hasta que alguien la nombre, y
   * entonces la interfaz cae al id.
   *
   * Es de la SALA, no de quien la nombró: la ven todos los que entren. El id
   * sigue siendo lo que va en la URL y lo que se dicta por teléfono, así que
   * renombrar no rompe ningún link ya compartido.
   */
  nombre?: string | null;
  /** Dónde quedó publicada la app, o null si la sala nunca se publicó. */
  urlPublicada?: string | null;
  /**
   * Si en esta sala hay que mencionar al agente para despertarlo.
   *
   * En "multi" sí, que es la regla de siempre: el chat sirve para hablar entre
   * personas sin gastar tokens, y `@agente` es lo que permite lanzar varios en
   * paralelo. En "solo" no hace falta, porque no hay con quién platicar.
   *
   * Null es "multi", y eso importa: las salas que ya existían se comportan
   * exactamente igual que antes de que esto existiera.
   */
  modo?: ModoDeSala | null;
}

/**
 * Cuánta gente asume una sala.
 *
 * Nace en "solo" porque así llega todo el mundo, y porque la mención fue lo
 * primero con lo que se toparon las cuatro personas que llegaron por su cuenta:
 * las cuatro escribieron sin `@agente` y las cuatro recibieron silencio.
 */
export type ModoDeSala = "solo" | "multi";

export interface StoredMessage {
  roomId: string;
  author: string;
  color: string;
  role: "human" | "agent" | "system";
  text: string;
  anchoredTo?: string;
  /** Las imágenes que venían con el mensaje. Solo los datos para mostrarlas. */
  adjuntos?: { id: string; nombre: string; mediaType: string }[];
  createdAt: number;
  /**
   * Quién lo escribió, si tenía cuenta. Null para todo lo anterior a las
   * cuentas y para quien entra sin una, que es un caso normal y para siempre.
   *
   * Sirve para pintar su foto: el `author` es texto libre y no alcanza, porque
   * dos personas distintas pueden haberse llamado igual en salas distintas.
   */
  usuarioId?: string | null;
  /**
   * La foto de quien lo escribió, resuelta al leer (no se guarda en la fila).
   *
   * Se resuelve en la consulta y no se congela a propósito: si cambias tu foto,
   * tus mensajes viejos muestran la nueva, que es lo que la gente espera. El
   * `color` sí va congelado, y esa incoherencia es vieja y no vale una migración.
   */
  foto?: string | null;
}

/**
 * Una persona con cuenta.
 *
 * Tener cuenta es OPCIONAL y lo seguirá siendo: se entra a cualquier sala con
 * el link y nada más, como siempre. Esto es solo para quien quiere que sus
 * salas le sigan entre dispositivos y que su cara y su nombre sean los mismos
 * en todas.
 */
export interface StoredUsuario {
  id: string;
  /** El identificador de Google. Único y estable aunque cambie de correo. */
  googleSub: string;
  nombre: string;
  correo: string;
  /** La URL de la foto que da Google. Null si su cuenta no tiene. */
  foto?: string | null;
  creadoEn: number;
}

/**
 * La conexión de una sala con Supabase, para que su app tenga base de datos.
 *
 * Es DE LA SALA y no de quien la conectó: quien entra con el link la hereda y
 * puede construir sobre esa base sin volver a autorizar nada. Es la misma
 * decisión que el resto de la sala (lo que hay dentro es de quien tenga el
 * link), y tiene la misma consecuencia: hoy los ids se pueden adivinar, así que
 * acertar uno da acceso a la cuenta de Supabase de quien conectó. Está en el
 * ROADMAP junto a los permisos de sala.
 *
 * Los tokens y la contraseña se guardan CIFRADOS (ver `cripto.ts`). Aquí viajan
 * ya en claro: cifrar y descifrar es trabajo de la implementación, para que
 * quien use esto no pueda olvidarse.
 */
export interface ConexionSupabase {
  roomId: string;
  acceso: string;
  refresco: string;
  /** Cuándo caduca el de acceso, en milisegundos. */
  expiraEn: number;
  /** El identificador corto del proyecto. Null mientras se está creando. */
  proyecto?: string | null;
  /**
   * La contraseña de Postgres que Multi generó.
   *
   * Se guarda porque Supabase NO la devuelve nunca: su documentación dice que
   * no se puede recuperar por la API. Si Multi no la guardara, se perdería para
   * siempre y la única salida sería resetearla desde su panel.
   */
  password?: string | null;
  conectadoEn: number;
}

/** Una sala que alguien con cuenta visitó, para que le siga entre dispositivos. */
export interface SalaDeUsuario {
  roomId: string;
  visitadaEn: number;
  /** Como le dice la gente. Null si nadie la ha nombrado: ahi se ve el id. */
  nombre?: string | null;
}

export interface Storage {
  /** Crea el esquema si hace falta. */
  init(): Promise<void>;

  createRoom(room: StoredRoom): Promise<void>;
  getRoom(id: string): Promise<StoredRoom | null>;
  listRooms(): Promise<StoredRoom[]>;
  /** Marca actividad reciente (para saber qué salas siguen vivas). */
  touchRoom(id: string): Promise<void>;
  /**
   * Anota dónde quedó publicada la app.
   *
   * Se guarda para que al volver mañana la sala siga sabiendo que está en vivo:
   * sin esto, la única señal de que se publicó era un mensaje en el chat que se
   * pierde entre los demás.
   */
  setUrlPublicada(id: string, url: string): Promise<void>;
  /** Le pone nombre a la sala. `null` lo quita y se vuelve a ver el id. */
  renameRoom(id: string, nombre: string | null): Promise<void>;
  /** Si en esta sala hay que mencionar al agente para despertarlo. */
  setModo(id: string, modo: ModoDeSala): Promise<void>;
  /**
   * Borra la sala y todo lo suyo: mensajes e historiales de agentes.
   *
   * Solo la parte de base de datos. El workspace en disco y el contenedor los
   * quita quien llama, porque no viven aquí.
   */
  deleteRoom(id: string): Promise<void>;

  appendMessage(msg: StoredMessage): Promise<void>;
  /** Los mensajes de una sala, en orden. */
  getMessages(roomId: string, limit?: number): Promise<StoredMessage[]>;

  /** Historial de conversación de un agente (para que continúe donde iba). */
  saveAgentHistory(roomId: string, agentId: string, messages: Message[]): Promise<void>;
  getAgentHistory(roomId: string, agentId: string): Promise<Message[]>;
  /**
   * Los agentes que han existido en una sala.
   *
   * Sin esto, al reiniciar el server la sala despierta con el registro vacío y
   * el contador en cero: el siguiente agente vuelve a llamarse "agente-1", el
   * menú de menciones sale vacío, y se pierde con quién venías conversando.
   */
  listAgentIds(roomId: string): Promise<string[]>;

  // ── Cuentas ───────────────────────────────────────────────────────────────
  //
  // Todo lo de aquí es opcional en el sentido literal: si nadie se registra,
  // estas tablas quedan vacías y Multi funciona igual que siempre.

  /** El usuario de esa cuenta de Google, o null si nunca ha entrado. */
  usuarioPorGoogleSub(googleSub: string): Promise<StoredUsuario | null>;
  crearUsuario(usuario: StoredUsuario): Promise<void>;
  /**
   * Refresca lo que Google nos dice de alguien que ya tenía cuenta.
   *
   * Se llama en cada entrada: si cambió su nombre o su foto allá, aquí se ve.
   * Es más barato que un botón de "actualizar perfil" que nadie apretaría.
   */
  actualizarUsuario(id: string, datos: { nombre: string; correo: string; foto: string | null }): Promise<void>;

  /** Quién es el dueño de esta sesión, o null si no vale o ya expiró. */
  usuarioPorSesion(token: string): Promise<StoredUsuario | null>;
  crearSesion(token: string, usuarioId: string, expiraEn: number): Promise<void>;
  borrarSesion(token: string): Promise<void>;
  /** Limpia las que ya vencieron. Se llama al arrancar, no con un timer. */
  borrarSesionesVencidas(): Promise<void>;

  /** Las salas de alguien con cuenta, de la más reciente a la más vieja. */
  salasDeUsuario(usuarioId: string): Promise<SalaDeUsuario[]>;
  recordarSalaDeUsuario(usuarioId: string, roomId: string): Promise<void>;
  olvidarSalaDeUsuario(usuarioId: string, roomId: string): Promise<void>;

  // ── Supabase ──────────────────────────────────────────────────────────────
  //
  // Opcional igual que las cuentas: si nadie conecta una base, esta tabla queda
  // vacía y Multi funciona como siempre.

  /**
   * La conexión de esta sala, o null si no tiene.
   *
   * También devuelve null si lo guardado no se puede descifrar, que pasa cuando
   * alguien cambió `MULTI_LLAVE`. Ahí la respuesta correcta es tratar la sala
   * como no conectada y pedir la autorización otra vez.
   */
  conexionSupabase(roomId: string): Promise<ConexionSupabase | null>;
  guardarConexionSupabase(conexion: ConexionSupabase): Promise<void>;
  borrarConexionSupabase(roomId: string): Promise<void>;

  close(): Promise<void>;
}
