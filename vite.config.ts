import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import Inspector from 'unplugin-vue-dev-locator/vite'

// https://vite.dev/config/
export default defineConfig({
  server: {
    watch: {
      ignored: ['**/*.md', '**/*.txt'],
    },
  },
  build: {
    sourcemap: 'hidden',
  },
  plugins: [
    tailwindcss(),
    vue(),
    electron([
      {
        // Main process entry
        entry: 'src/main/index.ts',
      },
    ]),
    renderer(),
    Inspector(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
