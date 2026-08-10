# La imagen de una sala: "una computadora sin nada".
#
# A propósito NO trae ningún stack del usuario. El agente instala lo que le pidan
# (python, go, deno, lo que sea) con sus tools, igual que trabajarías tú en una
# máquina limpia. Sembrar aquí un framework sería volver a la plantilla que el
# motor ya dejó de tener.
#
# Solo lleva lo que hace falta para que el agente pueda instalar cosas:
# un runtime, git, y herramientas de compilación (muchos paquetes de npm y pip
# compilan al instalarse).
#
# Node 24 porque es el LTS activo (soporte hasta abril de 2028). El 22 salio de
# mantenimiento y dejaba a las salas una version atras del runtime que la gente
# usa afuera: un proyecto que pida 24 no arrancaria dentro de la sala.
FROM node:24-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      ca-certificates \
      curl \
      procps \
      build-essential \
      python3 \
    && rm -rf /var/lib/apt/lists/*

# El proyecto se monta aquí como volumen (vive en el disco del host, para que git
# y el historial de Multi sigan funcionando sin cambios).
WORKDIR /work

# El usuario `node` ya existe en la imagen base y NO es root: si algo se sale de
# madre dentro del contenedor, al menos no manda sobre el contenedor.
# El uid 1000 coincide con el usuario típico del host, así que los archivos que
# escriba el agente quedan con permisos usables desde afuera.
USER node

# El contenedor debe quedarse vivo aunque no esté corriendo nada: los comandos
# entran por `docker exec`, no como proceso principal.
CMD ["sleep", "infinity"]
