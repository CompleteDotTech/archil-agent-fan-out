import { defineConfig } from 'vitest/config';
export default defineConfig({ cacheDir: '.cache/vite', test: { include: ['tests/**/*.test.ts'] } });
