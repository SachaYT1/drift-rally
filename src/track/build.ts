/** Builds runtime track geometry and queries from a TrackDef. Pure (uses three's math classes only). */
import type {
  Collider,
  CoinSpot,
  LightPropSpot,
  Pose,
  SurfaceKind,
  TrackProjection,
  TrackSample,
} from '../shared/types';
import { TUNING, type Tuning } from '../shared/tuning';
import type { DecorDef, HeavyObstacleDef, TrackDef } from './trackDef';

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
  heavyPlacements: { def: HeavyObstacleDef; pose: Pose }[];
  decor: { def: DecorDef; x: number; z: number }[];
  /** Arc lengths of respawn markers (every progress.respawnSpacing m from startS). */
  respawnMarkers: number[];
  /** Spawn pose: progress.spawnOffset m after the start line, centreline, track heading. */
  spawnPose: Pose;
  /** Plaza ground extents, world coordinates. */
  ground: { minX: number; minZ: number; maxX: number; maxZ: number };
}

export function buildTrack(_def: TrackDef, _t: Tuning = TUNING): Track {
  throw new Error('not implemented');
}
