import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // Read all variables (not only VITE_*) from the shell and .env files in the project root.
  const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  const backend = `http://localhost:${env.PORT ?? 8080}`;

  return {
    root: "web",
    plugins: [react(), tailwindcss()],
    build: { outDir: "../dist", emptyOutDir: true, chunkSizeWarningLimit: 1000 },
    server: {
      host: env.WEB_HOST || undefined,
      port: Number(env.WEB_PORT ?? 5173),
      strictPort: true,
      proxy: { "/api": backend, "/hook": backend },
    },
  };
});
