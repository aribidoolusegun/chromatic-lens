import type { Camera, ColorRepresentation, Scene, Texture, WebGLRenderer } from 'three';

/** Every tunable parameter. All are optional in the constructor and in `set()`. */
export interface LensParams {
  /** Lens radius in CSS px. Spring-animated when changed. @default 170 */
  radius: number;
  /** How far the refracted ray travels before it meets the page. @default 0.85 */
  refraction: number;
  /** Base index of refraction. @default 1.42 */
  ior: number;
  /** Dome exponent k in z = (1 − r²)^k: 0.5 sphere cap, lower = harder rim, >1 = soft pillow. @default 0.5 */
  profile: number;

  /** IOR spread between the amber and electric-blue ends of the spectrum. @default 0.4 */
  dispersion: number;
  /** Concentrates dispersion towards the rim (0 = physical only). @default 2 */
  falloff: number;
  /** Spectral samples per lens pixel, 1–32. @default 16 */
  samples: number;
  /** Sharpens the thin-film palette weights → more saturated fringes. @default 2 */
  contrast: number;

  /** Thin-film iridescence on the rim and the outer halo. @default 0.7 */
  edgeGlow: number;
  /** Film thickness — selects which interference band shows on the rim. @default 1.1 */
  film: number;
  /** Glossy Fresnel highlight on the outer 5% of the rim. @default 0.55 */
  fresnel: number;
  /** Specular hotspot intensity. @default 0.3 */
  highlight: number;

  /** Position spring stiffness. @default 180 */
  stiffness: number;
  /** Position spring damping (below 2·√stiffness overshoots). @default 17 */
  damping: number;
  /** Velocity → elliptical stretch along the motion axis. @default 0.6 */
  pinch: number;
  /** 0 settles cleanly, 1 wobbles back when the pointer stops. @default 0.65 */
  jiggle: number;

  /** Offset applied to touch input so the finger doesn't cover the lens (CSS px). @default { x: 0, y: -60 } */
  touchOffset: { x: number; y: number } | null;
  /** CSS `touch-action` applied to the target element. @default 'none' */
  touchAction: string;
  /** Mouse wheel over the target resizes the lens (and blocks page scroll there). @default false */
  wheelResize: boolean;
  /** Drift on a slow Lissajous path until the pointer arrives / after it leaves the window. @default true */
  idleDrift: boolean;
  /** Hide the system cursor over the target and draw an exact pointer dot. @default true */
  cursor: boolean;

  /** Device-pixel-ratio cap. @default 2 */
  maxDpr: number;
  /** Clear colour behind the content. @default 0x09090b */
  background: ColorRepresentation;
  /** Screen vignette (not applied in overlay mode). @default 0.28 */
  vignette: number;
  /** Film grain amount. @default 0.022 */
  grain: number;
}

/** Anything `setTexture()` / the `texture` option accepts. A URL string is loaded with CORS. */
export type TextureSource =
  | Texture
  | HTMLImageElement
  | HTMLCanvasElement
  | HTMLVideoElement
  | ImageBitmap
  | string;

export interface CaptureOptions {
  /** Re-capture on DOM mutations, resizes and font loads. @default true */
  live?: boolean;
  /** Embed the webfonts the element uses (fetches CORS-enabled stylesheets). @default true */
  embedFonts?: boolean;
  /** Transparent outside the lens so the real DOM shows and stays interactive. @default true */
  overlay?: boolean;
  /** Debounce for live re-captures, in ms. @default 150 */
  debounce?: number;
}

export interface ResizeInfo {
  width: number;
  height: number;
  pixelRatio: number;
  bufferWidth: number;
  bufferHeight: number;
}

export interface ChromaticLensOptions extends Partial<LensParams> {
  /** Element the canvas is mounted in and sized to. Pointer input is read from it. */
  targetElement: HTMLElement;
  /** Refract your own Three.js scene (pass together with `camera`). */
  scene?: Scene;
  camera?: Camera;
  /** Refract an image, video, canvas, texture or URL. */
  texture?: TextureSource;
  /** How `texture` maps onto the target. @default 'cover' */
  fit?: 'cover' | 'fill';
  /** Refract a live DOM element (the target or a descendant) — same as calling `bindToElement()`. */
  element?: HTMLElement;
  /** Options for `element`. */
  capture?: CaptureOptions;
  onResize?: (info: ResizeInfo) => void;
  onFrame?: (time: number, dt: number) => void;
  /** Fired when the lens changes a parameter itself (e.g. wheel-resize). */
  onParamsChange?: (changed: Partial<LensParams>) => void;
  /** Fired after each DOM capture with the rasterised canvas. */
  onCapture?: (canvas: HTMLCanvasElement) => void;
}

export declare class ChromaticLens {
  static readonly DEFAULTS: Readonly<LensParams>;
  static readonly THIN_FILM_GLSL: string;
  /** True when the browser can create a WebGL2 context. */
  static isSupported(): boolean;

  constructor(options: ChromaticLensOptions);

  readonly targetElement: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly renderer: WebGLRenderer;
  readonly params: LensParams;
  readonly width: number;
  readonly height: number;
  onResize: ChromaticLensOptions['onResize'] | null;
  onFrame: ChromaticLensOptions['onFrame'] | null;
  onParamsChange: ChromaticLensOptions['onParamsChange'] | null;
  onCapture: ChromaticLensOptions['onCapture'] | null;

  /** Merge parameter updates. */
  set(params: Partial<LensParams>): this;
  /** Refract a Three.js scene, rendered into the lens' FBO every frame. */
  setScene(scene: Scene, camera: Camera): this;
  /** Refract an image source. */
  setTexture(source: TextureSource, options?: { fit?: 'cover' | 'fill' }): this;
  /** Render a DOM element into the backing texture via SVG foreignObject. */
  bindToElement(element?: HTMLElement, options?: CaptureOptions): this;
  /** Stop live DOM capture (the last capture remains the source). */
  unbindElement(): this;
  /** Re-capture the bound element now. */
  refresh(): Promise<void>;
  /** Re-measure the target and resize the canvas + FBO (automatic via ResizeObserver). */
  resize(): void;
  /** Stop rendering, remove listeners and the canvas, free GPU resources. */
  destroy(): void;
}

export declare const LENS_DEFAULTS: Readonly<LensParams>;
export declare const THIN_FILM_GLSL: string;

export interface RasterizeOptions {
  /** Viewport-space rectangle to capture, in CSS px. */
  region: { x: number; y: number; width: number; height: number };
  pixelRatio?: number;
  background?: string | null;
  exclude?: Node[];
  embedFonts?: boolean;
  fontCache?: Map<string, Promise<string>>;
}

/** Paint a DOM element into a canvas via SVG foreignObject. */
export declare function rasterizeElement(element: HTMLElement, options: RasterizeOptions): Promise<HTMLCanvasElement>;
/** First non-transparent background colour on the element or its ancestors. */
export declare function resolveBackground(element: HTMLElement, fallback?: string): string;

export default ChromaticLens;
