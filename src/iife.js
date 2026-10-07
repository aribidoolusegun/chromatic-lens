// Script-tag build: Three.js is bundled in; exposes `window.ChromaticLens`.
import { ChromaticLens } from './chromatic-lens.js';
import { rasterizeElement } from './dom-capture.js';

ChromaticLens.rasterizeElement = rasterizeElement;
globalThis.ChromaticLens = ChromaticLens;
