import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    // Served by the agent from C:\WinPanel\panel.
    outDir: 'dist',
    // Everything is bundled: the panel must render on a server with no
    // outbound internet, and an admin panel should not phone out to a CDN.
    assetsInlineLimit: 4096,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'https://127.0.0.1:8443',
        changeOrigin: true,
        // The agent uses a self-signed certificate in development.
        secure: false,
      },
    },
  },
  test: {
    environment: 'happy-dom',
  },
});
