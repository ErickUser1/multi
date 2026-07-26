import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// La Sala corre en :5173. El server (Fastify + socket) en :4000.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: true, strictPort: true },
});
