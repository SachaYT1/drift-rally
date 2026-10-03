/**
 * Authoring types for a map. All x/z values in a TrackDef are MAP units (1 = 1 m) as drawn
 * on the top-down mockup (y-down screen axis == world +z). build.ts subtracts `origin`.
 */

/** Visual identifiers. render/catalog.ts maps each to a model or procedural builder. */
export type VisualId =
  | 'officeTower'
  | 'officeBlock'
  | 'person'
  | 'bench'
  | 'lamp'
  | 'tree'
  | 'bush'
  | 'trashBin'
  | 'fountain'
  | 'planterTree'
  | 'bicycle'
  | 'sneaker'
  | 'can'
  | 'cup'
  | 'startArch';

/** Scaled (x12 toy-world) heights in metres, used by track validation (camera keep-out). */
export const VISUAL_HEIGHT: Record<VisualId, number> = {
  officeTower: 300,
  officeBlock: 150,
  person: 20,
  bench: 9.6,
  lamp: 48,
  tree: 60,
  bush: 12,
  trashBin: 12,
  fountain: 18,
  planterTree: 50,
  bicycle: 13,
  sneaker: 1.6,
  can: 1.5,
  cup: 1.8,
  startArch: 12,
};

/**
 * Footprint shapes in OBSTACLE-LOCAL coordinates: +x along the track tangent at the anchor
 * (rotated by the obstacle's extra `yaw`), +z = lateral left. Metres.
 */
export type FootprintShape =
  | { type: 'circle'; x: number; z: number; r: number }
  | { type: 'capsule'; ax: number; az: number; bx: number; bz: number; r: number };

/** Solid obstacle on or at the edge of the road. Hitting it fast burns the drift chain. */
export interface HeavyObstacleDef {
  id: string;
  visual: VisualId;
  /** Anchor arc length along the centreline, m (measured from the curve start, not the start line). */
  s: number;
  /** Anchor lateral offset, m (+ left). */
  lateral: number;
  /** Extra rotation relative to the track tangent, rad. */
  yaw: number;
  footprint: FootprintShape[];
  /** Fade when between camera and car (e.g. the bench seat). */
  occluder?: boolean;
}

/** Light knockable prop: trigger only, -penalty once per lap, resets each lap. */
export interface LightPropDef {
  id: string;
  kind: 'can' | 'cup';
  s: number;
  lateral: number;
}

/** A row of coins along the track starting at `s`, `spacing` metres apart. */
export interface CoinRowDef {
  s: number;
  lateral: number;
  count: number;
  spacing: number;
}

/** Scenery placed in map coordinates. Never collides. */
export interface DecorDef {
  visual: VisualId;
  x: number;
  z: number;
  /** rad */
  yaw: number;
  /** Optional uniform scale on top of the catalog scale. */
  scale?: number;
  /** Tall decor allowed near the track only if tagged as an occluder (fades). */
  occluder?: boolean;
}

export interface TrackDef {
  id: string;
  /** Display name, Russian. */
  name: string;
  /** Map-unit point subtracted from every coordinate so the plaza centre is the world origin. */
  origin: [number, number];
  /** Closed loop, driving order; centripetal Catmull-Rom. */
  controlPoints: [number, number][];
  /** Arc length of the start/finish line from the curve start, m. */
  startS: number;
  heavy: HeavyObstacleDef[];
  light: LightPropDef[];
  coins: CoinRowDef[];
  decor: DecorDef[];
  /** Plaza ground extents in map units: [minX, minZ, maxX, maxZ]. */
  ground: [number, number, number, number];
}
