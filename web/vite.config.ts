import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// La Sala corre en :5173. El server (Fastify + socket) en :4000.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    strictPort: true,
    /**
     * El watcher por SONDEO, no por eventos del sistema.
     *
     * El repo vive en el disco de Windows y se trabaja desde los dos lados:
     * C:\multijugador y /mnt/c/multijugador son el mismo archivo. Los eventos
     * de archivo no cruzan esa frontera, así que Vite arranca bien, el log se
     * ve normal, y los cambios simplemente no llegan al navegador. Recargar sin
     * caché no ayuda porque el servidor sigue sirviendo la versión vieja, y la
     * única salida era reiniciarlo a mano cada vez.
     *
     * Es lo mismo que el prompt del agente ya le exige a los proyectos de las
     * salas, que corren dentro de un contenedor con el workspace montado. El
     * front de Multi tenía el mismo problema y no la regla.
     */
    watch: { usePolling: true, interval: 300 },
  },
});
