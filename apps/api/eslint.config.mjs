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
    // Integration tests wait for the condition they need (an event, a readback, an exit), never for a fixed time:
    // fixed waits make the suite slow and flaky. A test proving that something does NOT happen within a window may
    // keep its wait with an eslint-disable-next-line comment saying so.
    files: ['test/**/*.integration.test.ts'],
    rules: {
      'no-restricted-syntax': ['error',
        { selector: "NewExpression[callee.name='Promise'] > :function CallExpression[callee.name='setTimeout'][arguments.0.type='Identifier']",
          message: 'Wait for the observable condition instead of a fixed sleep.' },
        { selector: "NewExpression[callee.name='Promise'] > :function > BlockStatement > ExpressionStatement > CallExpression[callee.name='setTimeout'][arguments.0.type='Identifier']",
          message: 'Wait for the observable condition instead of a fixed sleep.' },
        { selector: "CallExpression[callee.name=/^(sleep|delay|pause)$/]",
          message: 'Wait for the observable condition instead of a fixed sleep.' },
      ],
      'no-restricted-imports': ['error', { paths: [
        { name: 'node:timers/promises', importNames: ['setTimeout', 'setInterval'],
          message: 'Wait for the observable condition instead of a fixed sleep.' },
        { name: 'timers/promises', importNames: ['setTimeout', 'setInterval'],
          message: 'Wait for the observable condition instead of a fixed sleep.' },
      ] }],
    },
  },
  {
    files: ['**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    // These validators reject control characters in file names on purpose.
    files: [
      'src/modules/harnesses/codexFiles/bytes.ts',
    ],
    rules: { 'no-control-regex': 'off' },
  },
  {
    // Shared helpers: one-shot SHA-256 digests go through src/shared/hash.ts (incremental hashing keeps createHash),
    // and child processes start only through src/shared/process.ts. CI keeps its own until it is a separate service.
    files: ['src/**/*.ts'],
    ignores: ['src/modules/ci/**', '**/*.test.ts', '**/*.test-support.ts', '**/__tests__/**'],
    rules: {
      'no-restricted-syntax': ['error',
        { selector: "CallExpression[callee.property.name='digest'] > MemberExpression.callee > CallExpression.object[callee.property.name='update'] > MemberExpression.callee > CallExpression.object[callee.name='createHash'][arguments.0.value='sha256']",
          message: 'Use sha256Hex/sha256Digest/sha256CanonicalJsonHex from src/shared/hash.ts.' },
      ],
      'no-restricted-imports': ['error', { paths: ['node:child_process', 'child_process'].map(name => ({ name, allowTypeImports: true,
        message: 'Start child processes through src/shared/process.ts (runProcess, runProcessSettled, spawnProcess, forkProcess).' })) }],
    },
  },
  {
    // Environment reads: settings come from src/config.ts (loadConfig and its lazy accessors); a child process or a
    // function that forwards the host environment takes hostEnvironment() from src/shared/process.ts. Entry points,
    // composition and tests may read process.env directly.
    files: ['src/**/*.ts'],
    ignores: ['src/config.ts', 'src/shared/process.ts', 'src/server.ts', 'src/cli/**', 'src/production.ts',
      '**/*.test.ts', '**/*.test-support.ts', '**/__tests__/**'],
    rules: {
      'no-restricted-properties': ['error', { object: 'process', property: 'env',
        message: 'Read settings through src/config.ts, or take the host environment from hostEnvironment() in src/shared/process.ts.' }],
    },
  },
  { files: ['src/shared/hash.ts'], rules: { 'no-restricted-syntax': 'off' } },
  { files: ['src/shared/process.ts'], rules: { 'no-restricted-imports': 'off' } },
  ...foremanLint(import.meta.dirname),
)
