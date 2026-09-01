# El preview que no arranca por un dev server zombi

Ocurrio UNA vez, el 1 de septiembre de 2026, en la sala `pixel-jam-25`.
**No es reproducible todavia.** Este documento existe para no investigar desde
cero si vuelve.

## Sintoma

La sala se queda en el spinner del preview para siempre. En los logs:

```
[sala X] falló el preview: Error: timeout esperando el dev server en :32816
```

y en el reintento:

```
[preview X] error when starting dev server:
[preview X] proceso terminó (code 1)
[sala X] falló el preview: Error: dev server terminó antes de responder (code 1)
```

## Que se encontro

Dentro del contenedor habia un Vite VIVO desde el primer intento, ocupando el
puerto interno:

```
root  180  node /work/node_modules/.bin/vite     # arrancado 8 minutos antes
```

Ese proceso se habia atado solo a `localhost` (su log decia
`Network: use --host to expose`), asi que Docker publicaba el puerto pero no
habia nada alcanzable desde el host. Multi espero los 5 minutos del timeout,
se rindio, y **no mato el proceso**.

## Por que se hizo visible ahi y no antes

El proyecto tenia `strictPort: true` en su `vite.config.ts`. Sin esa opcion,
Vite SALTA al siguiente puerto libre cuando encuentra uno ocupado, asi que el
zombi pasa desapercibido: el preview arranca igual, solo que en otro puerto.
El comentario de `preview.ts:150` ya describia ese caso ("5 procesos peleando y
un preview que no reflejaba los cambios").

Con `strictPort`, Vite no salta: muere con codigo 1. El zombi dejo de ser
invisible.

## La secuencia completa

1. Aparece el `package.json` → el motor arranca el preview de inmediato
2. En ese momento el `vite.config.ts` **todavia no existe**: ese Vite sale sin
   `--host` y no es alcanzable desde fuera del contenedor
3. Multi espera 5 minutos, falla, y deja el proceso vivo
4. El agente termina de escribir el `vite.config.ts`, ahora con `strictPort`
5. Todo reintento posterior choca con el zombi y muere con codigo 1

## Lo que NO es

- **No es "proyecto pesado".** Un YouTube con React arranco sin problema.
- **No es el motor pasando mal los flags.** En una sala sana el proceso corre
  como `vite --host --port 5173`, pero esos flags **los escribe el agente** en
  su script de `package.json`, no el motor.
- **No es Caddy ni el proxy.** El 503 venia de que Multi no tenia dev server al
  cual reenviar.

## Como se arreglo a mano

```bash
docker restart multi-room-<sala>   # mata el zombi y libera el puerto
systemctl restart multi            # OJO: hace falta, ver abajo
```

El `docker restart` **cambia el puerto publicado** (Multi crea los contenedores
con `-p 0:5173`, o sea "Docker elige"). Multi se queda con el viejo en memoria y
la sala sigue rota hasta reiniciar el servicio. Existe `readPublishedPort`, asi
que releerlo al reconectar seria el arreglo, si esto llega a repetirse.

## Por que no se arreglo

`killDevServersIn` YA existe y YA corre antes de cada arranque
(`preview.ts:150`). Si funcionara, el zombi habria muerto en el reintento de las
03:41 y no murio. **Puede que el bug este dentro de esa funcion**, no en donde
se llama, y en ese caso agregar otra llamada no arregla nada.

Con una sola ocurrencia y sin reproduccion, cualquier cambio es una apuesta
contra un camino que funciona el resto de las veces.

## Si vuelve a pasar

Antes de tocar nada, recoger esto:

```bash
docker exec multi-room-<sala> sh -c "ps aux | grep '[n]ode.*vite'"
docker port multi-room-<sala>
docker exec multi-room-<sala> sh -c "curl -sI http://localhost:5173 | head -2"
journalctl -u multi --no-pager -n 60 | grep -i "<sala>"
docker exec multi-room-<sala> sh -c "cat /work/package.json; cat /work/vite.config.*"
```

Con dos ocurrencias y sus datos ya se puede ver que tienen en comun.
