import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: () => 'editweave.js' },
    outDir: 'dist/lib',
    emptyOutDir: true,
  },
});
