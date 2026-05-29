import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // Pattern intentional: latest-value ref via render-time assignment is the React-docs-canonical idiom (https://react.dev/reference/react/useRef). Avoids stale-ref bugs in token-keyed effects.
      'react-hooks/refs': 'off',
      // Honor the `_`-prefix convention for intentionally-unused identifiers
      // (parameters, destructured vars, caught errors). The codebase already
      // uses this convention (e.g. `_allParcels`, `_event`, `_e`); this makes
      // ESLint respect it instead of flagging.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
])
