// Reglas de ESLint de BankLite. Este archivo es idéntico en todos los
// microservicios: si cambias una regla, cámbiala en todos.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist/', 'node_modules/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: {
      // Los logs pasan por el Logger de Nest, nunca por console
      'no-console': 'error',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // `any` se tolera (cuerpos de eventos, respuestas de otros servicios), pero se avisa
      '@typescript-eslint/no-explicit-any': 'warn',
      // `import X = require('...')` sirve para módulos CommonJS sin export default
      '@typescript-eslint/no-require-imports': ['error', { allowAsImport: true }],
    },
  },
  {
    // Scripts de arranque en Node (CommonJS): sí imprimen por consola
    files: ['scripts/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  // Siempre al final: apaga las reglas de formato, que son trabajo de Prettier
  prettier,
);
