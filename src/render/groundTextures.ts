/**
 * Small procedural ground textures (paving tiles, wooden deck planks, soft contact blob), generated as
 * DataTextures so they work without a DOM (unit tests) and need no asset files. sRGB colour data with
 * mipmaps and anisotropy (three clamps it to the GPU maximum) because the chase camera sees the ground
 * at grazing angles.
 */
import * as THREE from 'three';
import { seededRandom } from '../shared/math';

type Rgb = readonly [number, number, number];

function hexToRgb(hex: number): Rgb {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
}

function makeTexture(data: Uint8Array, size: number, srgb: boolean): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

function shade(c: Rgb, f: number): Rgb {
  return [Math.min(255, c[0] * f), Math.min(255, c[1] * f), Math.min(255, c[2] * f)];
}

export interface TileOptions {
  /** Texture size in pixels (power of two). */
  size: number;
  /** Tiles per texture side. */
  tiles: number;
  base: number;
  grout: number;
  /** Grout line width in pixels. */
  groutPx: number;
  /** Per-tile brightness variation (+/-). */
  variation: number;
  /** Per-pixel speckle (+/-). */
  speckle: number;
  seed: number;
}

/** Square paving tiles with darker grout lines and slight per-tile shade variation. */
export function createTileTexture(o: TileOptions): THREE.DataTexture {
  const rand = seededRandom(o.seed);
  const base = hexToRgb(o.base);
  const grout = hexToRgb(o.grout);
  const cell = o.size / o.tiles;
  const tileShade = Array.from({ length: o.tiles * o.tiles }, () => 1 + (rand() * 2 - 1) * o.variation);
  const data = new Uint8Array(o.size * o.size * 4);
  for (let y = 0; y < o.size; y++) {
    for (let x = 0; x < o.size; x++) {
      const gx = x % cell;
      const gy = y % cell;
      const isGrout = gx < o.groutPx || gy < o.groutPx;
      const tile = Math.floor(y / cell) * o.tiles + Math.floor(x / cell);
      const f = 1 + (rand() * 2 - 1) * o.speckle;
      const c = isGrout ? shade(grout, f) : shade(base, tileShade[tile] * f);
      const i = (y * o.size + x) * 4;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  }
  return makeTexture(data, o.size, true);
}

/**
 * Wooden deck: planks run along texture u, `planks` per texture height, staggered butt joints, dark
 * seams and a little grain. Colours are sRGB hex.
 */
export function createPlankTexture(size: number, planks: number, colors: readonly number[], seam: number, seed: number): THREE.DataTexture {
  const rand = seededRandom(seed);
  const rgb = colors.map(hexToRgb);
  const seamRgb = hexToRgb(seam);
  const plankH = size / planks;
  // Each plank row: a colour and a butt-joint offset (joints every half texture).
  const rows = Array.from({ length: planks }, () => ({ color: rgb[Math.floor(rand() * rgb.length)], joint: Math.floor(rand() * size) }));
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const row = rows[Math.floor(y / plankH)];
    const inRow = y % plankH;
    for (let x = 0; x < size; x++) {
      const jx = (x - row.joint + size) % (size / 2);
      const isSeam = inRow < 1 || jx < 1;
      const grain = 1 + Math.sin((x * 0.21 + y * 1.7) * 0.9) * 0.025 + (rand() * 2 - 1) * 0.03;
      const c = isSeam ? seamRgb : shade(row.color, grain);
      const i = (y * size + x) * 4;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  }
  return makeTexture(data, size, true);
}

/** Soft radial blob (white, alpha falls off smoothly to 0 at the edge) for contact shadows. */
export function createBlobTexture(size: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.min(1, Math.hypot(x - c, y - c) / c);
      const a = Math.pow(1 - d * d, 1.6);
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  }
  const tex = makeTexture(data, size, false);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}
