import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: true,
  clean: true,
  fixedExtension: false,
  // Peer deps stay external: the DSH host provides cordis, dsh-tools, and
  // schemastery at runtime. Runtime deps (ws, qrcode) live in dependencies
  // and resolve normally at install time — no bundling either way.
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/schemastery',
    ],
  },
})
