import { defineConfig } from 'vite';

// Separate Node-only subpath: never pull FFmpeg or filesystem code into the browser bundle.
export default defineConfig({
  build: {
    target: 'node22',
    lib: { entry: 'src/server-render.ts', formats: ['es'], fileName: () => 'render.js' },
    outDir: 'dist/server',
    emptyOutDir: true,
    rollupOptions: { external: [/^node:/] },
  },
});
