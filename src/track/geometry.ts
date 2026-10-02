/**
 * Centreline geometry for build.ts: sampling a closed centripetal Catmull-Rom loop at ~1 m
 * spacing, interpolation by arc length and closest-point projection. Pure.
 */
import { CatmullRomCurve3, Vector3 } from 'three';
import type { TrackProjection, TrackSample } from '../shared/types';
import { wrapAngle, wrapLength } from '../shared/math';

/** Arc-length table resolution for the curve (three's default of 200 is too coarse for ~1.8 km). */
const ARC_LENGTH_DIVISIONS = 4000;
/** Curvature is measured between the tangents at i - K and i + K to suppress sampling noise. */
const CURVATURE_HALF_WINDOW = 3;
/** Lower bound on the sample count so tiny test loops still have a usable polyline. */
const MIN_SAMPLES = 2 * CURVATURE_HALF_WINDOW + 2;

export interface Centreline {
  length: number;
  spacing: number;
  samples: TrackSample[];
}

/** Heading of a unit tangent: forward = (sin h, cos h), +h turns left. */
export function tangentHeading(tx: number, tz: number): number {
  return Math.atan2(tx, tz);
}

/**
 * Samples the closed loop through `points` (world x, z) at evenly spaced arc lengths.
 * Tangents are central differences; curvature is the signed turning angle across +/- K samples
 * divided by the arc length between them (+ = turning left).
 */
export function sampleCentreline(points: readonly (readonly [number, number])[]): Centreline {
  const curve = new CatmullRomCurve3(
    points.map(([x, z]) => new Vector3(x, 0, z)),
    true,
    'centripetal',
  );
  curve.arcLengthDivisions = ARC_LENGTH_DIVISIONS;
  const length = curve.getLength();
  const n = Math.max(MIN_SAMPLES, Math.round(length));
  const spacing = length / n;
  // getSpacedPoints(n) returns n + 1 points; the last one duplicates the first on a closed loop.
  const pts = curve.getSpacedPoints(n).slice(0, n);

  const tangents = pts.map((_, i) => {
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    const dx = next.x - prev.x;
    const dz = next.z - prev.z;
    const len = Math.hypot(dx, dz) || 1;
    return { tx: dx / len, tz: dz / len };
  });
  const headings = tangents.map((t) => tangentHeading(t.tx, t.tz));
  const K = CURVATURE_HALF_WINDOW;

  const samples = pts.map((p, i): TrackSample => {
    const turn = wrapAngle(headings[(i + K) % n] - headings[(i - K + n) % n]);
    return {
      s: i * spacing,
      x: p.x,
      z: p.z,
      tx: tangents[i].tx,
      tz: tangents[i].tz,
      curvature: turn / (2 * K * spacing),
    };
  });
  return { length, spacing, samples };
}

/** Total signed turning of the loop: about +2*PI when it runs counter-clockwise (left turns dominate). */
export function totalTurning(samples: readonly TrackSample[]): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i];
    const b = samples[(i + 1) % samples.length];
    sum += wrapAngle(tangentHeading(b.tx, b.tz) - tangentHeading(a.tx, a.tz));
  }
  return sum;
}

/** Linearly interpolated centreline sample at arc length s (wrapped), unit tangent. */
export function interpolateSample(line: Centreline, s: number): TrackSample {
  const { samples, spacing, length } = line;
  const n = samples.length;
  // A non-finite s would index past the sample array; fall back to the curve start instead of throwing.
  const sw = Number.isFinite(s) ? wrapLength(s, length) : 0;
  const f = sw / spacing;
  const i0 = Math.floor(f);
  const u = f - i0;
  const a = samples[i0 % n];
  const b = samples[(i0 + 1) % n];
  const tx = a.tx + (b.tx - a.tx) * u;
  const tz = a.tz + (b.tz - a.tz) * u;
  const tl = Math.hypot(tx, tz) || 1;
  return {
    s: sw,
    x: a.x + (b.x - a.x) * u,
    z: a.z + (b.z - a.z) * u,
    tx: tx / tl,
    tz: tz / tl,
    curvature: a.curvature + (b.curvature - a.curvature) * u,
  };
}

/** Index of the sample closest to (x, z) among `count` consecutive indices starting at `from` (wrapped). */
function closestSampleIndex(samples: readonly TrackSample[], x: number, z: number, from: number, count: number): number {
  const n = samples.length;
  let best = 0;
  let bestD = Infinity;
  for (let k = 0; k < count; k++) {
    const i = (((from + k) % n) + n) % n;
    const d = (samples[i].x - x) ** 2 + (samples[i].z - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Parameter in [0, 1] of the closest point on segment a-b to (x, z), and its squared distance. */
function segmentClosest(a: TrackSample, b: TrackSample, x: number, z: number): { u: number; d2: number } {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const raw = len2 > 0 ? ((x - a.x) * dx + (z - a.z) * dz) / len2 : 0;
  const u = raw < 0 ? 0 : raw > 1 ? 1 : raw;
  return { u, d2: (a.x + dx * u - x) ** 2 + (a.z + dz * u - z) ** 2 };
}

/**
 * Closest centreline point to (x, z). Brute force over all samples, or only over samples within
 * +/- `window` m of `hintS` when a hint is given; then refined on the two segments adjacent to the
 * closest sample. lateral = (p - c) . l with l = (tz, -tx).
 */
export function projectOnCentreline(
  line: Centreline,
  x: number,
  z: number,
  hintS: number | undefined,
  window: number,
): TrackProjection {
  const { samples, spacing, length } = line;
  const n = samples.length;
  let index: number;
  if (hintS === undefined || !Number.isFinite(hintS)) {
    index = closestSampleIndex(samples, x, z, 0, n);
  } else {
    const half = Math.ceil(window / spacing);
    const count = Math.min(n, 2 * half + 1);
    index = closestSampleIndex(samples, x, z, Math.round(wrapLength(hintS, length) / spacing) - half, count);
  }
  const prev = (index - 1 + n) % n;
  const next = (index + 1) % n;
  const before = segmentClosest(samples[prev], samples[index], x, z);
  const after = segmentClosest(samples[index], samples[next], x, z);
  const sParam = before.d2 < after.d2 ? (index - 1 + before.u) * spacing : (index + after.u) * spacing;
  const c = interpolateSample(line, sParam);
  return {
    s: c.s,
    lateral: (x - c.x) * c.tz - (z - c.z) * c.tx,
    index,
  };
}
