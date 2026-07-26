# soul.md — Multijugador

Fuente de verdad del alma del proyecto. Los agentes leen esto ANTES de diseñar o generar cualquier pantalla. `DESIGN.md` dice QUÉ construimos; este archivo dice QUÉ SE SIENTE.

## El manifiesto (por qué existe)

Dos compas quisieron construir un proyecto juntos. Uno en Lovable, otro en Claude Code. Sus agentes nunca se conocieron: dos backends divergentes, caja negra mutua, y al final hubo que pegar todo "casi con pegamento". El proyecto sufrió no por falta de talento sino porque **no existía ningún lugar donde construir JUNTOS**.

Las mejores herramientas de la historia ganaron al volverse multijugador: Google Docs mató a Word, Figma a Photoshop. La IA todavía es single-player — chats privados, transcripts muertos. Este producto es el momento multijugador de la IA, para la gente que más lo necesita y que nadie atiende: **duos y trios de vibe-coders sin empresa, sin proceso, sin repo compartido** — compas que se juntan por Discord/X a construir algo un fin de semana.

## La narrativa (cómo se cuenta)

**Un Discord, pero en vez de jugar videojuegos con tus compas, te juntas para vibecodear.**

La gente YA se junta en videollamada a "vibecodear juntos" y choca (cada quien en su tool). Nosotros somos el lugar que le falta a eso. No "IA multijugador" (suena enterprise) — es juntarte con tus amigos a crear, como un hangout de Discord.

Motor emocional (no "diversión" genérica): **ambición compartida** (construir una idea que te emociona con alguien que se emociona igual) + **el loop de avance duplicado** (ves tu victoria y la de tu compa en el mismo canvas). El momento real no es el output — es la PLÁTICA mientras el agente construye (el futuro, el producto). Eso es lo más difícil de copiar. Contra Replit (equipos de trabajo, cerrado) somos lo opuesto: compas, Discord, open source, de-la-comunidad.

## La frase que lo define todo (por dentro)

**Todos están y comparten el mismo proyecto en tiempo real. Tú ves lo que hace tu compañero, y viceversa.**

## Cómo se debe SENTIR

- **Como un videojuego, no como una herramienta.** Entras a una sala con tus compas, hay presencia, hay voto ("¿por aquí o por acá?"), hay "we, mejor así" y todos de acuerdo. La diversión ES el producto. Si se siente enterprise, fallamos.
- **Como Google Docs en la tarea de equipo:** link, hoja en blanco, se organizan hablando, y ves la hoja llenarse en vivo. Nadie administra nada. Nadie configura nada.
- **Magia sin ceremonia:** no existe "guardar", no existen commits ni push ni dashboards. Todo se guarda solo. El historial es un scrubber de tiempo que arrastras.
- **Cero caja negra:** no hay sesiones privadas. Todo lo que un agente hace, todos lo ven hacerse. Abres la sala y SABES — nadie te tiene que narrar nada.

## Principios de diseño (no negociables)

1. La visibilidad ES la coordinación. Sin locks, sin contratos visibles, sin permisos.
2. El estado es la interfaz. Si alguien necesita un resumen, el canvas falló.
3. El código es el formato de archivo, no la interfaz. Nadie lo edita a mano.
4. Los conflictos casi no existen; cuando existen, son un momento del juego (votar), no un merge.
5. El chat crea, el click señala, el lenguaje no tiene techo. Cero panels de propiedades, cero knobs — knob por knob se construye un Wix y matamos la customización.

## Las pantallas (lo que hay que diseñar)

1. **La Sala** — la pantalla principal: chat compartido (humanos + agente con presencia) + preview vivo de la app. El documento es la app corriendo.
2. **El Canvas del back** — el backend desabstraído: tablas como diagrama vivo, endpoints con semáforo (punteado=mock, sólido=real, rojo=atención). Se ve como territorio, no como texto.
3. **El Scrubber** — la línea de tiempo: arrastras y ves el proyecto construirse. "Regresar aquí" en un click.
4. **El momento cero** — crear sala / entrar con link + nombre. 60 segundos que deciden si se siente videojuego o herramienta.

## Anti-referencias (lo que NO somos)

- NO Lovable/bolt: esos son single-player. No competimos con ellos, somos otra categoría.
- NO GitHub/IDE: nada de branches, diffs, terminal a la vista. Eso vive abajo, invisible.
- NO Wix: nada de catálogos de componentes ni panels de propiedades.
- NO enterprise SaaS: nada de admin, roles, onboarding wizard, tours de producto.

## Dirección estética

**Lo que hay que transmitir: compañerismo, amistad, equipo.** Esta es el ancla emocional de todo el diseño. No "productividad" (eso es Ace), no "velocidad" (eso es Lovable) — **construir con tus amigos**. Cada decisión visual se mide contra esto: ¿se siente como quedarse a jugar con tus compas, o como entrar a trabajar?

Traducción a diseño:

- **Las personas siempre presentes y siempre humanas:** avatares cálidos con nombre, cursores vivos, se nota quién está y qué mira. La sala nunca se siente vacía ni anónima — se siente habitada.
- **Calidez sobre frialdad:** colores con temperatura, esquinas suaves, microanimaciones juguetonas. Nada de gris corporativo, nada de minimalismo clínico.
- **Los momentos se celebran juntos:** primer preview que carga, endpoint que se pone verde, versión marcada — pequeñas celebraciones compartidas (todos las ven al mismo tiempo). Los logros son del equipo, no del individuo.
- **El tono del copy es de compas:** cercano, directo, con humor — "¿por aquí o por acá?", no "seleccione una opción". Español natural, cero corporativés.
- **La energía del lobby de juego:** entrar a la sala se siente como entrar al voice chat con tus amigos — te esperaban, hay algo pasando, quieres quedarte.
- El preview de la app del usuario es el protagonista visual; nuestra UI es el marco, no la estrella.

### Mood board (leído de `moodboard/`, 4 conceptos)

- **insp3 — Cozy pixel/lofi (EL MUNDO, base de la UI):** cuartos habitados y cálidos (fantasmita gamer, Pikachu con té, Gengar bajo la lluvia). Luz cálida de interior, atardecer, lluvia afuera / refugio adentro. Paleta: morados/azules noche + ámbar/naranja de lámpara. Detalles pixel-art, texturas de cuarto vivido (posters en la pared, tazas, plantas). La sala del proyecto se siente como ESTOS cuartos: te esperaban, hay algo pasando, quieres quedarte.
- **insp4 — JDM sticker culture (LA ENERGÍA):** stickers, badges, collage, negro/blanco/rojo, caos juguetón. Uso: celebraciones (endpoint verde = sticker que cae en el chat), reacciones, logros del equipo, personalidad de los avatares. Energía de calcomanías en laptop.
- **insp1 — Ciudades en el cielo (LA METÁFORA GRANDE):** no solo Ícaro — civilizaciones enteras construidas sobre las nubes: torres góticas, puentes imposibles, cúpulas doradas. Metáfora exacta del producto: **dos compas construyendo un mundo imposible arriba de las nubes.** Uso: momentos de elevación — crear la sala, marcar una versión, la identidad visual del proyecto creciendo como ciudad. Paleta: blanco/dorado/azul cielo.
- **insp2 — Cartel editorial dramático (LA PORTADA):** tipografía gigante, grano, estatuas — pero NO solo B&N solemne: el caballero rosa con rosas de púas mete color y humor al drama (hasta se burla de la UI con su "Remind me later"). Drama juguetón, portada de revista con guiño. Uso: cada sala/proyecto tiene su portada auto-generada estilo cartel; pantallas de identidad, no de trabajo.

Síntesis: **el mundo es cozy-lofi (insp3), la energía es sticker (insp4), los momentos épicos son míticos/editoriales (insp1+2).** La UI diaria vive en insp3; los otros aparecen en los picos emocionales.
