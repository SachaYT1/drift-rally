/**
 * Procedural zone-3 bicycle and zone-7 sneaker (re-exported by procedural.ts).
 *
 * Both are built facing +Z with +X on their left, origin at ground centre, and must match the collider
 * footprints in track/plaza.ts (footprint local (x, z) = model (Z, X)):
 * - Bicycle: anchor = bike centre, hubs at Z = +/-6.3; the collider capsule (x 3.65..8.95, r 1.4)
 *   is the ground line of the FAT front tyre (outer r 4.2, 2.6 m wide), so the visible tyre is what the
 *   car hits. Chunky toy BMX with a coral frame and mag wheels.
 * - Sneaker: inside its capsule (x -2..2, r 1): 6 m long, 2 m wide, 1.6 m tall, toe toward +Z.
 */
import * as THREE from 'three';
import { PartSet, boxAt, discX, lambert, ringX, tubeBetween, type Vec3 } from './proceduralKit';

// ---- Bicycle dimensions (toy-world metres) ----
const HUB_Z = 6.3;
const WHEEL_R = 4.2;
const TYRE_RADIAL = 0.95;
const TYRE_HALF_WIDTH = 1.3;
const RIM_R = WHEEL_R - 2 * TYRE_RADIAL;
/** Fork legs and stays straddle the fat tyres. */
const STRADDLE = TYRE_HALF_WIDTH + 0.3;
const GRIP_END = 4.2;

/** Part tags: only the tyres and the frame are looked up by name; the rest merge per material. */
const METAL = { part: 'metal' };
const HARDWARE = { part: 'hardware' };

const BIKE_COLORS = {
  frame: 0xf07158,
  tyre: 0x34353b,
  rim: 0xdfe2e8,
  dark: 0x2a2b31,
  seat: 0x2f3036,
};

/** Mag wheel (rim ring, hub, five spokes) plus the tyre tagged `tyreTag`. */
function addWheel(parts: PartSet, z: number, tyreTag: string, mats: Record<keyof typeof BIKE_COLORS, THREE.MeshLambertMaterial>): void {
  const y = WHEEL_R;
  parts.add(ringX(WHEEL_R - TYRE_RADIAL, TYRE_RADIAL, TYRE_HALF_WIDTH, 28, 12, 0, y, z), mats.tyre, { part: tyreTag });
  parts.add(ringX(RIM_R - 0.15, 0.3, 0.55, 28, 6, 0, y, z), mats.rim, METAL);
  parts.add(discX(0.75, 1.9, 10, 0, y, z), mats.rim, METAL);
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + 0.3;
    const r0 = 0.6;
    const r1 = RIM_R - 0.2;
    parts.add(
      tubeBetween([0, y + Math.sin(a) * r0, z + Math.cos(a) * r0], [0, y + Math.sin(a) * r1, z + Math.cos(a) * r1], 0.28, 5),
      mats.rim,
      METAL,
    );
  }
}

export function createBicycle(): THREE.Group {
  const mats = {
    frame: lambert(BIKE_COLORS.frame),
    tyre: lambert(BIKE_COLORS.tyre),
    rim: lambert(BIKE_COLORS.rim),
    dark: lambert(BIKE_COLORS.dark),
    seat: lambert(BIKE_COLORS.seat),
  };
  const parts = new PartSet();
  addWheel(parts, HUB_Z, 'frontTyre', mats);
  addWheel(parts, -HUB_Z, 'rearTyre', mats);

  const y = WHEEL_R;
  const bb: Vec3 = [0, 3.7, -2.0];
  const seatTop: Vec3 = [0, 8.7, -3.3];
  const headTop: Vec3 = [0, 9.9, 3.7];
  const headBottom: Vec3 = [0, 7.7, 4.5];
  const frame = { part: 'frame' };
  // Main triangle and head tube.
  parts.add(tubeBetween(bb, seatTop, 0.42, 8), mats.frame, frame);
  parts.add(tubeBetween([0, 8.4, -3.2], [0, 9.4, 3.9], 0.42, 8), mats.frame, frame);
  parts.add(tubeBetween(bb, [0, 7.9, 4.4], 0.46, 8), mats.frame, frame);
  parts.add(tubeBetween(headBottom, headTop, 0.55, 8), mats.frame, frame);
  // Stays and fork straddle the tyres.
  for (const side of [1, -1]) {
    const sx = side * STRADDLE;
    parts.add(tubeBetween([side * 0.35, 3.7, -2.0], [sx, y, -HUB_Z], 0.3, 6), mats.frame, frame);
    parts.add(tubeBetween([side * 0.35, 8.3, -3.25], [sx, y, -HUB_Z], 0.3, 6), mats.frame, frame);
    parts.add(tubeBetween([side * 0.45, 7.8, 4.45], [sx, y, HUB_Z], 0.34, 6), mats.frame, frame);
    // Axle nuts.
    parts.add(discX(0.45, 0.4, 8, sx + side * 0.2, y, HUB_Z), mats.dark, HARDWARE);
    parts.add(discX(0.45, 0.4, 8, sx + side * 0.2, y, -HUB_Z), mats.dark, HARDWARE);
  }
  parts.add(boxAt(2 * STRADDLE + 0.3, 0.45, 0.9, 0, 7.75, 4.5), mats.frame, frame); // fork crown

  // Seat post and saddle.
  parts.add(tubeBetween(seatTop, [0, 10.1, -3.75], 0.32, 6), mats.rim, METAL);
  parts.add(boxAt(1.5, 0.7, 3.4, 0, 10.4, -3.7, 0.12), mats.seat, HARDWARE);

  // Stem, BMX riser bars with a crossbar, and fat grips.
  parts.add(tubeBetween(headTop, [0, 10.7, 3.4], 0.4, 6), mats.dark, HARDWARE);
  parts.add(boxAt(2.4, 0.6, 1.1, 0, 10.75, 3.4), mats.dark, HARDWARE);
  for (const side of [1, -1]) {
    parts.add(tubeBetween([side * 0.9, 10.75, 3.4], [side * 2.2, 12.55, 2.8], 0.26, 6), mats.dark, HARDWARE);
    parts.add(discX(0.45, 1.6, 8, side * (GRIP_END - 0.8), 12.55, 2.8), mats.seat, HARDWARE);
  }
  parts.add(tubeBetween([-2.2, 12.55, 2.8], [2.2, 12.55, 2.8], 0.24, 6), mats.dark, HARDWARE);
  parts.add(tubeBetween([-1.4, 11.6, 3.15], [1.4, 11.6, 3.15], 0.2, 6), mats.dark, HARDWARE);

  // Bottom-bracket shell, chainring and chain outside the fat rear tyre (right side = -X), cranks,
  // pedals, and a kickstand on the left.
  const chainX = -(STRADDLE + 0.3);
  parts.add(discX(0.5, 2 * STRADDLE, 8, 0, bb[1], bb[2]), mats.dark, HARDWARE);
  parts.add(discX(1.35, 0.25, 12, chainX, bb[1], bb[2]), mats.rim, METAL);
  parts.add(discX(0.6, 0.25, 8, chainX, y, -HUB_Z), mats.rim, METAL);
  parts.add(tubeBetween([chainX, bb[1] + 1.3, bb[2]], [chainX, y + 0.58, -HUB_Z], 0.11, 4), mats.dark, HARDWARE);
  parts.add(tubeBetween([chainX, bb[1] - 1.3, bb[2]], [chainX, y - 0.58, -HUB_Z], 0.11, 4), mats.dark, HARDWARE);
  const crank = 1.9;
  for (const side of [1, -1]) {
    const a = side > 0 ? 0.9 : 0.9 + Math.PI;
    const px = side * (STRADDLE + 0.55);
    const end: Vec3 = [px, bb[1] - Math.cos(a) * crank, bb[2] + Math.sin(a) * crank];
    parts.add(tubeBetween([px, bb[1], bb[2]], end, 0.22, 5), mats.dark, HARDWARE);
    parts.add(boxAt(1.2, 0.35, 1.0, px + side * 0.6, end[1], end[2]), mats.seat, HARDWARE);
  }
  parts.add(tubeBetween([0.5, 3.5, -2.6], [2.0, 0.24, -3.6], 0.17, 5), mats.dark, HARDWARE);

  return parts.build('bicycle');
}

// ---- Sneaker ----
const SNEAKER_SOLE = 0.5;
/** z shrink of the loft's top ring (keeps the toe and heel rounded). */
const TOP_Z_SCALE = 1 - (1 - 0.52) * 0.35;
const SNEAKER_COLORS = { sole: 0xf6f3ee, upper: 0x4b79d8, lace: 0xffffff, collar: 0x223155, stripe: 0xf07158 };

/** Half-width of the shoe outline at z (heel -3 .. toe +3); fits the r 1 capsule around z -2..2. */
function shoeHalfWidth(z: number): number {
  if (z >= 2) return Math.sqrt(Math.max(0, 1 - (z - 2) ** 2));
  if (z >= 0.5) return 1;
  if (z >= -1.8) return 0.86 + ((z + 1.8) / 2.3) * 0.14;
  if (z >= -2.15) return 0.86;
  return Math.sqrt(Math.max(0, 0.86 ** 2 - (z + 2.15) ** 2));
}

/** Height of the upper above the sole at z: tall heel, collar dip, tongue, sloping toe. */
function upperHeight(z: number): number {
  const keys: [number, number][] = [[-3, 0.9], [-2.6, 1.1], [-1.9, 1.02], [-1.3, 0.82], [-0.7, 0.95], [0.6, 0.72], [2.0, 0.48], [3, 0.3]];
  for (let i = 1; i < keys.length; i++) {
    if (z <= keys[i][0]) {
      const [z0, h0] = keys[i - 1];
      const [z1, h1] = keys[i];
      return h0 + ((z - z0) / (z1 - z0)) * (h1 - h0);
    }
  }
  return keys[keys.length - 1][1];
}

/** Outline points (x, z) around the shoe, counter-clockwise seen from above. */
function shoeOutline(segments: number): [number, number][] {
  const right: [number, number][] = [];
  const left: [number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    // Cosine spacing packs points at the rounded heel and toe.
    const z = -3 + (1 - Math.cos((i / segments) * Math.PI)) * 3;
    const w = shoeHalfWidth(z);
    right.push([-w, z]);
    left.push([w, z]);
  }
  return [...right, ...left.reverse().slice(1, -1)];
}

/** Lofted upper: rings of the outline shrinking toward the top, heights following upperHeight(z). */
function upperGeometry(outline: [number, number][]): THREE.BufferGeometry {
  const rings: [number, number][] = [[0.94, 0], [0.92, 0.55], [0.8, 0.88], [0.52, 1]];
  const zScale = (s: number) => 1 - (1 - s) * 0.35;
  const pos: number[] = [];
  const at = (k: number, i: number): Vec3 => {
    const [s, t] = rings[k];
    const [x, z] = outline[i % outline.length];
    return [x * s, SNEAKER_SOLE + t * upperHeight(z), z * zScale(s)];
  };
  const tri = (a: Vec3, b: Vec3, c: Vec3) => pos.push(...a, ...b, ...c);
  const n = outline.length;
  for (let k = 0; k < rings.length - 1; k++) {
    for (let i = 0; i < n; i++) {
      const a = at(k, i), b = at(k, i + 1), c = at(k + 1, i + 1), d = at(k + 1, i);
      tri(a, b, c);
      tri(a, c, d);
    }
  }
  // Top: strips across the shoe between mirrored outline points (right side i <-> left side n - i).
  const last = rings.length - 1;
  const half = n / 2;
  for (let i = 0; i < half; i++) {
    const a = at(last, i), b = at(last, i + 1), c = at(last, (n - i - 1) % n), d = at(last, (n - i) % n);
    if (i < half - 1) tri(a, b, c);
    if (i > 0) tri(a, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

export function createSneaker(): THREE.Group {
  const mats = {
    sole: lambert(SNEAKER_COLORS.sole),
    upper: lambert(SNEAKER_COLORS.upper),
    lace: lambert(SNEAKER_COLORS.lace),
    collar: lambert(SNEAKER_COLORS.collar),
    stripe: lambert(SNEAKER_COLORS.stripe),
  };
  const parts = new PartSet();
  const outline = shoeOutline(16);

  // Sole: the outline extruded straight up (extrusion runs along +Z, so build in (x, -z) and tip it).
  const shape = new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x, -z)));
  const sole = new THREE.ExtrudeGeometry(shape, { depth: SNEAKER_SOLE, bevelEnabled: false });
  sole.rotateX(-Math.PI / 2);
  parts.add(sole, mats.sole, { part: 'sole' });
  parts.add(upperGeometry(outline), mats.upper, { part: 'upper' });

  // Collar opening, laces across the tongue, and a coral side stripe. The top ring of the loft is
  // shrunk along z by TOP_Z_SCALE, so the surface height above model z is upperHeight(z / TOP_Z_SCALE).
  const topY = (z: number) => SNEAKER_SOLE + upperHeight(z / TOP_Z_SCALE);
  const collarZ = -1.75;
  parts.add(new THREE.CylinderGeometry(0.42, 0.42, 0.12, 10).scale(1, 1, 1.4).translate(0, topY(collarZ) - 0.03, collarZ), mats.collar, { part: 'collar' });
  for (const z of [-0.6, 0.0, 0.6, 1.2]) {
    const slope = Math.atan2(topY(z + 0.1) - topY(z - 0.1), 0.2);
    parts.add(boxAt(0.9, 0.12, 0.22, 0, topY(z) + 0.02, z, -slope), mats.lace, { part: 'laces' });
  }
  for (const side of [1, -1]) {
    const z0 = -2.0;
    const z1 = 1.0;
    const a: Vec3 = [side * 0.95 * shoeHalfWidth(z0), SNEAKER_SOLE + 0.55 * upperHeight(z0), z0];
    const b: Vec3 = [side * 0.95 * shoeHalfWidth(z1), SNEAKER_SOLE + 0.4 * upperHeight(z1), z1];
    parts.add(tubeBetween(a, b, 0.1, 4), mats.stripe, { part: 'stripe' });
  }
  return parts.build('sneaker');
}
