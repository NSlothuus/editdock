import { defineConfig } from 'vite';

// Node-only agent entry. Rollup includes the same core and renderer sources; no DOM entry.
export default defineConfig({
  build: {
    target: 'node22',
    lib: { entry: 'src/cli.mjs', formats: ['es'], fileName: () => 'editdock.mjs' },
    outDir: 'dist/cli',
    emptyOutDir: true,
    rollupOptions: { external: [/^node:/] },
  },
});
