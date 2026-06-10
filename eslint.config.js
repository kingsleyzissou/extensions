import js from '@eslint/js';
import importPlugin from 'eslint-plugin-import';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/*.js', '**/*.cjs', '**/*.d.ts', '**/*.d.cts'],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      import: importPlugin,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
        Bun: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
      'prefer-const': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'prefer-arrow-callback': ['error', { allowNamedFunctions: true }],
      'arrow-body-style': 'off',
      'no-unused-vars': 'off',
      'no-restricted-exports': [
        'error',
        {
          restrictDefaultExports: { direct: true },
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'separate-type-imports',
        },
      ],
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      'no-warning-comments': [
        'warn',
        { terms: ['TODO', 'FIXME', 'HACK', 'NOTE'], location: 'anywhere' },
      ],
    },
  },
  // Pi extensions require a default export
  {
    files: ['**/extensions/*/index.ts'],
    rules: {
      'no-restricted-exports': 'off',
    },
  },
);
