/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { createApiApp } from './server/app.ts';

function myAlbumApiPlugin(): Plugin {
  const apiApp = createApiApp();
  return {
    name: 'myalbum-api-middleware',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith('/api/')) {
          apiApp(req as any, res as any, next);
        } else {
          next();
        }
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith('/api/')) {
          apiApp(req as any, res as any, next);
        } else {
          next();
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), myAlbumApiPlugin()],
  server: {
    port: 5173,
    host: true,
  },
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    // Demo-album tests regenerate the shared sample-photos folder, so test files must not run in parallel
    fileParallelism: false,
  },
});
