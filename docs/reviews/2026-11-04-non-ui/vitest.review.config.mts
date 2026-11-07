import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('../../../src', import.meta.url)) } },
  test: { include: ['docs/reviews/2026-11-04-non-ui/*.probe.ts'], pool: 'forks', maxWorkers: 1 },
});
