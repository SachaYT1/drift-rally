/**
 * Maps every VisualId to its model files (Kenney CC0, see public/models/LICENSES.md) or to a
 * procedural builder (files: null, built by render/procedural.ts).
 *
 * The block between the GENERATED markers is rewritten by `node scripts/build-assets.mjs`; change
 * model picks, heights or tints in that script's VISUALS table and re-run it instead of editing here.
 */
import type { VisualId } from '../track/trackDef';

/** Toy-world scale: props are WORLD_SCALE x their real size (design spec §3). */
export const WORLD_SCALE = 12;

export interface CatalogEntry {
  /** Model paths relative to import.meta.env.BASE_URL, one per variant; null = procedural visual. */
  files: string[] | null;
  /** Real-world height, m. Models are scaled to realHeight * WORLD_SCALE (= VISUAL_HEIGHT). */
  realHeight: number;
  /** Optional colour multiplier (0xRRGGBB) applied to every material of the visual. */
  tint?: number;
  /** World-scale bounding-box size [x, y, z] of each variant, m. Models face +Z, origin at ground centre. */
  sizes?: [number, number, number][];
}

export const CATALOG: Record<VisualId, CatalogEntry> = {
  // BEGIN GENERATED (scripts/build-assets.mjs)
  officeTower: { files: ['models/officeTower-1.glb', 'models/officeTower-2.glb'], realHeight: 25, sizes: [[91.1, 300, 91.1], [95.2, 300, 91.3]] },
  officeBlock: { files: ['models/officeBlock-1.glb', 'models/officeBlock-2.glb', 'models/officeBlock-3.glb'], realHeight: 12.5, sizes: [[110.7, 150, 116.2], [90.5, 150, 92.6], [140.3, 150, 110.1]] },
  person: { files: ['models/person-1.glb', 'models/person-2.glb', 'models/person-3.glb'], realHeight: 1.6667, sizes: [[18.4, 20, 11.6], [18.4, 20, 9.4], [18.5, 20, 14.7]] },
  bench: { files: ['models/bench.glb'], realHeight: 0.8, sizes: [[14.7, 9.6, 8.3]] },
  lamp: { files: ['models/lamp.glb'], realHeight: 4, sizes: [[6.7, 48, 6.9]] },
  tree: { files: ['models/tree-1.glb', 'models/tree-2.glb'], realHeight: 5, sizes: [[26.9, 60, 26.9], [43.2, 60, 43.2]] },
  bush: { files: ['models/bush.glb'], realHeight: 1, tint: 0x9ccf8a, sizes: [[20.1, 12, 20.1]] },
  trashBin: { files: ['models/trashBin.glb'], realHeight: 1, sizes: [[11.6, 12, 11.6]] },
  fountain: { files: ['models/fountain.glb'], realHeight: 1.5, sizes: [[75, 18, 75]] },
  planterTree: { files: null, realHeight: 4.1667 },
  bicycle: { files: null, realHeight: 1.0833 },
  sneaker: { files: null, realHeight: 0.1333 },
  can: { files: ['models/can.glb'], realHeight: 0.125, sizes: [[1, 1.5, 1]] },
  cup: { files: ['models/cup-1.glb', 'models/cup-2.glb'], realHeight: 0.15, sizes: [[1.1, 1.8, 1.1], [0.9, 1.8, 0.9]] },
  startArch: { files: null, realHeight: 1 },
  // END GENERATED
};
