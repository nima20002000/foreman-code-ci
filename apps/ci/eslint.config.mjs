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
  {
    // One-shot SHA-256 digests come from the contracts server kit, shared with the API; incremental hashing keeps createHash.
    files: ['src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-syntax': ['error',
        { selector: "CallExpression[callee.property.name='digest'] > MemberExpression.callee > CallExpression.object[callee.property.name='update'] > MemberExpression.callee > CallExpression.object[callee.name='createHash'][arguments.0.value='sha256']",
          message: "Use sha256Hex/sha256Digest from '@foreman-code/contracts/server-kit'." },
      ],
    },
  },
  ...foremanLint(import.meta.dirname),
)
