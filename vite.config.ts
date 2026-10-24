import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// Serve the two pages at the same URLs as the production server: `/` is the
// laptop host, `/play` is the phone controller.
const pageRoutes: Plugin = {
  name: 'ember-page-routes',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const [path, query] = (req.url ?? '/').split('?');
      if (path === '/' || path === '/index.html') req.url = '/host/index.html' + (query ? `?${query}` : '');
      else if (path === '/play' || path === '/play/') req.url = '/controller/index.html' + (query ? `?${query}` : '');
      next();
    });
  },
};

export default defineConfig({
  root: resolve(__dirname, 'client'),
  publicDir: resolve(__dirname, 'client/public'),
  plugins: [pageRoutes],
  build: {
    outDir: resolve(__dirname, 'dist/client'),
    emptyOutDir: true,
    target: 'es2020',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: {
        host: resolve(__dirname, 'client/host/index.html'),
        controller: resolve(__dirname, 'client/controller/index.html'),
      },
    },
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
});
