/**
 * Procedural world objects (plan Task 11): the zone-4 bench, zone-3 bicycle, zone-7 sneaker, the zone-5
 * planter with its tree, and the start arch. Exact dimensions match the collider footprints in
 * track/plaza.ts (checked by procedural.test.ts).
 *
 * Conventions (bridge.ts): built facing +Z with +X on the object's LEFT, origin at ground centre, so a
 * heavy-obstacle footprint point (x along the track, z = left) sits at model (X = z, Z = x).
 * Every builder makes fresh flat-shaded Lambert materials (callers may fade or dispose them) and merges
 * its parts per material. Parts that should fade when they hide the car are tagged `userData.occluder`
 * and grouped under a child with `userData.occluderGroup` (see findOccluderGroups()).
 */
import * as THREE from 'three';
import { PartSet, boxAt, cylinderAt, lambert, tubeBetween } from './proceduralKit';

export { createBicycle, createSneaker } from './proceduralBike';
export { findOccluderGroups } from './proceduralKit';

export interface Size3 {
  x: number;
  y: number;
  z: number;
}

// ---- Bench (zone 4): legs exactly on the plaza.ts footprint, local (+/-2.5, +/-5.5) r 0.45 ----
/** Leg centres in model space: X = footprint lateral (+/-5.5), Z = footprint along-track (+/-2.5). */
export const BENCH_LEG_X = 5.5;
export const BENCH_LEG_Z = 2.5;
export const BENCH_LEG_R = 0.45;
export const BENCH_SEAT_TOP = 5.4;
const SEAT_THICKNESS = 0.5;
const SEAT_HALF_LENGTH = 7.6;
const SEAT_HALF_DEPTH = 3.0;
const BACK_TOP = 9.6;
/** Backrest leans back (toward -Z) by this much between the seat and its top, m. */
const BACK_LEAN = 0.7;

// ---- Planter tree (zone 5) ----
const PLANTER_R = 20;
const PLANTER_H = 6;
const TREE_TOP = 50;

// ---- Start arch ----
const ARCH_POST = 1.8;
const ARCH_HEIGHT = 13;
/** Banner bottom stays above the chase camera (height 9.5 m plus shake and near plane). */
const BANNER_BOTTOM = 10.8;
const BANNER_TOP = 12.8;
const BANNER_DEPTH = 0.6;

/** Documented bounding-box sizes (model space), metres. */
export const PROCEDURAL_SIZE: Readonly<Record<'bench' | 'bicycle' | 'sneaker' | 'planterTree', Size3>> = {
  bench: { x: 2 * SEAT_HALF_LENGTH, y: BACK_TOP, z: 6.9 },
  bicycle: { x: 8.4, y: 13, z: 21 },
  sneaker: { x: 2, y: 1.6, z: 6 },
  planterTree: { x: 2 * PLANTER_R, y: TREE_TOP, z: 2 * PLANTER_R },
};

/** Bounding box of createStartArch(width): posts stand just outside the span. */
export function startArchSize(width: number): Size3 {
  return { x: width + 2 * ARCH_POST, y: ARCH_HEIGHT, z: ARCH_POST };
}

const COLORS = {
  wood: 0xc98a57,
  iron: 0x3c414e,
  planter: 0xc58f72,
  planterRim: 0xebe2d6,
  soil: 0x6e5040,
  trunk: 0x8d6244,
  leafA: 0x8dbd72,
  leafB: 0x7aae62,
  leafC: 0x9cc982,
  archWhite: 0xf7f5f1,
  archCoral: 0xf0573a,
  archDark: 0x2c2d33,
};

/**
 * Giant park bench spanning the road (zone 4). Seat slats run across the road at 4.9..5.4 m; the backrest
 * rises on the approach side (-Z) up to 9.6 m. Seat, backrest and its posts are occluders.
 */
export function createBench(): THREE.Group {
  const wood = lambert(COLORS.wood);
  const iron = lambert(COLORS.iron);
  const parts = new PartSet();
  const seatBottom = BENCH_SEAT_TOP - SEAT_THICKNESS;

  // Four legs, exactly the collider circles, plus a side rail under the seat on each side.
  for (const x of [-BENCH_LEG_X, BENCH_LEG_X]) {
    for (const z of [-BENCH_LEG_Z, BENCH_LEG_Z]) {
      parts.add(cylinderAt(BENCH_LEG_R, BENCH_LEG_R, seatBottom, 10, x, 0, z), iron, { part: 'leg' });
    }
    parts.add(boxAt(0.6, 0.6, 2 * SEAT_HALF_DEPTH - 0.4, x, seatBottom - 0.3, 0), iron, { part: 'rail' });
  }

  // Seat: five slats across the road.
  const slats = 5;
  const gap = 0.2;
  const slatDepth = (2 * SEAT_HALF_DEPTH - (slats - 1) * gap) / slats;
  for (let i = 0; i < slats; i++) {
    const z = -SEAT_HALF_DEPTH + slatDepth / 2 + i * (slatDepth + gap);
    parts.add(boxAt(2 * SEAT_HALF_LENGTH, SEAT_THICKNESS, slatDepth, 0, BENCH_SEAT_TOP - SEAT_THICKNESS / 2, z), wood, {
      part: 'seat',
      occluder: true,
    });
  }

  // Backrest posts continue the back legs upward, leaning back; three slats ride on them.
  const postBase = BENCH_SEAT_TOP - 0.2;
  const postTop = BACK_TOP - 0.25;
  const lean = Math.atan2(BACK_LEAN, postTop - postBase);
  const postZ = (y: number) => -BENCH_LEG_Z - 0.3 - ((y - postBase) / (postTop - postBase)) * BACK_LEAN;
  for (const x of [-BENCH_LEG_X, BENCH_LEG_X]) {
    parts.add(tubeBetween([x, postBase, postZ(postBase)], [x, postTop, postZ(postTop)], 0.4, 8), iron, {
      part: 'backrest',
      occluder: true,
    });
  }
  // Slats ride on the sitter's side (+Z) of the posts.
  const backSlats = 3;
  for (let i = 0; i < backSlats; i++) {
    const t = (i + 0.5) / backSlats;
    const y = BENCH_SEAT_TOP + 0.9 + t * (BACK_TOP - BENCH_SEAT_TOP - 1.05);
    parts.add(boxAt(2 * SEAT_HALF_LENGTH, 0.95, 0.42, 0, y, postZ(y) + 0.45, -lean), wood, { part: 'backrest', occluder: true });
  }
  return parts.build('bench');
}

/**
 * Round planter (~40 m wide, 6 m tall) with a low-poly tree reaching 50 m (zone 5 hairpin centre).
 * Only the tub casts shadows (tall decor must not, design spec §5); the canopy is an occluder.
 */
export function createPlanterTree(): THREE.Group {
  const parts = new PartSet();
  const planter = { part: 'planter' };
  parts.add(cylinderAt(PLANTER_R - 0.6, PLANTER_R - 1.6, PLANTER_H - 0.7, 24, 0, 0, 0), lambert(COLORS.planter), planter);
  parts.add(cylinderAt(PLANTER_R, PLANTER_R, 0.7, 24, 0, PLANTER_H - 0.7, 0), lambert(COLORS.planterRim), planter);
  parts.add(cylinderAt(PLANTER_R - 1.4, PLANTER_R - 1.4, 0.1, 24, 0, PLANTER_H - 0.2, 0), lambert(COLORS.soil), {
    part: 'planter',
    castShadow: false,
  });

  const trunk = lambert(COLORS.trunk);
  const tall = { part: 'tree', castShadow: false };
  parts.add(cylinderAt(1.4, 2.4, 24, 7, 0, PLANTER_H - 0.2, 0), trunk, tall);
  parts.add(tubeBetween([0, 18, 0], [6.5, 27, 2.5], 0.9, 5), trunk, tall);
  parts.add(tubeBetween([0, 20, 0], [-5.5, 28, -3], 0.9, 5), trunk, tall);

  // Canopy: overlapping low-poly blobs in three greens (fresh green like the reference).
  const leaves = [lambert(COLORS.leafA), lambert(COLORS.leafB), lambert(COLORS.leafC)];
  const blobs: [number, number, number, number, number][] = [
    // x, y, z, radius, material
    [0, 36, 0, 12, 0],
    [7.5, 30, 3, 8.5, 1],
    [-7, 31, -3.5, 8.5, 1],
    [2, 31, -8, 7.5, 2],
    [-3, 31, 7.5, 7.5, 2],
    [1, 43.5, 1, 6.5, 2],
  ];
  for (const [x, y, z, r, m] of blobs) {
    const g = new THREE.IcosahedronGeometry(r, 1).scale(1, 0.85, 1).translate(x, y, z);
    parts.add(g, leaves[m], { part: 'canopy', occluder: true, castShadow: false });
  }
  // Low shrubs on the soil around the trunk.
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2 + 0.4;
    const r = 11 + (k % 2) * 3;
    parts.add(new THREE.IcosahedronGeometry(2.6 + (k % 3) * 0.5, 0).translate(Math.cos(a) * r, PLANTER_H + 1.2, Math.sin(a) * r), leaves[k % 3], {
      part: 'shrub',
    });
  }
  return parts.build('planterTree');
}

// 5x7 pixel glyphs for the banner text «СТАРТ» (rows top to bottom, '#' = filled).
const GLYPHS: Record<string, string[]> = {
  С: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  Т: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  А: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  Р: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
};

/** Adds `text` as merged pixel boxes on the -Z face of the banner, read by a viewer looking along +Z. */
function addBannerText(parts: PartSet, text: string, material: THREE.MeshLambertMaterial, centreY: number, faceZ: number): void {
  const px = 0.24;
  const cols = text.length * 6 - 1;
  // A viewer looking along +Z has +X on the left, so columns advance toward -X.
  const left = (cols * px) / 2;
  const top = centreY + (7 * px) / 2;
  [...text].forEach((ch, k) => {
    const glyph = GLYPHS[ch];
    if (!glyph) return;
    glyph.forEach((row, r) => {
      // Merge horizontal runs of filled pixels into one box.
      let c = 0;
      while (c < row.length) {
        if (row[c] !== '#') {
          c++;
          continue;
        }
        let end = c;
        while (end < row.length && row[end] === '#') end++;
        const x0 = left - (k * 6 + c) * px;
        const x1 = left - (k * 6 + end) * px;
        parts.add(boxAt(x0 - x1, px, 0.1, (x0 + x1) / 2, top - (r + 0.5) * px, faceZ - 0.05), material, {
          part: 'banner',
          occluder: true,
          castShadow: false,
        });
        c = end;
      }
    });
  });
}

/**
 * Start/finish arch: two posts standing just outside `width` (pass 2 x (barrier + margin)), a coral
 * banner with «СТАРТ» facing the approaching car (-Z side) and checker panels at both ends.
 */
export function createStartArch(width: number): THREE.Group {
  const white = lambert(COLORS.archWhite);
  const coral = lambert(COLORS.archCoral);
  const dark = lambert(COLORS.archDark);
  const parts = new PartSet();
  const half = width / 2;
  const tag = { part: 'arch', occluder: true };
  for (const side of [1, -1]) {
    const x = side * (half + ARCH_POST / 2);
    parts.add(boxAt(ARCH_POST, ARCH_HEIGHT - 0.6, ARCH_POST, x, (ARCH_HEIGHT - 0.6) / 2, 0), white, tag);
    parts.add(boxAt(ARCH_POST + 0.3, 0.6, ARCH_POST, x, ARCH_HEIGHT - 0.3, 0), coral, tag);
    // Coral band around the post; its inner face stays flush with the span.
    parts.add(boxAt(ARCH_POST + 0.02, 1.2, ARCH_POST + 0.02, x + side * 0.01, 3.2, 0), coral, tag);
  }
  const bannerH = BANNER_TOP - BANNER_BOTTOM;
  const bannerY = (BANNER_TOP + BANNER_BOTTOM) / 2;
  parts.add(boxAt(width, bannerH, BANNER_DEPTH, 0, bannerY, 0), coral, { part: 'banner', occluder: true });
  addBannerText(parts, 'СТАРТ', white, bannerY, -BANNER_DEPTH / 2);

  // Checker panels (2 rows) near both ends of the banner, on both faces.
  const sq = bannerH / 2;
  const cols = 6;
  for (const side of [1, -1]) {
    for (const face of [1, -1]) {
      for (let c = 0; c < cols; c++) {
        for (let r = 0; r < 2; r++) {
          const x = side * (half - 1.2 - (c + 0.5) * sq);
          const y = BANNER_BOTTOM + (r + 0.5) * sq;
          const mat = (c + r) % 2 === 0 ? white : dark;
          parts.add(boxAt(sq, sq, 0.08, x, y, face * (BANNER_DEPTH / 2 + 0.04)), mat, { part: 'banner', occluder: true, castShadow: false });
        }
      }
    }
  }
  return parts.build('startArch');
}
