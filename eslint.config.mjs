import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
export default tseslint.config(
  { ignores: ['app-dist/**','node_modules/**','data/**','qa/**'] },
  { files: ['web/src/**/*.{ts,tsx}','server/**/*.ts','tests/**/*.ts','vite.config.ts'], extends: [js.configs.recommended,...tseslint.configs.recommended], languageOptions: {globals:{...globals.browser,...globals.node}}, rules:{'@typescript-eslint/no-unused-vars':['error',{argsIgnorePattern:'^_',varsIgnorePattern:'^_'}]} },
);
