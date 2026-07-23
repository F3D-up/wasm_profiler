import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: 'src',
  publicDir: resolve(import.meta.dirname, 'public'),
  plugins: [
    svelte({ configFile: resolve(import.meta.dirname, 'svelte.config.js') }),
    tailwindcss()
  ],
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    target: 'chrome120',
    minify: false,
    rollupOptions: {
      input: {
        controller: resolve(import.meta.dirname, 'src/controller/index.html'),
        viewer: resolve(import.meta.dirname, 'src/viewer/index.html')
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name][extname]'
      }
    }
  }
});
