import type { Track } from '../track/build';
import { TUNING, barrierOffset } from '../shared/tuning';
import { loopDelta, wrapLength } from '../shared/math';
import type { Collider, CoinSpot, LightPropSpot, Pose, SurfaceKind } from '../shared/types';

/** Circle of radius R driven left (CCW in the heading sense). s = 0 at (0,0) heading +z. Centre (R, 0). */
export function makeCircleTrack(
  R = 100,
  extras: { coins?: CoinSpot[]; lightProps?: LightPropSpot[]; walls?: Collider[] } = {},
): Track {
  const L = 2 * Math.PI * R;
  const B = barrierOffset();
  const poseAt = (s: number, lat = 0): Pose => {
    const th = wrapLength(s, L) / R;
    const rr = R - lat;
    return { x: R - rr * Math.cos(th), z: rr * Math.sin(th), heading: th };
  };
  const project = (x: number, z: number) => {
    const th = Math.atan2(z, R - x);
    const s = wrapLength(th * R, L);
    return { s, lateral: R - Math.hypot(R - x, z), index: Math.round(s) % Math.round(L) };
  };
  const surfaceAt = (lat: number): SurfaceKind => {
    const a = Math.abs(lat);
    if (a <= TUNING.track.roadHalfWidth) return 'road';
    if (a <= TUNING.track.roadHalfWidth + TUNING.track.curbWidth) return 'curb';
    return a <= B ? 'runoff' : 'outside';
  };
  const markers: number[] = [];
  for (let k = 0; k * TUNING.progress.respawnSpacing < L; k++) markers.push(k * TUNING.progress.respawnSpacing);
  const sampleAt = (s: number) => {
    const p = poseAt(s);
    return { s: wrapLength(s, L), x: p.x, z: p.z, tx: Math.sin(p.heading), tz: Math.cos(p.heading), curvature: 1 / R };
  };
  const walls = extras.walls ?? [];
  return {
    def: undefined as unknown as Track['def'],
    length: L,
    samples: [],
    spacing: 1,
    startS: 0,
    barrier: B,
    project: (x, z) => project(x, z),
    surfaceAt,
    poseAt,
    sampleAt,
    walls,
    heavyColliders: [],
    collidersNear: () => walls,
    coins: extras.coins ?? [],
    lightProps: extras.lightProps ?? [],
    heavyPlacements: [],
    decor: [],
    respawnMarkers: markers,
    spawnPose: poseAt(TUNING.progress.spawnOffset),
    ground: { minX: -500, minZ: -500, maxX: 500, maxZ: 500 },
  };
}

export { loopDelta };
