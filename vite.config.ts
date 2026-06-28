import { defineConfig } from 'vitest/config'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import Inspector from 'unplugin-vue-dev-locator/vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const isTest = mode === 'test'

  return {
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
      ...(isTest
        ? []
        : [
            electron([
              {
                // Main process entry
                entry: 'src/main/index.ts',
              },
            ]),
            renderer(),
            Inspector(),
          ]),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    test: {
      environment: 'node',
    },
  }
})
