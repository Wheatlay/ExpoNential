import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Biblioteki Markdown rzadko się zmieniają: osobna paczka jest cache'owana między wydaniami.
        manualChunks(id: string) {
          if (/node_modules[\/](react-markdown|remark-[^\/]+|rehype-[^\/]+|micromark[^\/]*|mdast-[^\/]+|hast-[^\/]+|unified|unist-[^\/]+|vfile[^\/]*|decode-named-character-reference|property-information|html-url-attributes|devlop|bail|trough|is-plain-obj|ccount|zwitch|trim-lines|space-separated-tokens|comma-separated-tokens|character-entities[^\/]*|stringify-entities)[\/]/.test(id)) return 'markdown';
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: { '/api/': 'http://localhost:3000', '/auth/': 'http://localhost:3000', '/uploads/': 'http://localhost:3000' },
  },
});
