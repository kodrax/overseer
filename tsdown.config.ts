import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { cli: 'src/cli/bin.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  fixedExtension: false,
  banner: '#!/usr/bin/env node',
  dts: false,
});
