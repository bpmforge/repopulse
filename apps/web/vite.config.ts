import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import { PORTS } from '../../ports.config.mjs';

// Tailwind 4 is CSS-first — the @tailwindcss/vite plugin processes the @theme
// tokens in src/styles/theme.css (no tailwind.config.js). In dev, /api and
// /auth proxy to the Fastify server so the SPA talks only to /api/v1 (Law 4).
//
// W4-11: the target is env-overridable, defaulting to the usual port so a plain
// `pnpm dev` is unchanged. Hardcoding it meant e2e could only run where port
// 3000 happened to be free — which blocks concurrent runs and any CI box with
// something else on 3000. playwright.config.ts sets this from E2E_API_PORT.
const apiProxyTarget = process.env.API_PROXY_TARGET ?? `http://localhost:${PORTS.api}`;

export default defineConfig({
  // W4-03: the router plugin MUST come before @vitejs/plugin-react — it rewrites
  // route files that plugin-react then transforms. It regenerates routeTree.gen.ts
  // from src/routes/**; that file is committed and never hand-edited
  // (TECH_STACK.md §"TanStack Router file-based routes").
  plugins: [
    tanstackRouter({
      target: 'react',
      routesDirectory: './src/routes',
      autoCodeSplitting: true,
      // Colocated tests live beside their routes; without this the generator
      // warns on every build that __root.test.tsx exports no Route.
      routeFileIgnorePattern: '\\.test\\.tsx?$',
    }),
    react(),
    tailwindcss(),
  ],
  server: {
    // OUR port, not Vite's default. 5173 is what every Vite project picks, so
    // on a machine running two of them the second one silently lands on 5174
    // and every documented URL is wrong — or, as happened here, Playwright
    // finds 5173 occupied by a different app and refuses to start.
    // strictPort so a collision FAILS rather than drifting to a port nothing
    // else knows about.
    port: PORTS.web,
    strictPort: true,
    proxy: {
      '/api': { target: apiProxyTarget, changeOrigin: true },
      '/auth': { target: apiProxyTarget, changeOrigin: true },
    },
  },
});
