import { defineConfig } from 'vite';

// GitHub Pages serves the project from /<repo>/. In dev, serve from root.
// CI passes BASE_PATH explicitly.
export default defineConfig(({ command }) => ({
  base: process.env.BASE_PATH ?? (command === 'build' ? '/FieldStretcher/' : '/'),
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60000,
  },
}));
