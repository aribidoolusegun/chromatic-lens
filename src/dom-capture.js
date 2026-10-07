/**
 * DOM → canvas rasteriser via SVG <foreignObject>. No dependencies.
 *
 * The element is deep-cloned with every computed style inlined, its images and webfonts are
 * embedded as data URLs (an SVG drawn as an image cannot fetch anything), and the result is
 * drawn onto a canvas at the requested pixel ratio.
 *
 * Limits: ::before/::after content, CSS background images, cross-origin images without CORS
 * headers, iframes and closed shadow roots are not captured.
 */

const SKIP_TAGS = new Set(['SCRIPT', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META']);

/** Paint `element` into a canvas covering the viewport-space rectangle `region`. */
export async function rasterizeElement(element, {
  region,                  // { x, y, width, height } in CSS px, viewport coordinates
  pixelRatio = 1,
  background = null,       // CSS colour painted under the capture
  exclude = [],            // nodes to leave out (e.g. the lens' own canvas)
  embedFonts = true,
  fontCache = new Map(),
} = {}) {
  const families = new Set();
  const clone = cloneTree(element, new Set(exclude), families);
  if (!clone) throw new Error('rasterizeElement: nothing to capture.');

  // Place the clone where the element sits inside the capture region.
  const r = element.getBoundingClientRect();
  clone.style.setProperty('position', 'absolute');
  clone.style.setProperty('left', `${r.left - region.x}px`);
  clone.style.setProperty('top', `${r.top - region.y}px`);
  clone.style.setProperty('margin', '0');
  clone.style.setProperty('transform', 'none');

  const [fontCSS] = await Promise.all([
    embedFonts ? getFontCSS(families, fontCache) : '',
    inlineImages(clone),
  ]);

  const { width, height } = region;
  const xhtml = new XMLSerializer().serializeToString(clone);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    (fontCSS ? `<style><![CDATA[${fontCSS}]]></style>` : '') +
    `<foreignObject x="0" y="0" width="100%" height="100%">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:${width}px;height:${height}px;overflow:hidden;margin:0">` +
    `${xhtml}</div></foreignObject></svg>`;

  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  // Safari can report "decoded" before webfonts inside the SVG have painted; give it a frame.
  await new Promise((res) => requestAnimationFrame(() => res()));

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * pixelRatio));
  canvas.height = Math.max(1, Math.round(height * pixelRatio));
  const ctx = canvas.getContext('2d');
  if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** First non-transparent background colour on the element or its ancestors. */
export function resolveBackground(element, fallback = '#000') {
  for (let el = element; el && el.nodeType === 1; el = el.parentElement) {
    const bg = getComputedStyle(el).backgroundColor;
    if (bg && bg !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(bg)) return bg;
  }
  return fallback;
}

// --- Cloning ------------------------------------------------------------------------------

function cloneTree(node, exclude, families) {
  if (exclude.has(node)) return null;
  if (node.nodeType === 3) return node.cloneNode(false);
  if (node.nodeType !== 1 || SKIP_TAGS.has(node.tagName)) return null;

  let clone;
  if (node.tagName === 'CANVAS') {
    clone = document.createElement('img');
    try { clone.src = node.toDataURL(); } catch { /* tainted canvas — leave blank */ }
  } else if (node.tagName === 'VIDEO') {
    clone = document.createElement('img');
    try {
      const c = document.createElement('canvas');
      c.width = node.videoWidth || node.clientWidth; c.height = node.videoHeight || node.clientHeight;
      c.getContext('2d').drawImage(node, 0, 0, c.width, c.height);
      clone.src = c.toDataURL();
    } catch { /* cross-origin video */ }
  } else {
    clone = node.cloneNode(false);
  }

  const cs = getComputedStyle(node);
  copyStyle(cs, clone);
  for (const f of cs.fontFamily.split(',')) families.add(f.trim().replace(/^["']|["']$/g, '').toLowerCase());

  if (node.tagName === 'INPUT') clone.setAttribute('value', node.value);
  if (node.tagName === 'TEXTAREA') clone.textContent = node.value;
  if (node.tagName === 'IMG' && node.currentSrc) { clone.setAttribute('src', node.currentSrc); clone.removeAttribute('srcset'); }

  const children = node.shadowRoot ? node.shadowRoot.childNodes : node.childNodes;
  for (const child of children) {
    const c = cloneTree(child, exclude, families);
    if (c) clone.appendChild(c);
  }
  return clone;
}

function copyStyle(cs, target) {
  let css = '';
  for (let i = 0; i < cs.length; i++) {
    const p = cs[i];
    css += `${p}:${cs.getPropertyValue(p)}${cs.getPropertyPriority(p) ? ' !important' : ''};`;
  }
  target.setAttribute('style', css);
}

// --- Images -------------------------------------------------------------------------------

async function inlineImages(root) {
  const imgs = root.tagName === 'IMG' ? [root] : [...root.querySelectorAll('img')];
  await Promise.all(imgs.map(async (img) => {
    const src = img.getAttribute('src');
    if (!src || src.startsWith('data:')) return;
    try { img.setAttribute('src', await toDataURL(src)); } catch { img.removeAttribute('src'); }
  }));
}

async function toDataURL(url) {
  const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

// --- Webfonts -----------------------------------------------------------------------------

/**
 * Collect @font-face rules for the families in use and embed their font files. Cross-origin
 * stylesheets (e.g. Google Fonts) are re-fetched, which works when they are served with CORS.
 * Only faces covering basic Latin are embedded, to keep the SVG small.
 */
async function getFontCSS(families, cache) {
  const key = [...families].sort().join('|');
  if (!cache.has(key)) cache.set(key, buildFontCSS(families).catch(() => ''));
  return cache.get(key);
}

async function buildFontCSS(families) {
  const faces = [];
  for (const sheet of document.styleSheets) {
    let rules = null;
    const base = sheet.href || location.href;
    try {
      rules = sheet.cssRules;
    } catch {
      if (!sheet.href) continue;
      try {
        const text = await (await fetch(sheet.href, { mode: 'cors', credentials: 'omit' })).text();
        const parsed = new CSSStyleSheet();
        parsed.replaceSync(text.replace(/@import[^;]+;/g, ''));
        rules = parsed.cssRules;
      } catch { continue; }
    }
    collectFaces(rules, base, families, faces);
  }

  const css = await Promise.all(faces.map(async ({ cssText, base }) => {
    const urls = [...cssText.matchAll(/url\((['"]?)([^'")]+)\1\)/g)];
    let out = cssText;
    for (const [match, , url] of urls) {
      if (url.startsWith('data:')) continue;
      try { out = out.replace(match, `url("${await toDataURL(new URL(url, base).href)}")`); } catch { /* keep remote url */ }
    }
    return out;
  }));
  return css.join('\n');
}

function collectFaces(rules, base, families, out) {
  for (const rule of rules) {
    if (rule.type === CSSRule.FONT_FACE_RULE) {
      const family = rule.style.getPropertyValue('font-family').trim().replace(/^["']|["']$/g, '').toLowerCase();
      if (!families.has(family)) continue;
      const range = rule.style.getPropertyValue('unicode-range');
      if (range && !coversBasicLatin(range)) continue;
      out.push({ cssText: rule.cssText, base });
    } else if (rule.cssRules) {
      collectFaces(rule.cssRules, base, families, out);   // @media / @supports blocks
    }
  }
}

function coversBasicLatin(range) {
  return range.split(',').some((token) => {
    const m = token.trim().toUpperCase().match(/^U\+([0-9A-F?]+)(?:-([0-9A-F]+))?$/);
    if (!m) return false;
    const lo = parseInt(m[1].replace(/\?/g, '0'), 16);
    const hi = m[2] ? parseInt(m[2], 16) : parseInt(m[1].replace(/\?/g, 'F'), 16);
    return lo <= 0x41 && hi >= 0x41;   // contains "A"
  });
}
