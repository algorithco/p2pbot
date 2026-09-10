// ESLint flat config for the p2pbot monorepo.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.vite/**',
      // Vendored / generated browser bundles get their own hygiene rules below.
      'webapp/public/**',
      '**/*.min.js',
      '.husky/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain JS (repo scripts, legacy webapp sources): allow Node + browser env.
    // `require()` stays legal in CJS scripts; TS files must use `import`.
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    rules: {
      // `any` is pervasive today (Telegram APIs, legacy JS bridge). Warn, don't
      // fail — tracked for gradual removal (see PLAN.md).
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          // Empty `catch {}` / unused catch params are the codebase's intentional
          // best-effort style (UI + chain fallbacks). Real errors are logged.
          caughtErrors: 'none',
        },
      ],
      // Codebase style uses intentional empty catch blocks for best-effort UI ops.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
);
