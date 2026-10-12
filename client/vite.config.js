import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, '');
  const apiPort = env.PORT || '4000';

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/health': `http://localhost:${apiPort}`,
        '/auth': `http://localhost:${apiPort}`,
        '/documents': {
          target: `http://localhost:${apiPort}`,
          bypass(req) {
            if (req.headers.accept?.includes('text/html')) return '/index.html';
          },
        },
        '/admin': `http://localhost:${apiPort}`,
      },
    },
  };
});
