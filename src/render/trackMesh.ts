/**
 * Track surface meshes (plan Task 11; design spec §2.7 surfaces, §5 ground layers):
 * - road ribbon |lat| <= 7 at y 0.04, dark asphalt with subtle noise in vertex colours;
 * - paint at y 0.06 (polygon offset): coral / white curbs (7..8 m, alternating every 3 m), white dashed
 *   centre line, start/finish checker strip across the road at startS;
 * - runoff tiles (8..12 m) at y 0.02, light grey with darker grout (tiled DataTexture);
 * - low barrier at 12 m (0.9 m tall, white with a coral stripe), left open where a heavy obstacle
 *   stands on the barrier line (the bicycle's front wheel), so the obstacle reads as the wall there.
 * One mesh per material (4 draw calls), static (matrixAutoUpdate false); everything receives shadows,
 * only the barrier casts them.
 */
import * as THREE from 'three';
import type { Track } from '../track/build';
import type { Collider } from '../shared/types';
import { TUNING } from '../shared/tuning';
import { seededRandom } from '../shared/math';
import { createTileTexture } from './groundTextures';

/** Ground layer heights, m (design spec §5). */
export const LAYER_Y = { plaza: 0, runoff: 0.02, road: 0.04, paint: 0.06, skid: 0.07 } as const;
export const BARRIER_HEIGHT = 0.9;
export const BARRIER_THICKNESS = 0.5;

const COLORS = {
  asphalt: 0x5a6068,
  curbCoral: 0xf0806a,
  curbWhite: 0xf6f4f0,
  paint: 0xf4f3ef,
  checkerDark: 0x26272c,
  runoff: 0xe4e2de,
  grout: 0xd2cfca,
  barrierWhite: 0xf5f3ef,
  barrierCoral: 0xf0806a,
};
const CURB_BLOCK = 3;
const DASH_LENGTH = 4;
const DASH_GAP = 5;
const DASH_HALF_WIDTH = 0.18;
const CHECKER_SQUARE = 1;
const CHECKER_ROWS = 3;
/** Road and runoff ribbons tuck this far under the next layer so no gap shows. */
const TUCK = 0.25;
/** Runoff texture repeat length (two 2 m tiles), m. */
const RUNOFF_REPEAT = 4;
/** Barrier stripe band heights, m. */
const STRIPE = [0.34, 0.6] as const;
/** Barrier sections closer than collider radius + this to a heavy collider are left out, m. */
const BARRIER_GAP_MARGIN = 1.2;

type V3 = [number, number, number];

/** Non-indexed triangle soup with per-vertex colours; quads are wound to face `facing`. */
class Soup {
  readonly pos: number[] = [];
  readonly col: number[] = [];
  private readonly c = new THREE.Color();

  quad(a: V3, b: V3, c: V3, d: V3, hex: number, facing: V3): void {
    // Normal of (a, b, c); flip the winding when it points away from `facing`.
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const flip = nx * facing[0] + ny * facing[1] + nz * facing[2] < 0;
    const verts = flip ? [a, c, b, a, d, c] : [a, b, c, a, c, d];
    this.c.setHex(hex);
    for (const v of verts) {
      this.pos.push(v[0], v[1], v[2]);
      this.col.push(this.c.r, this.c.g, this.c.b);
    }
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

const UP: V3 = [0, 1, 0];

/** Point at arc length s, lateral offset `lat`, height y (track frame: left = (tz, -tx)). */
function at(track: Track, s: number, lat: number, y: number): V3 {
  const p = track.poseAt(s, lat);
  return [p.x, y, p.z];
}

/** Smooth 1D value noise in [-1, 1] with lattice spacing 1. */
function valueNoise(rand: () => number, cells: number): (t: number) => number {
  const v = Array.from({ length: cells }, () => rand() * 2 - 1);
  return (t: number) => {
    const i = Math.floor(t);
    const f = t - i;
    const a = v[((i % cells) + cells) % cells];
    const b = v[(((i + 1) % cells) + cells) % cells];
    const u = f * f * (3 - 2 * f);
    return a + (b - a) * u;
  };
}

function roadGeometry(track: Track): THREE.BufferGeometry {
  const lats = [-1, -0.5, 0, 0.5, 1].map((k) => k * (TUNING.track.roadHalfWidth + TUCK));
  const n = track.samples.length;
  const rand = seededRandom(7);
  // Lattice counts that divide the loop exactly, so the noise wraps without a seam at s = 0.
  const coarseCells = Math.max(4, Math.round(track.length / 9));
  const fineCells = Math.max(4, Math.round(track.length / 2.3));
  const coarse = valueNoise(rand, coarseCells);
  const fine = valueNoise(rand, fineCells);
  const base = new THREE.Color(COLORS.asphalt);
  const pos = new Float32Array(n * lats.length * 3);
  const col = new Float32Array(n * lats.length * 3);
  const nor = new Float32Array(n * lats.length * 3);
  track.samples.forEach((sm, i) => {
    lats.forEach((lat, j) => {
      const k = (i * lats.length + j) * 3;
      pos[k] = sm.x + sm.tz * lat;
      pos[k + 1] = LAYER_Y.road;
      pos[k + 2] = sm.z - sm.tx * lat;
      nor[k + 1] = 1;
      const u = sm.s / track.length;
      const f = 1 + 0.05 * coarse(u * coarseCells + j * 3.7) + 0.03 * fine(u * fineCells + j * 11.1);
      col[k] = base.r * f;
      col[k + 1] = base.g * f;
      col[k + 2] = base.b * f;
    });
  });
  const index: number[] = [];
  const w = lats.length;
  for (let i = 0; i < n; i++) {
    const a = i * w;
    const b = ((i + 1) % n) * w;
    for (let j = 0; j < w - 1; j++) {
      // Left of the driving direction is +lat; (a+j, b+j, a+j+1) faces up for this layout.
      index.push(a + j, a + j + 1, b + j, a + j + 1, b + j + 1, b + j);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(index);
  fixWindingUp(g);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** Ensures every triangle of a flat, indexed ground ribbon faces +Y. */
function fixWindingUp(g: THREE.BufferGeometry): void {
  const idx = g.getIndex();
  const p = g.getAttribute('position');
  if (!idx) return;
  for (let t = 0; t < idx.count; t += 3) {
    const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2);
    const ux = p.getX(b) - p.getX(a), uz = p.getZ(b) - p.getZ(a);
    const vx = p.getX(c) - p.getX(a), vz = p.getZ(c) - p.getZ(a);
    // y component of (b - a) x (c - a)
    if (uz * vx - ux * vz < 0) {
      idx.setX(t + 1, c);
      idx.setX(t + 2, b);
    }
  }
}

/** Runoff strips (both sides) with tile UVs measured along each edge so tiles keep their size in curves. */
function runoffGeometry(track: Track): THREE.BufferGeometry {
  const inner = TUNING.track.roadHalfWidth + TUNING.track.curbWidth - TUCK * 2;
  const outer = track.barrier + TUCK;
  const n = track.samples.length;
  const pos: number[] = [];
  const uv: number[] = [];
  const nor: number[] = [];
  const index: number[] = [];
  let base = 0;
  for (const side of [1, -1]) {
    const lats = [inner * side, outer * side];
    // Accumulated edge lengths, rescaled so the loop holds a whole number of repeats.
    const cum = lats.map((lat) => {
      const out = [0];
      for (let i = 1; i <= n; i++) {
        const a = track.samples[i - 1], b = track.samples[i % n];
        const dx = b.x + b.tz * lat - (a.x + a.tz * lat);
        const dz = b.z - b.tx * lat - (a.z - a.tx * lat);
        out.push(out[i - 1] + Math.hypot(dx, dz));
      }
      const total = out[n];
      const scale = Math.max(1, Math.round(total / RUNOFF_REPEAT)) / total;
      return out.map((d) => d * scale);
    });
    for (let i = 0; i <= n; i++) {
      const sm = track.samples[i % n];
      lats.forEach((lat, j) => {
        pos.push(sm.x + sm.tz * lat, LAYER_Y.runoff, sm.z - sm.tx * lat);
        nor.push(0, 1, 0);
        uv.push(cum[j][i], (Math.abs(lat) - (TUNING.track.roadHalfWidth + TUNING.track.curbWidth)) / RUNOFF_REPEAT);
      });
    }
    for (let i = 0; i < n; i++) {
      const a = base + i * 2;
      const b = base + (i + 1) * 2;
      index.push(a, a + 1, b, a + 1, b + 1, b);
    }
    base += (n + 1) * 2;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  fixWindingUp(g);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** Curbs, centre dashes and the start checker: one vertex-coloured soup at the paint layer. */
function paintGeometry(track: Track): THREE.BufferGeometry {
  const soup = new Soup();
  const y = LAYER_Y.paint;
  const L = track.length;
  const r0 = TUNING.track.roadHalfWidth;
  const r1 = r0 + TUNING.track.curbWidth;

  // Curbs: an even number of blocks so colours alternate across the loop seam; 1 m sub-steps follow curves.
  const blocks = 2 * Math.round(L / (2 * CURB_BLOCK));
  const blockLen = L / blocks;
  const sub = Math.max(1, Math.round(blockLen));
  for (let b = 0; b < blocks; b++) {
    const hex = b % 2 === 0 ? COLORS.curbCoral : COLORS.curbWhite;
    for (let k = 0; k < sub; k++) {
      const s0 = (b + k / sub) * blockLen;
      const s1 = (b + (k + 1) / sub) * blockLen;
      for (const side of [1, -1]) {
        soup.quad(at(track, s0, side * r0, y), at(track, s0, side * r1, y), at(track, s1, side * r1, y), at(track, s1, side * r0, y), hex, UP);
      }
    }
  }

  // Centre dashes, skipping the checker strip.
  const checkerHalf = (CHECKER_ROWS * CHECKER_SQUARE) / 2;
  const period = DASH_LENGTH + DASH_GAP;
  for (let s = track.startS + checkerHalf + DASH_GAP / 2; s < track.startS + L - checkerHalf - DASH_LENGTH; s += period) {
    const mid = s + DASH_LENGTH / 2;
    for (const [a, b] of [[s, mid], [mid, s + DASH_LENGTH]]) {
      soup.quad(at(track, a, DASH_HALF_WIDTH, y), at(track, a, -DASH_HALF_WIDTH, y), at(track, b, -DASH_HALF_WIDTH, y), at(track, b, DASH_HALF_WIDTH, y), COLORS.paint, UP);
    }
  }

  // Start/finish checker across the road.
  const cols = Math.round((2 * r0) / CHECKER_SQUARE);
  for (let r = 0; r < CHECKER_ROWS; r++) {
    const s0 = track.startS - checkerHalf + r * CHECKER_SQUARE;
    const s1 = s0 + CHECKER_SQUARE;
    for (let c = 0; c < cols; c++) {
      const l0 = -r0 + c * CHECKER_SQUARE;
      const l1 = l0 + CHECKER_SQUARE;
      const hex = (r + c) % 2 === 0 ? COLORS.paint : COLORS.checkerDark;
      soup.quad(at(track, s0, l0, y), at(track, s0, l1, y), at(track, s1, l1, y), at(track, s1, l0, y), hex, UP);
    }
  }
  return soup.geometry();
}

/** Distance from (x, z) to a heavy collider's centre line (circle centre or capsule segment), minus its radius. */
function clearance(c: Collider, x: number, z: number): number {
  if (c.kind === 'circle') return Math.hypot(x - c.x, z - c.z) - c.r;
  if (c.kind === 'wall') return Infinity;
  const dx = c.bx - c.ax, dz = c.bz - c.az;
  const len2 = dx * dx + dz * dz;
  const u = len2 > 0 ? Math.min(1, Math.max(0, ((x - c.ax) * dx + (z - c.az) * dz) / len2)) : 0;
  return Math.hypot(c.ax + dx * u - x, c.az + dz * u - z) - c.r;
}

/** Barrier walls on both sides: inner face with a coral stripe, top and outer face; gaps at heavy obstacles. */
function barrierGeometry(track: Track): THREE.BufferGeometry {
  const soup = new Soup();
  const n = track.samples.length;
  const step = 2;
  const H = BARRIER_HEIGHT;
  const bands: [number, number, number][] = [
    [0, STRIPE[0], COLORS.barrierWhite],
    [STRIPE[0], STRIPE[1], COLORS.barrierCoral],
    [STRIPE[1], H, COLORS.barrierWhite],
  ];
  for (const side of [1, -1]) {
    const lin = side * track.barrier;
    const lout = side * (track.barrier + BARRIER_THICKNESS);
    const open: boolean[] = [];
    const idx: number[] = [];
    for (let i = 0; i < n; i += step) idx.push(i);
    const point = (i: number, lat: number, y: number): V3 => {
      const sm = track.samples[i % n];
      return [sm.x + sm.tz * lat, y, sm.z - sm.tx * lat];
    };
    idx.forEach((i, k) => {
      const j = k + 1 < idx.length ? idx[k + 1] : n;
      const m = point(Math.round((i + j) / 2), lin, 0);
      open.push(track.heavyColliders.some((c) => clearance(c, m[0], m[2]) < BARRIER_GAP_MARGIN));
    });
    idx.forEach((i, k) => {
      if (open[k]) return;
      const j = k + 1 < idx.length ? idx[k + 1] : n;
      const sm = track.samples[i % n];
      // Facing for the inner face: toward the centreline = -side * left.
      const toTrack: V3 = [-side * sm.tz, 0, side * sm.tx];
      const away: V3 = [-toTrack[0], 0, -toTrack[2]];
      for (const [y0, y1, hex] of bands) {
        soup.quad(point(i, lin, y0), point(j, lin, y0), point(j, lin, y1), point(i, lin, y1), hex, toTrack);
      }
      soup.quad(point(i, lin, H), point(j, lin, H), point(j, lout, H), point(i, lout, H), COLORS.barrierWhite, UP);
      soup.quad(point(i, lout, 0), point(j, lout, 0), point(j, lout, H), point(i, lout, H), COLORS.barrierWhite, away);
      // End caps next to a gap.
      const along: V3 = [sm.tx, 0, sm.tz];
      const back: V3 = [-sm.tx, 0, -sm.tz];
      if (open[(k + 1) % open.length]) soup.quad(point(j, lin, 0), point(j, lout, 0), point(j, lout, H), point(j, lin, H), COLORS.barrierWhite, along);
      if (open[(k - 1 + open.length) % open.length]) soup.quad(point(i, lin, 0), point(i, lout, 0), point(i, lout, H), point(i, lin, H), COLORS.barrierWhite, back);
    });
  }
  return soup.geometry();
}

function staticMesh(name: string, geometry: THREE.BufferGeometry, material: THREE.Material, cast: boolean): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = cast;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

export function createTrackMesh(track: Track): THREE.Group {
  const group = new THREE.Group();
  group.name = 'track';

  const road = new THREE.MeshLambertMaterial({ vertexColors: true });
  road.name = 'track-road';
  const runoffTex = createTileTexture({ size: 128, tiles: 2, base: COLORS.runoff, grout: COLORS.grout, groutPx: 3, variation: 0.025, speckle: 0.015, seed: 11 });
  const runoff = new THREE.MeshLambertMaterial({ map: runoffTex });
  runoff.name = 'track-runoff';
  // Paint sits 2 cm above the asphalt; the polygon offset keeps it on top far away too.
  const paint = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  paint.name = 'track-paint';
  const barrier = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  barrier.name = 'track-barrier';

  group.add(
    staticMesh('track-runoff', runoffGeometry(track), runoff, false),
    staticMesh('track-road', roadGeometry(track), road, false),
    staticMesh('track-paint', paintGeometry(track), paint, false),
    staticMesh('track-barrier', barrierGeometry(track), barrier, true),
  );
  group.matrixAutoUpdate = false;
  group.updateMatrix();
  group.updateMatrixWorld(true);
  return group;
}
