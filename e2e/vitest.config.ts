import { defineConfig } from 'vitest/config';

// Roteiros de navegador. Ficam FORA de `npm test` de proposito: dependem do
// Playwright e levam minutos. Rodar com `npm run e2e` (ver e2e/README.md).
export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.ts'],
    testTimeout: 900_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
