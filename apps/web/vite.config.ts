import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Tailwind 4 is CSS-first — the @tailwindcss/vite plugin processes the @theme
// tokens in src/styles/theme.css (no tailwind.config.js). In dev, /api and
// /auth proxy to the Fastify server so the SPA talks only to /api/v1 (Law 4).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/auth': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});
