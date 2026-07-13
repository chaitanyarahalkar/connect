import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  // Inline @connect/shared's types so the published package is self-contained
  // (the SDK's imports from shared are type-only — nothing lands in the JS).
  dts: { resolve: ['@connect/shared'] },
  sourcemap: true,
  clean: true,
  target: 'es2022',
  platform: 'neutral',
});
