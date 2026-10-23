import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { foremanLint } from '../../scripts/eslint-plugin-foreman/index.mjs'

export default tseslint.config(
  { ignores: ['dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  ...foremanLint(import.meta.dirname),
)
