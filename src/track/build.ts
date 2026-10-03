/** Builds runtime track geometry and queries from a TrackDef. Pure (uses three's math classes only). */
import type {
  BombSpot,
  Collider,
  CoinSpot,
  LightPropSpot,
  Pose,
  SurfaceKind,
  TrackProjection,
  TrackSample,
} from '../shared/types';
import { TUNING, barrierOffset, type Tuning } from '../shared/tuning';
import { wrapAngle, wrapLength } from '../shared/math';
import type { DecorDef, FootprintShape, HeavyObstacleDef, TrackDef } from './trackDef';
import {
  interpolateSample,
  projectOnCentreline,
  sampleCentreline,
  tangentHeading,
  totalTurning,
  type Centreline,
} from './geometry';

/** Target length of one barrier wall segment, m. */
const WALL_SEGMENT = 4;
/** Broad-phase grid cell size, m. */
const GRID_CELL = 16;

export interface Track {
  def: TrackDef;
  /** Loop length, m. */
  length: number;
  /** Evenly spaced centreline samples (~1 m), world coordinates. */
  samples: TrackSample[];
  spacing: number;
  /** Arc length of the start/finish line. */
  startS: number;
  /** Barrier offset from the centreline, m. */
  barrier: number;
  /** Closest centreline point. With `hintS`, searches only +/- `window` m around it. */
  project(x: number, z: number, hintS?: number, window?: number): TrackProjection;
  surfaceAt(lateral: number): SurfaceKind;
  /** World pose at arc length s (wrapped) and lateral offset; heading = track direction. */
  poseAt(s: number, lateral?: number): Pose;
  /** Interpolated centreline sample at arc length s (wrapped). */
  sampleAt(s: number): TrackSample;
  /** One-sided inner and outer barrier walls. */
  walls: Collider[];
  /** World-space heavy obstacle footprints (ids prefixed with the obstacle id). */
  heavyColliders: Collider[];
  /** Walls + heavy colliders whose bounds come within `radius` of (x, z). Uniform-grid backed. */
  collidersNear(x: number, z: number, radius: number): Collider[];
  coins: CoinSpot[];
  lightProps: LightPropSpot[];
  /** Bombs, world positions; r = tuning.bomb.radius. */
  bombs: BombSpot[];
  heavyPlacements: { def: HeavyObstacleDef; pose: Pose }[];
  decor: { def: DecorDef; x: number; z: number }[];
  /** Arc lengths of respawn markers (every progress.respawnSpacing m from startS). */
  respawnMarkers: number[];
  /** Spawn pose: progress.spawnOffset m after the start line, centreline, track heading. */
  spawnPose: Pose;
  /** Plaza ground extents, world coordinates. */
  ground: { minX: number; minZ: number; maxX: number; maxZ: number };
}

type PoseFn = (s: number, lateral?: number) => Pose;

/** Pose on the centreline frame: point offset by `lateral` along l = (tz, -tx), heading = track direction. */
function poseFrom(sample: TrackSample, lateral: number): Pose {
  return {
    x: sample.x + sample.tz * lateral,
    z: sample.z - sample.tx * lateral,
    heading: tangentHeading(sample.tx, sample.tz),
  };
}

/**
 * Offset polylines at +/- barrier, one-sided segments whose normal points toward the centreline.
 * The side on the inside of the loop (left for a counter-clockwise loop) gets the `wall-in-` ids.
 */
function buildWalls(line: Centreline, poseAt: PoseFn, barrier: number): Collider[] {
  const count = Math.max(3, Math.round(line.length / WALL_SEGMENT));
  const step = line.length / count;
  const leftIsInside = totalTurning(line.samples) >= 0;
  const walls: Collider[] = [];
  for (const side of [1, -1] as const) {
    const prefix = (side === 1) === leftIsInside ? 'wall-in-' : 'wall-out-';
    const verts = Array.from({ length: count }, (_, k) => poseAt(k * step, side * barrier));
    verts.forEach((a, k) => {
      const b = verts[(k + 1) % count];
      const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const dx = (b.x - a.x) / len;
      const dz = (b.z - a.z) / len;
      // Left of the segment direction is (dz, -dx); the left wall faces right and vice versa.
      walls.push({ kind: 'wall', id: prefix + k, ax: a.x, az: a.z, bx: b.x, bz: b.z, nx: -side * dz, nz: side * dx });
    });
  }
  return walls;
}

/** Anchor pose (track frame rotated by yaw) and world-space colliders of a heavy obstacle. */
function placeHeavy(def: HeavyObstacleDef, poseAt: PoseFn): { pose: Pose; colliders: Collider[] } {
  const anchor = poseAt(def.s, def.lateral);
  const h = wrapAngle(anchor.heading + def.yaw);
  const fx = Math.sin(h);
  const fz = Math.cos(h);
  // Local +x = forward (fx, fz); local +z = left (fz, -fx).
  const wx = (lx: number, lz: number) => anchor.x + lx * fx + lz * fz;
  const wz = (lx: number, lz: number) => anchor.z + lx * fz - lz * fx;
  const colliders = def.footprint.map((f: FootprintShape, k): Collider => {
    const id = `${def.id}#${k}`;
    if (f.type === 'circle') return { kind: 'circle', id, x: wx(f.x, f.z), z: wz(f.x, f.z), r: f.r };
    return { kind: 'capsule', id, ax: wx(f.ax, f.az), az: wz(f.ax, f.az), bx: wx(f.bx, f.bz), bz: wz(f.bx, f.bz), r: f.r };
  });
  return { pose: { x: anchor.x, z: anchor.z, heading: h }, colliders };
}

interface Bounds {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

function colliderBounds(c: Collider): Bounds {
  if (c.kind === 'circle') return { minX: c.x - c.r, minZ: c.z - c.r, maxX: c.x + c.r, maxZ: c.z + c.r };
  const r = c.kind === 'capsule' ? c.r : 0;
  return {
    minX: Math.min(c.ax, c.bx) - r,
    minZ: Math.min(c.az, c.bz) - r,
    maxX: Math.max(c.ax, c.bx) + r,
    maxZ: Math.max(c.az, c.bz) + r,
  };
}

/** Uniform-grid broad phase. Returns colliders whose AABB is within `radius` of (x, z), in input order. */
function buildColliderGrid(colliders: readonly Collider[]): (x: number, z: number, radius: number) => Collider[] {
  if (colliders.length === 0) return () => [];
  const bounds = colliders.map(colliderBounds);
  const minX = Math.min(...bounds.map((b) => b.minX));
  const minZ = Math.min(...bounds.map((b) => b.minZ));
  const cols = Math.floor((Math.max(...bounds.map((b) => b.maxX)) - minX) / GRID_CELL) + 1;
  const rows = Math.floor((Math.max(...bounds.map((b) => b.maxZ)) - minZ) / GRID_CELL) + 1;
  const col = (x: number) => Math.min(cols - 1, Math.max(0, Math.floor((x - minX) / GRID_CELL)));
  const row = (z: number) => Math.min(rows - 1, Math.max(0, Math.floor((z - minZ) / GRID_CELL)));
  const cells: number[][] = Array.from({ length: cols * rows }, () => []);
  bounds.forEach((b, i) => {
    for (let cz = row(b.minZ); cz <= row(b.maxZ); cz++)
      for (let cx = col(b.minX); cx <= col(b.maxX); cx++) cells[cz * cols + cx].push(i);
  });

  return (x, z, radius) => {
    const found = new Set<number>();
    for (let cz = row(z - radius); cz <= row(z + radius); cz++)
      for (let cx = col(x - radius); cx <= col(x + radius); cx++)
        for (const i of cells[cz * cols + cx]) {
          const b = bounds[i];
          const dx = Math.max(b.minX - x, 0, x - b.maxX);
          const dz = Math.max(b.minZ - z, 0, z - b.maxZ);
          if (dx * dx + dz * dz <= radius * radius) found.add(i);
        }
    return [...found].sort((a, b) => a - b).map((i) => colliders[i]);
  };
}

export function buildTrack(def: TrackDef, t: Tuning = TUNING): Track {
  const [ox, oz] = def.origin;
  const line = sampleCentreline(def.controlPoints.map(([x, z]): [number, number] => [x - ox, z - oz]));
  const { length, spacing, samples } = line;
  const barrier = barrierOffset(t);
  const roadHalf = t.track.roadHalfWidth;
  const curbOuter = roadHalf + t.track.curbWidth;
  const defaultWindow = t.progress.window;

  const sampleAt = (s: number): TrackSample => interpolateSample(line, s);
  const poseAt: PoseFn = (s, lateral = 0) => poseFrom(sampleAt(s), lateral);

  const walls = buildWalls(line, poseAt, barrier);
  const placed = def.heavy.map((h) => ({ def: h, ...placeHeavy(h, poseAt) }));
  const heavyColliders = placed.flatMap((p) => p.colliders);

  const coins: CoinSpot[] = def.coins
    .flatMap((row) => Array.from({ length: row.count }, (_, i) => poseAt(row.s + i * row.spacing, row.lateral)))
    .map((p, id) => ({ id, x: p.x, z: p.z }));

  const lightProps: LightPropSpot[] = def.light.map((l) => {
    const p = poseAt(l.s, l.lateral);
    const r = l.kind === 'can' ? t.pickups.canRadius : t.pickups.cupRadius;
    return { id: l.id, kind: l.kind, x: p.x, z: p.z, r, heading: p.heading };
  });

  const bombs: BombSpot[] = def.bombs.map((b) => {
    const p = poseAt(b.s, b.lateral);
    return { id: b.id, x: p.x, z: p.z, r: t.bomb.radius };
  });

  const markerSpacing = t.progress.respawnSpacing;
  const respawnMarkers = Array.from({ length: Math.ceil(length / markerSpacing) }, (_, k) =>
    wrapLength(def.startS + k * markerSpacing, length),
  );

  const [gx0, gz0, gx1, gz1] = def.ground;

  return {
    def,
    length,
    samples,
    spacing,
    startS: def.startS,
    barrier,
    project: (x, z, hintS, window = defaultWindow) => projectOnCentreline(line, x, z, hintS, window),
    surfaceAt: (lateral) => {
      const a = Math.abs(lateral);
      if (a <= roadHalf) return 'road';
      if (a <= curbOuter) return 'curb';
      if (a <= barrier) return 'runoff';
      return 'outside';
    },
    poseAt,
    sampleAt,
    walls,
    heavyColliders,
    collidersNear: buildColliderGrid([...walls, ...heavyColliders]),
    coins,
    lightProps,
    bombs,
    heavyPlacements: placed.map((p) => ({ def: p.def, pose: p.pose })),
    decor: def.decor.map((d: DecorDef) => ({ def: d, x: d.x - ox, z: d.z - oz })),
    respawnMarkers,
    spawnPose: poseAt(def.startS + t.progress.spawnOffset, 0),
    ground: { minX: gx0 - ox, minZ: gz0 - oz, maxX: gx1 - ox, maxZ: gz1 - oz },
  };
}
