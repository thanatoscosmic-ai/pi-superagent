import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/pi/index.ts', cli: 'src/pi/cli.ts' },
  outDir: 'dist',
  format: 'esm',
  fixedExtension: false,
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: true,
})
