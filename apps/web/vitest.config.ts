import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Web tests run in jsdom (component tests via @testing-library/react); the SSE
// and Chart tests mock EventSource/echarts since jsdom has no canvas or
// EventSource. Kept separate from vite.config.ts so the dev/build config stays
// free of test-only plugins.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
