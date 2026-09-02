# `write_file` pisa el trabajo de otro agente sin avisar

Encontrado el 2 de septiembre de 2026, observando a dos agentes trabajar en
paralelo sobre el mismo proyecto.

## Lo que protege el CAS y lo que no

`edit_file` manda `expected` (el contenido que el agente leyó), asi que pasa por
la escritura condicional: si el archivo cambio, la escritura se rechaza y se le
dice al modelo que lo relea.

`write_file` **no manda `expected`** (`fs.ts:62`, es explicito: *"write es
incondicional (crear/sobrescribir a proposito)"*). Reemplaza el archivo entero
sin verificar nada.

Y tiene que ser asi: si `write_file` verificara, no se podrian crear archivos
nuevos.

## El hueco

**El orden decide si se pierde trabajo.**

| Primero | Despues | Resultado |
|---|---|---|
| `write_file` de A | `edit_file` de B | B recibe el aviso, relee, reaplica. **Nada se pierde.** |
| `edit_file` de A | `write_file` de B | B pisa el archivo entero. **El cambio de A se pierde en silencio.** |

Sin error, sin aviso, y sin que B se entere de que borro algo.

## El caso real que lo mostro

Dos agentes en la sala del juego PSX. El agente-1 rehacia la mecanica completa
(reglas del gerente, reloj de turno, contador de errores) y el agente-2 arreglaba
el parpadeo de los clientes. Los dos tocaron `main.ts`.

Salio bien **por el orden**: el agente-1 hizo su `write_file` primero, y cuando el
agente-2 intento su `edit_file`, el CAS lo rechazo. Su propia explicacion:

> "Ese `edit_file` falló, porque el texto exacto que yo esperaba encontrar ya no
> estaba: el agente 1 había reescrito el archivo mientras tanto. Esa falla es
> justamente la protección. Ante ese aviso, releí el archivo completo y reapliqué
> mi cambio sobre esa versión actualizada. No fue timing de suerte solamente:
> hubo timing, pero también hubo una salvaguarda que detectó el desfase."

Al reves se habria perdido el trabajo del agente-2 sin que nadie lo notara.

## Por que no se arreglo todavia

Cerrar esto es un cambio de diseño, no una guarda:

- Hacer `write_file` condicional rompe la creacion de archivos nuevos.
- Una condicion del tipo "verifica solo si el archivo ya existe" obligaria al
  agente a leer antes de sobrescribir a proposito, que es un caso legitimo.
- Y un `write_file` sobre un archivo que otro agente acaba de tocar puede ser
  perfectamente valido: rehacer un archivo entero es parte del trabajo.

Lo que si es barato y no se ha hecho: **avisar**. Cuando un `write_file` pisa un
archivo que otro agente escribio hace poco, `FileMutation` ya sabe quien fue el
ultimo escritor (`lastWriter`). Decirselo al modelo ("acabas de reemplazar un
archivo que agente-2 escribio hace 8s") no impide nada pero deja de ser silencioso.

## Lo que esto significa para el capitulo

Es el limite concreto de la capa tecnica, y encaja con lo que ya esta escrito en
el estado del arte: el CAS protege archivos de escrituras simultaneas, pero no
evita que dos agentes trabajen sobre premisas incompatibles. La coordinacion de
la intencion es de la capa humana, la del chat compartido.

Relacionado: `server/src/engine/file-mutation.ts`, `server/src/agent/tools/fs.ts`.
