import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import { reactRefresh } from 'eslint-plugin-react-refresh'

export default defineConfig(
  { ignores: ['**/node_modules', '**/dist', '**/out', '**/scripts', '**/e2e'] },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules
    }
  },
  reactRefresh.configs.vite(),
  {
    // The document core runs in main and in the renderer: nothing platform-bound.
    files: ['src/core/**/*.ts', 'src/shared/**/*.ts'],
    ignores: ['src/core/**/*.test.ts', 'src/shared/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'electron', message: 'src/core and src/shared must not depend on Electron.' },
            { name: 'react', message: 'src/core and src/shared must not depend on React.' },
            { name: 'react-dom', message: 'src/core and src/shared must not depend on React.' }
          ],
          patterns: [
            { group: ['node:*'], message: 'No Node built-ins in src/core or src/shared.' },
            {
              group: [
                'fs',
                'path',
                'os',
                'crypto',
                'child_process',
                'util',
                'stream',
                'buffer',
                'events'
              ],
              message: 'No Node built-ins in src/core or src/shared.'
            },
            {
              group: ['electron/*', '@electron-toolkit/*'],
              message: 'No Electron in src/core or src/shared.'
            },
            {
              group: ['@renderer/*', '**/renderer/**'],
              message: 'src/core must not import the renderer.'
            },
            {
              group: ['@tiptap/*', 'prosemirror-*'],
              message: 'The core is editor-agnostic; keep Tiptap in the renderer.'
            }
          ]
        }
      ]
    }
  },
  eslintConfigPrettier
)
