/**
 * Recoloured copies of Kenney colormap atlases (world.ts). The atlases are palettes of colour swatches
 * shared by several models (e.g. tree leaves, people and bins use one atlas), so a material colour
 * multiplier cannot turn the kit's saturated teal leaves into the reference's soft fresh green without
 * also tinting trunks and clothes. Instead the caller swaps the map of its own material clones for a
 * recoloured copy made once per source texture.
 *
 * Browser only (needs a 2D canvas): without a DOM or a drawable image the source texture is returned.
 */
import * as THREE from 'three';

/** sRGB 0..1 in, sRGB 0..1 out (h in degrees). */
export type HslFn = (h: number, s: number, l: number) => [number, number, number];

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function hue(p: number, q: number, t: number): number {
  const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
  if (u < 1 / 6) return p + (q - p) * 6 * u;
  if (u < 1 / 2) return q;
  if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s <= 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const k = (((h % 360) + 360) % 360) / 360;
  return [hue(p, q, k + 1 / 3), hue(p, q, k), hue(p, q, k - 1 / 3)];
}

/** Teal-green leaf swatches -> soft yellow-green (reference foliage); trunks a little less orange. */
export const foliagePixel: HslFn = (h, s, l) => {
  if (h >= 85 && h <= 185 && s > 0.2) return [102 + (h - 150) * 0.2, Math.min(0.48, Math.max(0.3, s * 0.55)), 0.33 + l * 0.6];
  if (h >= 10 && h <= 45 && s > 0.3) return [h, s * 0.75, l];
  return [h, s, l];
};

/** Lifts the kit's dark navy frames and deep blue glass toward the reference's pastel facades. */
export const buildingPixel: HslFn = (h, s, l) => [h, s * 0.8, 0.3 + l * 0.7];

/** Returns a function mapping a source texture to its recoloured copy (cached; source if impossible). */
export function createRecolorer(fn: HslFn): (source: THREE.Texture) => THREE.Texture {
  const cache = new Map<THREE.Texture, THREE.Texture>();
  return (source) => {
    const cached = cache.get(source);
    if (cached) return cached;
    const out = recolor(source, fn) ?? source;
    cache.set(source, out);
    return out;
  };
}

function recolor(source: THREE.Texture, fn: HslFn): THREE.Texture | null {
  const img: unknown = source.image;
  if (typeof document === 'undefined' || !img || typeof img !== 'object') return null;
  const { width, height } = img as { width?: number; height?: number };
  if (!width || !height) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(img as CanvasImageSource, 0, 0);
  } catch {
    return null;
  }
  const data = ctx.getImageData(0, 0, width, height);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    const [h, s, l] = rgbToHsl(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255);
    const [r, g, b] = hslToRgb(...fn(h, s, l));
    px[i] = Math.round(r * 255);
    px[i + 1] = Math.round(g * 255);
    px[i + 2] = Math.round(b * 255);
  }
  ctx.putImageData(data, 0, 0);
  const out = new THREE.CanvasTexture(canvas);
  out.name = `${source.name}|recolor`;
  out.colorSpace = source.colorSpace;
  out.flipY = source.flipY;
  out.wrapS = source.wrapS;
  out.wrapT = source.wrapT;
  out.magFilter = source.magFilter;
  out.minFilter = source.minFilter;
  out.generateMipmaps = source.generateMipmaps;
  out.anisotropy = source.anisotropy;
  out.channel = source.channel;
  out.needsUpdate = true;
  return out;
}
