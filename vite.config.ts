import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: { outDir: '../../dist/web', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api/': 'http://localhost:3000', '/auth/': 'http://localhost:3000', '/uploads/': 'http://localhost:3000' },
  },
});
