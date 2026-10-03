/** Small numeric helpers shared by simulation and rendering. All pure. */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  let r = a % TAU;
  if (r <= -Math.PI) r += TAU;
  else if (r > Math.PI) r -= TAU;
  return r;
}

/** Interpolate angles along the shortest arc. */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t;
}

/** Frame-rate independent exponential smoothing factor: 1 - exp(-k * dt). */
export function damp(k: number, dt: number): number {
  return 1 - Math.exp(-k * dt);
}

/** Move `current` toward `target` by at most `maxDelta`. */
export function approach(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/** Wrap a value into [0, length). */
export function wrapLength(s: number, length: number): number {
  const r = s % length;
  return r < 0 ? r + length : r;
}

/** Signed shortest difference b - a on a loop of `length`, in [-length/2, length/2). */
export function loopDelta(a: number, b: number, length: number): number {
  let d = (b - a) % length;
  if (d >= length / 2) d -= length;
  else if (d < -length / 2) d += length;
  return d;
}

/** Deterministic PRNG (mulberry32). Returns a function producing floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function isFiniteNumber(v: number): boolean {
  return Number.isFinite(v);
}
