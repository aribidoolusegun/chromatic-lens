/**
 * ChromaticLens — a refractive loupe with thin-film spectral dispersion for Three.js (WebGL2).
 *
 *   import { ChromaticLens } from 'chromatic-lens';
 *
 *   // Refract live DOM content (rendered via SVG foreignObject; the real DOM stays interactive)
 *   const lens = new ChromaticLens({ targetElement: hero, element: hero, radius: 170 });
 *
 *   // …or an image / video / canvas / THREE.Texture, cover-fitted
 *   new ChromaticLens({ targetElement: stage, texture: '/photo.jpg' });
 *
 *   // …or your own Three.js scene, rendered into the lens' FBO every frame
 *   new ChromaticLens({ targetElement: stage, scene, camera, onResize, onFrame });
 *
 *   lens.set({ refraction: 1.2 });  // live parameter updates (see LENS_DEFAULTS)
 *   lens.resize();                  // automatic via ResizeObserver; public for manual use
 *   lens.destroy();                 // stops the loop, removes listeners + canvas, frees GPU memory
 *
 * Colour pipeline: the content pass renders linear colour into a half-float target, the lens
 * pass works in linear and encodes to the renderer's output colour space. Built-in Three.js
 * materials work as-is; custom ShaderMaterials should end with `#include <colorspace_fragment>`.
 * A caller-provided scene, camera or THREE.Texture is never disposed by destroy().
 */
import * as THREE from 'three';
import { rasterizeElement, resolveBackground } from './dom-capture.js';

export const LENS_DEFAULTS = Object.freeze({
  // Lens
  radius: 170,       // CSS px
  refraction: 0.85,  // how far the refracted ray travels before it meets the page
  ior: 1.42,         // base index of refraction
  profile: 0.5,      // dome exponent k in z = (1 − r²)^k — 0.5 sphere cap, <0.5 hard rim, >1 pillow
  // Dispersion
  dispersion: 0.4,   // IOR difference between the amber and blue ends of the palette
  falloff: 2.0,      // concentrates dispersion towards the rim (0 = physical only)
  samples: 16,       // spectral samples per lens pixel (3–32)
  contrast: 2.0,     // sharpens palette weights → more saturated fringes
  // Surface
  edgeGlow: 0.7,     // thin-film iridescence on the rim + outer halo
  film: 1.1,         // film thickness → which interference band shows
  fresnel: 0.55,     // glossy Fresnel rim on the outer 5%
  highlight: 0.3,    // specular hotspot
  // Physics
  stiffness: 180,    // position spring
  damping: 17,       // < 2·√stiffness overshoots slightly
  pinch: 0.6,        // velocity → elliptical stretch along the motion axis
  jiggle: 0.65,      // 0 = settles cleanly, 1 = wobbly spring-back when the pointer stops
  // Input
  touchOffset: Object.freeze({ x: 0, y: -60 }),  // CSS px; keeps the lens clear of the finger
  touchAction: 'none',   // CSS touch-action on the target ('pan-y' keeps vertical page scroll)
  wheelResize: false,    // wheel over the target resizes the lens (blocks page scroll there)
  idleDrift: true,       // Lissajous drift until the pointer arrives / after it leaves the window
  cursor: true,          // hide the system cursor over the target, draw an exact pointer dot
  // Look
  maxDpr: 2,
  background: 0x09090b,
  vignette: 0.28,
  grain: 0.022,
});

/** Thin-film cosine palette, display-referred. t: 0 amber → gold → emerald → cyan → 1 electric blue. */
export const THIN_FILM_GLSL = /* glsl */`
  vec3 thinFilm(float t) {
    return clamp(vec3(0.55, 0.50, 0.55) + vec3(0.45, 0.40, 0.45)
      * cos(6.28318 * (0.6 * t + vec3(0.00, -0.30, 0.50))), 0.0, 1.0);
  }
  // Ping-pong through the palette so any film thickness stays continuous.
  vec3 thinFilmCycle(float d) { return thinFilm(abs(fract(d * 0.5) * 2.0 - 1.0)); }
`;

const LENS_VERT = /* glsl */`void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const LENS_FRAG = /* glsl */`
  #define MAX_SAMPLES 32
  uniform sampler2D tScene;
  uniform vec2  uResolution;   // drawing-buffer px
  uniform vec2  uCenter;       // drawing-buffer px, origin bottom-left
  uniform float uRadius;       // drawing-buffer px
  uniform float uDpr;
  uniform float uRefraction, uIOR, uProfile;
  uniform float uDispersion, uFalloff, uContrast;
  uniform int   uSamples;
  uniform float uGlow, uFilm, uFresnel, uHighlight;
  uniform vec2  uAxis;         // unit motion axis (screen space)
  uniform float uPinch;        // signed log-stretch along uAxis; < 0 during spring-back
  uniform vec2  uPointer;
  uniform float uPointerAlpha;
  uniform float uOverlay;      // 1 = transparent outside the lens (live DOM shows through)
  uniform float uVignette, uGrain, uTime;
  ${THIN_FILM_GLSL}

  vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
  vec3 sceneAt(vec2 px) { return texture2D(tScene, clamp(px / uResolution, vec2(0.0), vec2(1.0))).rgb; }

  void main() {
    vec2 frag = gl_FragCoord.xy;
    vec3 base = sceneAt(frag);
    vec3 lens = base;
    vec3 glow = vec3(0.0);     // additive light outside the lens body
    float inside = 0.0;
    float R = max(uRadius, 1.0);

    // Lens space: the unit circle, deformed into an area-preserving ellipse along the motion axis.
    float e = exp(uPinch);
    vec2 q = (frag - uCenter) / R;
    float qa = dot(q, uAxis);
    vec2 p = uAxis * (qa / e) + (q - qa * uAxis) * e;
    float r = length(p);
    float aa = 1.25 * uDpr / R;

    if (uRadius > 0.5 && r < 1.0 + 64.0 * uDpr / R) {
      float ang = atan(p.y, p.x);
      float thick = uFilm * (1.0 + 0.22 * sin(ang * 2.0 + uTime * 0.5) + 0.12 * sin(ang * 5.0 - uTime * 0.35));

      if (r < 1.0 + aa) {
        float rc = min(r, 1.0);
        vec2 pc = p * (rc / max(r, 1e-5));
        // Height field z = (1 - r²)^k  →  ∇z = -2k (1 - r²)^(k-1) · p
        float s = max(1.0 - rc * rc, 1e-4);
        vec3 n = normalize(vec3(2.0 * uProfile * pow(s, uProfile - 1.0) * pc, 1.0));

        // Spectral refraction: each sample has its own IOR and a thin-film palette weight,
        // so the offsets fan out along the normal and resolve into amber → emerald → cyan → blue.
        float spread = uDispersion * pow(rc, uFalloff);
        float jitter = ign(frag);
        float N = float(uSamples);
        vec3 acc = vec3(0.0), wsum = vec3(0.0);
        for (int i = 0; i < MAX_SAMPLES; i++) {
          if (i >= uSamples) break;
          float t = (float(i) + jitter) / N;
          vec3 T = refract(vec3(0.0, 0.0, -1.0), n, 1.0 / max(uIOR + spread * (t - 0.5), 1.0001));
          float oa = dot(T.xy, uAxis);                          // lens space → screen space
          vec2 off = uAxis * (oa * e) + (T.xy - oa * uAxis) / e;
          vec3 w = pow(thinFilm(t), vec3(uContrast));
          acc += sceneAt(frag + off * uRefraction * R) * w;
          wsum += w;
        }
        lens = acc / max(wsum, vec3(1e-4));   // per-channel normalisation keeps white white

        // Bubble wall: slight absorption + thin-film iridescence. Additive light terms are
        // authored in display space and linearised, which keeps their falloff tight.
        float wall = pow(rc, 6.0);
        lens *= 1.0 - 0.18 * wall;
        lens += toLinear(thinFilmCycle(thick + rc * 0.6) * wall * uGlow * 0.5);

        // Glossy Fresnel rim, confined to the outer 5%.
        float fres = pow(1.0 - n.z, 3.5) * smoothstep(0.95, 0.99, rc);
        lens += mix(vec3(1.0), toLinear(thinFilmCycle(thick + 0.9)), 0.3) * fres * uFresnel;

        // Specular hotspot (light from the upper left).
        float nh = max(dot(n, normalize(normalize(vec3(-0.45, 0.55, 0.7)) + vec3(0.0, 0.0, 1.0))), 0.0);
        lens += toLinear(vec3((pow(nh, 220.0) + 0.04 * pow(nh, 12.0)) * uHighlight));

        inside = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r);
      }

      // Soft iridescent halo just outside the rim.
      float dpx = max(r - 1.0, 0.0) * R / uDpr;
      glow = toLinear(thinFilmCycle(thick + 0.6) * exp(-dpx / 10.0)
           * smoothstep(1.0 - aa, 1.0 + aa, r) * uGlow * 0.45);
    }

    // Exact pointer position — the lens trails it on a spring.
    float dotA = (1.0 - smoothstep(1.6, 2.6, length(frag - uPointer) / uDpr)) * uPointerAlpha;

    if (uOverlay > 0.5) {
      // Premultiplied: the lens body is opaque, halo + pointer dot add light over the DOM.
      gl_FragColor = vec4(lens * inside + glow + vec3(0.9) * dotA, inside);
    } else {
      vec3 col = mix(base, lens, inside) + glow;
      col = mix(col, vec3(0.9), dotA);
      vec2 uv = frag / uResolution;
      col *= 1.0 - uVignette * pow(length((uv - 0.5) * vec2(1.0, 0.9)) * 1.25, 2.4);
      gl_FragColor = vec4(col, 1.0);
    }
    #include <colorspace_fragment>
    gl_FragColor.rgb += (hash(frag + fract(uTime) * 91.0) - 0.5) * uGrain * mix(1.0, inside, uOverlay);
  }
`;

// Internal source for textures / images / captured DOM: a full-bleed quad, cover-fit or 1:1.
const SOURCE_VERT = /* glsl */`
  varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const SOURCE_FRAG = /* glsl */`
  uniform sampler2D map; uniform vec2 uScale; varying vec2 vUv;
  void main() {
    gl_FragColor = texture2D(map, (vUv - 0.5) * uScale + 0.5);
    #include <colorspace_fragment>
  }
`;

const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const mediaSize = (img) => img
  ? [img.videoWidth || img.naturalWidth || img.width || 0, img.videoHeight || img.naturalHeight || img.height || 0]
  : [0, 0];

export class ChromaticLens {
  static DEFAULTS = LENS_DEFAULTS;
  static THIN_FILM_GLSL = THIN_FILM_GLSL;

  /** True when the browser can create a WebGL2 context. */
  static isSupported() {
    try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
  }

  constructor(options = {}) {
    const {
      targetElement, scene = null, camera = null, texture = null, fit = 'cover',
      element = null, capture = {},
      onResize = null, onFrame = null, onParamsChange = null, onCapture = null,
      ...params
    } = options;
    if (!(targetElement instanceof HTMLElement)) throw new TypeError('ChromaticLens: `targetElement` must be an HTMLElement.');
    if (!!scene !== !!camera) throw new TypeError('ChromaticLens: `scene` and `camera` must be passed together.');

    this.targetElement = targetElement;
    this.params = { ...LENS_DEFAULTS, ...params };
    this.onResize = onResize;
    this.onFrame = onFrame;
    this.onParamsChange = onParamsChange;
    this.onCapture = onCapture;
    this.width = 1;
    this.height = 1;

    this._reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this._buffer = new THREE.Vector2();
    this._time = 0;
    this._last = performance.now();
    this._visible = true;
    this._destroyed = false;
    this._overlay = false;
    this._source = null;     // { scene, camera } or the internal texture source
    this._internal = null;
    this._capture = null;

    // --- Canvas + renderer -------------------------------------------------------------
    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, {
      position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block',
      pointerEvents: 'none', zIndex: '1',   // input is read from the target, so DOM underneath stays usable
    });
    this.canvas.setAttribute('aria-hidden', 'true');

    const ts = targetElement.style;
    this._savedStyle = { position: ts.position, touchAction: ts.touchAction, cursor: ts.cursor, webkitTouchCallout: ts.webkitTouchCallout };
    if (getComputedStyle(targetElement).position === 'static') ts.position = 'relative';
    targetElement.appendChild(this.canvas);

    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, alpha: true, powerPreference: 'high-performance' });
    } catch (err) {
      this.canvas.remove();
      Object.assign(ts, this._savedStyle);
      throw err;
    }
    this._applyClearColor();

    // --- FBO (half-float linear when renderable, else sRGB 8-bit to avoid banding in the darks)
    const ext = this.renderer.extensions;
    const halfFloat = ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float');
    this._rt = new THREE.WebGLRenderTarget(1, 1, {
      type: halfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType,
      colorSpace: halfFloat ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      generateMipmaps: false, depthBuffer: true,
    });

    // --- Lens pass ---------------------------------------------------------------------
    this._material = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: this._rt.texture },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uCenter: { value: new THREE.Vector2() },
        uRadius: { value: 0 },
        uDpr: { value: 1 },
        uRefraction: { value: 0 }, uIOR: { value: 1.4 }, uProfile: { value: 0.5 },
        uDispersion: { value: 0 }, uFalloff: { value: 1 }, uContrast: { value: 2 }, uSamples: { value: 16 },
        uGlow: { value: 0 }, uFilm: { value: 1 }, uFresnel: { value: 0 }, uHighlight: { value: 0 },
        uAxis: { value: new THREE.Vector2(1, 0) }, uPinch: { value: 0 },
        uPointer: { value: new THREE.Vector2() }, uPointerAlpha: { value: 0 },
        uOverlay: { value: 0 }, uVignette: { value: 0 }, uGrain: { value: 0 }, uTime: { value: 0 },
      },
      vertexShader: LENS_VERT, fragmentShader: LENS_FRAG, depthTest: false, depthWrite: false,
    });
    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._material);
    this._quad.frustumCulled = false;
    this._lensScene = new THREE.Scene().add(this._quad);
    this._lensCam = new THREE.Camera();

    // --- Physics state (CSS px, y down) ------------------------------------------------
    this._lens = { x: 0, y: 0, vx: 0, vy: 0, r: 0, vr: 0 };          // radius springs in from 0
    this._pointer = { x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, mode: 'idle', inside: false, mouse: false, dot: 0 };
    this._shape = { v: 0, vel: 0, c2: 1, s2: 0 };                       // pinch spring + doubled-angle axis

    // --- Events + observers (listeners live on the target; the canvas ignores pointers) --
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onPointerLeave = this._onPointerLeave.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._tick = this._tick.bind(this);
    targetElement.addEventListener('pointermove', this._onPointerMove);
    targetElement.addEventListener('pointerdown', this._onPointerDown);
    targetElement.addEventListener('pointerup', this._onPointerUp);
    targetElement.addEventListener('pointercancel', this._onPointerUp);
    targetElement.addEventListener('pointerleave', this._onPointerLeave);
    targetElement.addEventListener('wheel', this._onWheel, { passive: false });

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(targetElement);
    this._io = new IntersectionObserver(([entry]) => { this._visible = entry.isIntersecting; });
    this._io.observe(targetElement);

    this.resize();
    this._lens.x = this._pointer.x = this.width * 0.5;
    this._lens.y = this._pointer.y = this.height * 0.5;
    this._applyTargetStyle();

    if (scene) this.setScene(scene, camera);
    else if (texture) this.setTexture(texture, { fit });
    else if (element) this.bindToElement(element, capture);

    this.renderer.setAnimationLoop(this._tick);
  }

  // --- Public API ----------------------------------------------------------------------

  /** Merge parameter updates (any key of LENS_DEFAULTS). Radius changes are spring-animated. */
  set(partial = {}) {
    Object.assign(this.params, partial);
    if ('background' in partial) this._applyClearColor();
    if ('cursor' in partial || 'touchAction' in partial) this._applyTargetStyle();
    if ('maxDpr' in partial) this.resize();
    return this;
  }

  /** Refract a Three.js scene, rendered into the lens' FBO every frame. */
  setScene(scene, camera) {
    this.unbindElement();
    this._source = { scene, camera };
    return this;
  }

  /**
   * Refract an image source: THREE.Texture, HTMLImageElement, HTMLCanvasElement,
   * HTMLVideoElement, ImageBitmap or a URL string (loaded with CORS).
   * fit: 'cover' (default) crops to fill the target; 'fill' maps it 1:1.
   */
  setTexture(source, { fit = 'cover' } = {}) {
    this.unbindElement();
    this._setTextureSource(source, fit);
    return this;
  }

  /**
   * Render a DOM element (the target itself or a descendant) into the lens' backing texture
   * through an SVG foreignObject, re-capturing when it mutates, resizes or loads fonts.
   * With `overlay` (default) the canvas is transparent outside the lens, so the real DOM stays
   * visible, selectable and clickable; only the lens itself is drawn by WebGL.
   */
  bindToElement(element = this.targetElement, { live = true, embedFonts = true, overlay = true, debounce = 150 } = {}) {
    if (!(element instanceof HTMLElement) || !this.targetElement.contains(element)) {
      throw new TypeError('ChromaticLens.bindToElement: element must be the targetElement or one of its descendants.');
    }
    this.unbindElement();
    const internal = this._ensureInternal();
    internal.fit = 'fill';
    this._source = internal;

    const cap = { element, embedFonts, debounce, fontCache: new Map(), timer: 0, running: null, queued: false, cleanup: [] };
    this._capture = cap;
    this._setOverlay(overlay);

    if (live) {
      const mo = new MutationObserver((records) => {
        if (records.some((m) => m.target !== this.canvas)) this._scheduleCapture();
      });
      mo.observe(element, { subtree: true, childList: true, characterData: true, attributes: true });
      const ro = new ResizeObserver(() => this._scheduleCapture());
      ro.observe(element);
      const onFonts = () => this._scheduleCapture();
      document.fonts?.addEventListener?.('loadingdone', onFonts);
      cap.cleanup.push(() => mo.disconnect(), () => ro.disconnect(),
        () => document.fonts?.removeEventListener?.('loadingdone', onFonts));
    }
    (document.fonts?.ready ?? Promise.resolve()).then(() => { if (this._capture === cap) this.refresh(); });
    return this;
  }

  /** Stop live DOM capture and return to opaque rendering (the last capture stays as the source). */
  unbindElement() {
    const cap = this._capture;
    if (!cap) return this;
    clearTimeout(cap.timer);
    cap.cleanup.forEach((fn) => fn());
    this._capture = null;
    this._setOverlay(false);
    return this;
  }

  /** Re-capture the bound DOM element now. Resolves when the new texture is in place. */
  refresh() {
    const cap = this._capture;
    if (!cap) return Promise.resolve();
    clearTimeout(cap.timer);
    if (cap.running) { cap.queued = true; return cap.running; }
    cap.running = (async () => {
      try {
        const rect = this.canvas.getBoundingClientRect();
        const canvas = await rasterizeElement(cap.element, {
          region: { x: rect.left, y: rect.top, width: this.width, height: this.height },
          pixelRatio: this._buffer.x / this.width,
          background: resolveBackground(cap.element, new THREE.Color(this.params.background).getStyle()),
          exclude: [this.canvas],
          embedFonts: cap.embedFonts,
          fontCache: cap.fontCache,
        });
        if (this._capture !== cap || this._destroyed) return;
        this._assignImage(canvas);
        this.onCapture?.(canvas);
      } catch (err) {
        console.warn('[ChromaticLens] DOM capture failed:', err);
      } finally {
        cap.running = null;
        if (cap.queued && this._capture === cap) { cap.queued = false; this._scheduleCapture(); }
      }
    })();
    return cap.running;
  }

  /** Re-measure the target element and resize the canvas + FBO. */
  resize() {
    if (this._destroyed) return;
    const w = Math.max(1, this.targetElement.clientWidth);
    const h = Math.max(1, this.targetElement.clientHeight);
    const changed = w !== this.width || h !== this.height;
    this.width = w;
    this.height = h;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.params.maxDpr));
    this.renderer.setSize(w, h, false);
    this.renderer.getDrawingBufferSize(this._buffer);
    this._rt.setSize(this._buffer.x, this._buffer.y);
    const U = this._material.uniforms;
    U.uResolution.value.copy(this._buffer);
    U.uDpr.value = this._buffer.x / w;
    this.onResize?.({ width: w, height: h, pixelRatio: this._buffer.x / w, bufferWidth: this._buffer.x, bufferHeight: this._buffer.y });
    if (changed && this._capture) this._scheduleCapture();
  }

  /** Stop rendering, remove listeners and the canvas, and free GPU resources. */
  destroy() {
    if (this._destroyed) return;
    this.unbindElement();
    this._destroyed = true;
    this.renderer.setAnimationLoop(null);
    this._ro.disconnect();
    this._io.disconnect();
    const t = this.targetElement;
    t.removeEventListener('pointermove', this._onPointerMove);
    t.removeEventListener('pointerdown', this._onPointerDown);
    t.removeEventListener('pointerup', this._onPointerUp);
    t.removeEventListener('pointercancel', this._onPointerUp);
    t.removeEventListener('pointerleave', this._onPointerLeave);
    t.removeEventListener('wheel', this._onWheel);
    Object.assign(t.style, this._savedStyle);
    this._rt.dispose();
    this._material.dispose();
    this._quad.geometry.dispose();
    if (this._internal) {
      this._releaseOwnedTexture();
      this._internal.mesh.geometry.dispose();
      this._internal.mesh.material.dispose();
    }
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }

  // --- Sources -------------------------------------------------------------------------

  _ensureInternal() {
    if (!this._internal) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { map: { value: null }, uScale: { value: new THREE.Vector2(1, 1) } },
        vertexShader: SOURCE_VERT, fragmentShader: SOURCE_FRAG, depthTest: false, depthWrite: false,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
      mesh.frustumCulled = false;
      this._internal = {
        internal: true, scene: new THREE.Scene().add(mesh), camera: new THREE.Camera(), mesh,
        texture: null, owned: false, fit: 'cover', size: [0, 0], pendingUrl: null,
      };
    }
    return this._internal;
  }

  _setTextureSource(source, fit) {
    const internal = this._ensureInternal();
    internal.fit = fit;
    this._source = internal;
    if (typeof source === 'string') {
      internal.pendingUrl = source;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => { if (!this._destroyed && internal.pendingUrl === source) this._assignImage(img); };
      img.onerror = () => console.warn(`[ChromaticLens] could not load texture: ${source}`);
      img.src = source;
      return;
    }
    internal.pendingUrl = null;
    if (source?.isTexture) {
      this._releaseOwnedTexture();
      internal.texture = source;
      internal.owned = false;
      internal.mesh.material.uniforms.map.value = source;
    } else {
      this._assignImage(source);
    }
  }

  // Upload an image/canvas/video into the internal (owned) texture, reusing it when possible.
  _assignImage(img) {
    const internal = this._ensureInternal();
    const isVideo = typeof HTMLVideoElement !== 'undefined' && img instanceof HTMLVideoElement;
    const size = mediaSize(img);
    let tex = internal.owned ? internal.texture : null;
    if (!tex || !!tex.isVideoTexture !== isVideo) {
      this._releaseOwnedTexture();
      tex = isVideo ? new THREE.VideoTexture(img) : new THREE.Texture(img);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.minFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      internal.owned = true;
    } else if (tex.image !== img || size[0] !== internal.size[0] || size[1] !== internal.size[1]) {
      tex.dispose();          // GPU storage is immutable — a new size needs a new allocation
      tex.image = img;
    }
    internal.size = size;
    tex.needsUpdate = true;
    internal.texture = tex;
    internal.mesh.material.uniforms.map.value = tex;
  }

  _releaseOwnedTexture() {
    const internal = this._internal;
    if (internal?.owned && internal.texture) internal.texture.dispose();
    if (internal) { internal.texture = null; internal.owned = false; }
  }

  _scheduleCapture() {
    const cap = this._capture;
    if (!cap) return;
    clearTimeout(cap.timer);
    cap.timer = setTimeout(() => this.refresh(), cap.debounce);
  }

  _setOverlay(on) {
    this._overlay = on;
    this._material.uniforms.uOverlay.value = on ? 1 : 0;
    this._applyClearColor();
  }

  _applyClearColor() {
    this.renderer.setClearColor(this.params.background, this._overlay ? 0 : 1);
  }

  _applyTargetStyle() {
    const s = this.targetElement.style;
    s.cursor = this.params.cursor ? 'none' : this._savedStyle.cursor;
    s.touchAction = this.params.touchAction ?? this._savedStyle.touchAction;
    s.webkitTouchCallout = 'none';
  }

  _sourceReady() {
    const src = this._source;
    if (!src) return false;
    if (!src.internal) return true;
    const tex = src.texture;
    return !!tex && mediaSize(tex.image)[0] > 0;
  }

  // --- Input ---------------------------------------------------------------------------

  _local(e) {
    const rect = this.canvas.getBoundingClientRect();
    let x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (e.pointerType === 'touch' && this.params.touchOffset) {
      x += this.params.touchOffset.x || 0;
      y += this.params.touchOffset.y || 0;
    }
    return { x, y };
  }

  _onPointerMove(e) {
    if (!e.isPrimary) return;                          // ignore extra fingers
    const { x, y } = this._local(e);
    const p = this._pointer;
    if (p.mode !== 'track' || !p.inside) { p.px = x; p.py = y; }   // no velocity spike on (re)entry
    p.x = x; p.y = y;
    p.mode = 'track';
    p.inside = true;
    p.mouse = e.pointerType === 'mouse';
  }

  _onPointerDown(e) {
    if (!e.isPrimary) return;
    this._onPointerMove(e);
    this._lens.vr += 900;  // impulse → the radius spring overshoots and settles
  }

  _onPointerUp(e) {
    // A lifted (or cancelled) finger holds the lens where it was; the next touch re-anchors.
    if (e.isPrimary && e.pointerType !== 'mouse') this._pointer.inside = false;
  }

  _onPointerLeave(e) {
    const p = this._pointer;
    p.inside = false;
    // Leaving the window resumes the idle drift; moving onto an overlay (e.g. a control panel) holds.
    if (!e.relatedTarget && e.pointerType === 'mouse') p.mode = 'idle';
  }

  _onWheel(e) {
    if (!this.params.wheelResize) return;
    e.preventDefault();
    const radius = Math.round(clamp(this.params.radius - e.deltaY * 0.25, 40, 420));
    this.params.radius = radius;
    this.onParamsChange?.({ radius });
  }

  // --- Frame ---------------------------------------------------------------------------

  _tick() {
    const now = performance.now();
    const dt = Math.min((now - this._last) / 1000, 1 / 30);
    this._last = now;
    if (!this._visible) return;
    this._time += dt;

    const P = this.params, L = this._lens, ptr = this._pointer, S = this._shape;
    const W = this.width, H = this.height, t = this._time;
    const still = this._reduceMotion;
    this.onFrame?.(t, dt);

    // Target: the pointer (or where it was last seen), else an idle Lissajous drift.
    let tx = ptr.x, ty = ptr.y;
    if (ptr.mode === 'idle') {
      const drift = P.idleDrift && !still;
      tx = W * (0.5 + (drift ? 0.26 * Math.sin(t * 0.31) : 0));
      ty = H * (0.5 + (drift ? 0.16 * Math.sin(t * 0.47 + 1.3) : 0));
    }

    // Motion source for the pinch: the per-frame pointer delta while tracking,
    // the lens' own velocity while drifting.
    let mvx = L.vx, mvy = L.vy;
    if (ptr.mode === 'track') {
      const k = 1 - Math.exp(-dt * 30);
      ptr.vx += ((ptr.x - ptr.px) / Math.max(dt, 1e-3) - ptr.vx) * k;
      ptr.vy += ((ptr.y - ptr.py) / Math.max(dt, 1e-3) - ptr.vy) * k;
      mvx = ptr.vx; mvy = ptr.vy;
    }
    ptr.px = ptr.x; ptr.py = ptr.y;

    // Orientation as a doubled angle, so opposite directions share one ellipse axis
    // and reversals blend smoothly instead of flipping.
    const speed = Math.hypot(mvx, mvy);
    if (speed > 30) {
      const ux = mvx / speed, uy = -mvy / speed;   // to GL (y up)
      const k = 1 - Math.exp(-dt * 14);
      S.c2 += (ux * ux - uy * uy - S.c2) * k;
      S.s2 += (2 * ux * uy - S.s2) * k;
    }
    const pinchTarget = still ? 0 : Math.min((speed * P.pinch) / 3000, 0.45);
    const pinchDamping = 36 - 33 * clamp(P.jiggle, 0, 1);  // 36 ≈ critical for k = 320

    // Damped springs — semi-implicit Euler, sub-stepped for stability at high stiffness.
    const steps = 4, h = dt / steps;
    for (let i = 0; i < steps; i++) {
      L.vx += (P.stiffness * (tx - L.x) - P.damping * L.vx) * h;
      L.vy += (P.stiffness * (ty - L.y) - P.damping * L.vy) * h;
      L.vr += (240 * (P.radius - L.r) - 20 * L.vr) * h;
      S.vel += (320 * (pinchTarget - S.v) - pinchDamping * S.vel) * h;
      L.x += L.vx * h; L.y += L.vy * h; L.r += L.vr * h;
      S.v += S.vel * h;
    }
    ptr.dot += ((ptr.inside && ptr.mouse && P.cursor ? 1 : 0) - ptr.dot) * Math.min(dt * 10, 1);

    const r = this.renderer;
    if (!this._sourceReady()) {           // nothing to refract yet (image loading, first DOM capture)
      r.setRenderTarget(null);
      r.clear();
      return;
    }

    // Uniforms (CSS px → drawing-buffer px, y flipped).
    const U = this._material.uniforms, k = this._buffer.x / W;
    const theta = Math.atan2(S.s2, S.c2) / 2;
    U.uCenter.value.set(L.x * k, (H - L.y) * k);
    U.uRadius.value = Math.max(L.r, 0) * k;
    U.uAxis.value.set(Math.cos(theta), Math.sin(theta));
    U.uPinch.value = clamp(S.v, -0.3, 0.5);
    U.uPointer.value.set(ptr.x * k, (H - ptr.y) * k);
    U.uPointerAlpha.value = ptr.dot;
    U.uRefraction.value = P.refraction;
    U.uIOR.value = P.ior;
    U.uProfile.value = P.profile;
    U.uDispersion.value = P.dispersion;
    U.uFalloff.value = P.falloff;
    U.uContrast.value = P.contrast;
    U.uSamples.value = clamp(Math.round(P.samples), 1, 32);
    U.uGlow.value = P.edgeGlow;
    U.uFilm.value = P.film;
    U.uFresnel.value = P.fresnel;
    U.uHighlight.value = P.highlight;
    U.uVignette.value = P.vignette;
    U.uGrain.value = P.grain;
    U.uTime.value = t;

    const src = this._source;
    if (src.internal) {
      const [iw, ih] = mediaSize(src.texture.image);
      const ia = iw / ih, va = W / H;
      if (src.fit === 'cover') src.mesh.material.uniforms.uScale.value.set(Math.min(1, va / ia), Math.min(1, ia / va));
      else src.mesh.material.uniforms.uScale.value.set(1, 1);
    }

    r.setRenderTarget(this._rt);
    r.render(src.scene, src.camera);
    r.setRenderTarget(null);
    r.render(this._lensScene, this._lensCam);
  }
}
