import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

/** The IBM Plex fonts are bundled into assets/; their SIL Open Font License ships next to them. */
function fontLicense(): Plugin {
  return {
    name: 'overseer-font-license',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'assets/IBM-Plex-OFL.txt',
        source: readFileSync(new URL('./design/system/licenses/IBM-Plex-OFL.txt', import.meta.url)),
      });
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('./web', import.meta.url)),
  plugins: [react(), fontLicense()],
  build: {
    outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    // The fonts and component styles live in design/system/, outside the web/ root.
    fs: { allow: [repoRoot] },
    proxy: {
      '/api': { target: 'http://127.0.0.1:4477', changeOrigin: true },
    },
  },
});
