// @ts-check
import eslint from '@eslint/js';
import eslintPluginImport from 'eslint-plugin-import';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Merkaly ESLint 9 flat config for NestJS apps.
 * @param {{ tsconfigRootDir: string, ignores?: string[], rules?: import('eslint').Linter.RulesRecord }} options
 */
export function createConfig({ tsconfigRootDir, ignores = [], rules = {} }) {
  return tseslint.config(
    { ignores: ['eslint.config.mjs', 'dist/**', 'coverage/**', ...ignores] },
    eslint.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    eslintPluginPrettierRecommended,
    {
      plugins: { import: eslintPluginImport },
      languageOptions: {
        globals: { ...globals.node },
        sourceType: 'commonjs',
        parserOptions: { projectService: true, tsconfigRootDir },
      },
    },
    {
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-floating-promises': 'warn',
        '@typescript-eslint/no-misused-promises': 'warn',
        '@typescript-eslint/no-unsafe-argument': 'warn',
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-call': 'off',
        '@typescript-eslint/no-unsafe-function-type': 'warn',
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unsafe-return': 'off',
        '@typescript-eslint/no-unused-vars': [
          'error',
          {
            vars: 'all',
            args: 'after-used',
            ignoreRestSiblings: true,
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
          },
        ],
        'import/order': [
          'error',
          {
            groups: [
              'builtin',
              'external',
              'internal',
              'parent',
              'sibling',
              'index',
              'object',
              'type',
            ],
            'newlines-between': 'never',
            alphabetize: { order: 'asc', caseInsensitive: true },
          },
        ],
        'no-unused-vars': 'off', // replaced by the typescript rule
        ...rules,
      },
    },
  );
}

export default createConfig;
