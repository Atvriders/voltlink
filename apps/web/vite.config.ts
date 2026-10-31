import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  build: {
    chunkSizeWarningLimit: 1600,
    modulePreload: {
      // G-06: never preload the route-lazy heavy chunks from index.html.
      resolveDependencies: (_filename, deps) =>
        deps.filter((d) => !/(three|map|charts)-[\w-]+\.js/.test(d)),
    },
    rollupOptions: {
      output: {
        // G-06: only three/@react-three code may join the 'three' chunk — an
        // object-form manualChunks also captured React into it, forcing every
        // page to download the 1.1 MB viewer.
        manualChunks(id) {
          if (id.includes('three') || id.includes('@react-three')) return 'three';
          if (id.includes('maplibre-gl')) return 'map';
          if (id.includes('recharts')) return 'charts';
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    testTimeout: 15000,
    exclude: ['node_modules', 'dist'],
  },
});
