import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const banner = { js: `/*! chromatic-lens v${version} | MIT License */` };

export default defineConfig([
  // npm: ESM + CJS, Three.js stays a peer dependency.
  {
    entry: { 'chromatic-lens': 'src/index.js' },
    format: ['esm', 'cjs'],
    external: ['three'],
    target: 'es2020',
    sourcemap: true,
    banner,
    outExtension: ({ format }) => ({ js: format === 'esm' ? '.mjs' : '.cjs' }),
  },
  // CDN <script>: one minified IIFE with Three.js bundled in → window.ChromaticLens.
  {
    entry: { 'chromatic-lens.min': 'src/iife.js' },
    format: ['iife'],
    noExternal: ['three'],
    platform: 'browser',
    target: 'es2020',
    minify: true,
    sourcemap: true,
    banner,
    outExtension: () => ({ js: '.js' }),
  },
]);
