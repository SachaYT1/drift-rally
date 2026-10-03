import { describe, expect, it } from 'vitest';
import { buildTrack } from './build';
import { PLAZA } from './plaza';
import { VISUAL_HEIGHT, type TrackDef } from './trackDef';
import { TUNING, barrierOffset } from '../shared/tuning';
import { capsuleOverlapsCircle } from '../physics/collision';
import { seededRandom, wrapAngle } from '../shared/math';

const track = buildTrack(PLAZA);
const B = barrierOffset();

function segX(a: number[], b: number[], c: number[], d: number[]): boolean {
  const o = (p: number[], q: number[], r: number[]) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b) && o(a, b, c) !== 0;
}

describe('track build (plaza)', () => {
  it('has the expected length and ~1 m sample spacing', () => {
    expect(track.length).toBeGreaterThan(1700);
    expect(track.length).toBeLessThan(1950);
    expect(Math.abs(track.spacing - 1)).toBeLessThan(0.05);
  });

  it('projects offset points back to (s, lateral)', () => {
    for (let i = 0; i < track.samples.length; i += 37) {
      const sm = track.samples[i];
      const px = sm.x + sm.tz * 3, pz = sm.z - sm.tx * 3; // 3 m to the left
      const g = track.project(px, pz);
      expect(Math.abs(g.lateral - 3)).toBeLessThan(0.25);
      const ds = Math.abs(((g.s - sm.s + track.length * 1.5) % track.length) - track.length / 2);
      expect(ds).toBeLessThan(1.5);
      const h = track.project(px, pz, sm.s, TUNING.progress.window);
      expect(Math.abs(h.lateral - 3)).toBeLessThan(0.25);
    }
  });

  it('classifies surfaces by lateral offset', () => {
    expect(track.surfaceAt(0)).toBe('road');
    expect(track.surfaceAt(-TUNING.track.roadHalfWidth - 0.5)).toBe('curb');
    expect(track.surfaceAt(B - 1)).toBe('runoff');
    expect(track.surfaceAt(-(B + 1))).toBe('outside');
  });

  it('every corner radius is at least minRadius', () => {
    for (const s of track.samples) expect(Math.abs(s.curvature)).toBeLessThanOrEqual(1 / TUNING.track.minRadius);
  });

  it('barrier offset curves do not self-intersect', () => {
    for (const side of [1, -1]) {
      const pts = track.samples.filter((_, i) => i % 2 === 0).map((s) => [s.x + side * s.tz * B, s.z - side * s.tx * B]);
      let crossings = 0;
      for (let i = 0; i < pts.length; i++)
        for (let j = i + 2; j < pts.length; j++) {
          if (i === 0 && j === pts.length - 1) continue;
          if (segX(pts[i], pts[(i + 1) % pts.length], pts[j], pts[(j + 1) % pts.length])) crossings++;
        }
      expect(crossings).toBe(0);
    }
  });

  it('separate legs of the track keep a gap wider than both barriers', () => {
    const S = track.samples;
    let min = Infinity;
    for (let i = 0; i < S.length; i += 3)
      for (let j = i + 3; j < S.length; j += 3) {
        const along = Math.min(j - i, S.length - (j - i));
        if (along < 80) continue;
        min = Math.min(min, Math.hypot(S[i].x - S[j].x, S[i].z - S[j].z));
      }
    expect(min).toBeGreaterThan(2 * B + 6);
  });

  it('walls face the track', () => {
    for (const w of track.walls) {
      if (w.kind !== 'wall') continue;
      const mx = (w.ax + w.bx) / 2, mz = (w.az + w.bz) / 2;
      const p = track.project(mx, mz);
      const c = track.poseAt(p.s, 0);
      expect((c.x - mx) * w.nx + (c.z - mz) * w.nz).toBeGreaterThan(0);
    }
  });

  it('coins and light props lie on the road; coin count is 26-36', () => {
    expect(track.coins.length).toBeGreaterThanOrEqual(26);
    expect(track.coins.length).toBeLessThanOrEqual(36);
    for (const c of track.coins) expect(Math.abs(track.project(c.x, c.z).lateral)).toBeLessThanOrEqual(TUNING.track.roadHalfWidth);
    expect(track.lightProps.filter((p) => p.kind === 'can').length).toBeGreaterThanOrEqual(6);
    expect(track.lightProps.filter((p) => p.kind === 'cup').length).toBeGreaterThanOrEqual(3);
    for (const p of track.lightProps) expect(Math.abs(track.project(p.x, p.z).lateral)).toBeLessThanOrEqual(TUNING.track.roadHalfWidth);
  });

  it('heavy obstacles leave a free corridor and no car-trapping wedges', () => {
    const carW = TUNING.car.width;
    for (const { def } of track.heavyPlacements) {
      const blocked: [number, number][] = [];
      for (const c of track.heavyColliders.filter((k) => k.id.startsWith(def.id + '#'))) {
        const pts = c.kind === 'circle' ? [[c.x, c.z, c.r]] : c.kind === 'capsule' ? [[c.ax, c.az, c.r], [c.bx, c.bz, c.r], [(c.ax + c.bx) / 2, (c.az + c.bz) / 2, c.r]] : [];
        for (const [x, z, r] of pts) {
          const lat = track.project(x, z, def.s, 40).lateral;
          blocked.push([lat - r, lat + r]);
        }
      }
      blocked.sort((a, b) => a[0] - b[0]);
      const H = TUNING.track.roadHalfWidth;
      let cursor = -B, widest = 0;
      for (const [lo, hi] of blocked) {
        const gap = Math.max(-B, lo) - cursor;
        if (gap > 0) {
          widest = Math.max(widest, Math.min(lo, H) - Math.max(cursor, -H));
          expect(gap === 0 || gap >= carW + 1).toBe(true);
        }
        cursor = Math.max(cursor, hi);
      }
      widest = Math.max(widest, H - Math.max(cursor, -H));
      expect(widest).toBeGreaterThanOrEqual(TUNING.track.minFreeWidth);
    }
  });

  it('bombs sit on the road with a free passage, clear of pickups, obstacles and respawn poses', () => {
    const H = TUNING.track.roadHalfWidth;
    const CLEAR = 5;
    const poses = [track.spawnPose, ...track.respawnMarkers.map((s) => track.poseAt(s, 0))];
    expect(track.bombs).toHaveLength(4);
    for (const b of track.bombs) {
      const lat = track.project(b.x, b.z).lateral;
      expect(Math.abs(lat) + b.r).toBeLessThanOrEqual(H);
      expect(Math.max(H - (lat + b.r), lat - b.r + H)).toBeGreaterThanOrEqual(TUNING.track.minFreeWidth);
      const gap = (x: number, z: number, r: number) => Math.hypot(x - b.x, z - b.z) - r - b.r;
      for (const c of track.coins) expect(gap(c.x, c.z, TUNING.pickups.coinRadius)).toBeGreaterThanOrEqual(CLEAR);
      for (const p of track.lightProps) expect(gap(p.x, p.z, p.r)).toBeGreaterThanOrEqual(CLEAR);
      for (const c of track.heavyColliders) {
        if (c.kind === 'wall') continue;
        const seg = c.kind === 'circle' ? { ax: c.x, az: c.z, bx: c.x, bz: c.z } : c;
        const inflated = { ax: seg.ax, az: seg.az, bx: seg.bx, bz: seg.bz, r: c.r + CLEAR };
        expect(capsuleOverlapsCircle(inflated, b.x, b.z, b.r)).toBe(false);
      }
      for (const p of poses) {
        const ox = Math.sin(p.heading) * TUNING.car.capsuleHalf;
        const oz = Math.cos(p.heading) * TUNING.car.capsuleHalf;
        const cap = { ax: p.x + ox, az: p.z + oz, bx: p.x - ox, bz: p.z - oz, r: TUNING.car.radius };
        expect(capsuleOverlapsCircle(cap, b.x, b.z, b.r)).toBe(false);
      }
    }
  });

  it('tall decor keeps out of the camera corridor unless tagged as an occluder', () => {
    for (const d of track.decor) {
      if (VISUAL_HEIGHT[d.def.visual] <= TUNING.track.tallDecorHeight || d.def.occluder) continue;
      const p = track.project(d.x, d.z);
      expect(Math.abs(p.lateral)).toBeGreaterThanOrEqual(TUNING.track.tallDecorKeepOut);
    }
  });

  it('spawn pose and every respawn marker are collision-free and face the track', () => {
    const poses = [track.spawnPose, ...track.respawnMarkers.map((s) => track.poseAt(s, 0))];
    for (const p of poses) {
      const near = track.collidersNear(p.x, p.z, 6);
      for (const c of near) {
        if (c.kind === 'circle') {
          const cap = { ax: p.x + Math.sin(p.heading) * 1.05, az: p.z + Math.cos(p.heading) * 1.05, bx: p.x - Math.sin(p.heading) * 1.05, bz: p.z - Math.cos(p.heading) * 1.05, r: TUNING.car.radius };
          expect(capsuleOverlapsCircle(cap, c.x, c.z, c.r)).toBe(false);
        }
      }
    }
    expect(track.respawnMarkers.length).toBe(Math.ceil(track.length / TUNING.progress.respawnSpacing));
  });

  it('collidersNear returns a superset of brute-force nearby colliders', () => {
    const rnd = seededRandom(7);
    const all = [...track.walls, ...track.heavyColliders];
    for (let k = 0; k < 200; k++) {
      const sm = track.samples[Math.floor(rnd() * track.samples.length)];
      const x = sm.x + (rnd() * 2 - 1) * 14, z = sm.z + (rnd() * 2 - 1) * 14;
      const got = new Set(track.collidersNear(x, z, 4).map((c) => c.id));
      for (const c of all) {
        const cx = c.kind === 'circle' ? c.x : (c.ax + c.bx) / 2;
        const cz = c.kind === 'circle' ? c.z : (c.az + c.bz) / 2;
        const half = c.kind === 'circle' ? c.r : Math.hypot(c.bx - c.ax, c.bz - c.az) / 2 + (c.kind === 'capsule' ? c.r : 0);
        if (Math.hypot(cx - x, cz - z) + 1e-6 < 4 - half) expect(got.has(c.id)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Additional edge cases on a synthetic loop (not from the plan).
// ---------------------------------------------------------------------------

const R = 100;
/** Counter-clockwise (left-turning) circle of radius R around map (200, 200), 24 control points. */
const CIRCLE: TrackDef = {
  id: 'circle',
  name: 'Круг',
  origin: [200, 200],
  controlPoints: Array.from({ length: 24 }, (_, i): [number, number] => {
    const a = (i / 24) * Math.PI * 2;
    return [200 + R * Math.cos(a), 200 - R * Math.sin(a)];
  }),
  startS: 20,
  heavy: [
    {
      id: 'probe',
      visual: 'sneaker',
      s: 100,
      lateral: 0,
      yaw: 0,
      footprint: [
        { type: 'circle', x: 2, z: 0, r: 0.5 },
        { type: 'circle', x: 0, z: 3, r: 0.5 },
      ],
    },
    { id: 'turned', visual: 'sneaker', s: 300, lateral: 0, yaw: Math.PI / 2, footprint: [{ type: 'capsule', ax: 2, az: 0, bx: 4, bz: 0, r: 1 }] },
  ],
  light: [
    { id: 'c', kind: 'can', s: 50, lateral: 2 },
    { id: 'u', kind: 'cup', s: 60, lateral: -2 },
  ],
  bombs: [{ id: 'b', s: 150, lateral: 1.5 }],
  coins: [
    { s: 10, lateral: 1, count: 3, spacing: 5 },
    { s: 200, lateral: -1, count: 2, spacing: 4 },
  ],
  decor: [{ visual: 'tree', x: 200, z: 200, yaw: 0 }],
  ground: [0, 10, 400, 390],
};

describe('track build (synthetic circle)', () => {
  const circle = buildTrack(CIRCLE);
  const near = (a: number, b: number, eps: number) => expect(Math.abs(a - b)).toBeLessThan(eps);

  it('measures a circle: length, positive (left) curvature 1/R', () => {
    near(circle.length, 2 * Math.PI * R, 2);
    for (const s of circle.samples) near(s.curvature, 1 / R, 0.0015);
  });

  it('poseAt and sampleAt wrap s and offset lateral to the left', () => {
    const a = circle.poseAt(37.5, 2);
    const b = circle.poseAt(37.5 + circle.length, 2);
    const c = circle.poseAt(37.5 - circle.length, 2);
    near(a.x, b.x, 1e-6);
    near(a.z, c.z, 1e-6);
    for (const wrapped of [b, c]) {
      near(wrapped.x, a.x, 1e-6);
      near(wrapped.z, a.z, 1e-6);
      near(wrapAngle(wrapped.heading - a.heading), 0, 1e-9);
    }
    expect(circle.sampleAt(-5).s).toBeCloseTo(circle.length - 5, 6);
    // Left of a counter-clockwise circle is toward its centre (world origin).
    near(Math.hypot(circle.poseAt(80, 4).x, circle.poseAt(80, 4).z), R - 4, 0.1);
    const p = circle.project(a.x, a.z);
    near(p.lateral, 2, 0.05);
    near(p.s, 37.5, 0.2);
  });

  it('projects across the wrap seam with a hint and stays inside the window', () => {
    const q = circle.poseAt(2, -3);
    const p = circle.project(q.x, q.z, circle.length - 4, 30);
    near(p.s, 2, 0.2);
    near(p.lateral, -3, 0.05);
    // A point far outside the window resolves to the window edge (plus at most one refinement segment).
    const far = circle.poseAt(300, 0);
    const w = circle.project(far.x, far.z, 100, 20);
    expect(Math.abs(w.s - 100)).toBeLessThanOrEqual(20 + 2 * circle.spacing);
    expect(Math.abs(w.s - 100)).toBeGreaterThan(18);
  });

  it('falls back to the global search when the window covers the whole loop or is NaN', () => {
    const q = circle.poseAt(300, 2);
    const global = circle.project(q.x, q.z);
    near(global.s, 300, 0.2);
    for (const window of [Infinity, circle.length / 2, circle.length, Number.NaN]) {
      expect(circle.project(q.x, q.z, 100, window)).toEqual(global);
    }
    // A negative window degenerates to the sample nearest the hint instead of misreporting index 0.
    const tight = circle.project(q.x, q.z, 100, -5);
    near(tight.s, 100, 2 * circle.spacing);
  });

  it('classifies exact surface boundaries symmetrically', () => {
    const H = TUNING.track.roadHalfWidth;
    const C = H + TUNING.track.curbWidth;
    for (const sign of [1, -1]) {
      expect(circle.surfaceAt(sign * H)).toBe('road');
      expect(circle.surfaceAt(sign * (H + 0.01))).toBe('curb');
      expect(circle.surfaceAt(sign * C)).toBe('curb');
      expect(circle.surfaceAt(sign * B)).toBe('runoff');
      expect(circle.surfaceAt(sign * (B + 0.01))).toBe('outside');
    }
  });

  it('maps obstacle-local footprints: +x along the tangent, +z to the left, rotated by yaw', () => {
    const anchor = circle.poseAt(100, 0);
    const [ahead, left] = circle.heavyColliders.filter((c) => c.id.startsWith('probe#'));
    expect(ahead.id).toBe('probe#0');
    if (ahead.kind !== 'circle' || left.kind !== 'circle') throw new Error('expected circles');
    near(ahead.x, anchor.x + Math.sin(anchor.heading) * 2, 1e-9);
    near(ahead.z, anchor.z + Math.cos(anchor.heading) * 2, 1e-9);
    near(circle.project(left.x, left.z, 100, 10).lateral, 3, 0.05);
    const turned = circle.heavyColliders.find((c) => c.id === 'turned#0');
    if (turned?.kind !== 'capsule') throw new Error('expected a capsule');
    // yaw = +90 deg turns local +x to the left: the capsule points away from the centreline.
    near(circle.project(turned.ax, turned.az, 300, 10).lateral, 2, 0.1);
    near(circle.project(turned.bx, turned.bz, 300, 10).lateral, 4, 0.1);
    const placed = circle.heavyPlacements.find((h) => h.def.id === 'turned');
    near(wrapAngle((placed?.pose.heading ?? NaN) - circle.poseAt(300).heading), Math.PI / 2, 1e-9);
  });

  it('places coins, light props, markers, spawn, decor and ground from the def', () => {
    expect(circle.coins.map((c) => c.id)).toEqual([0, 1, 2, 3, 4]);
    const c4 = circle.poseAt(204, -1);
    near(circle.coins[4].x, c4.x, 1e-9);
    near(circle.coins[4].z, c4.z, 1e-9);
    expect(circle.lightProps.map((p) => [p.id, p.r])).toEqual([
      ['c', TUNING.pickups.canRadius],
      ['u', TUNING.pickups.cupRadius],
    ]);
    const spacing = TUNING.progress.respawnSpacing;
    expect(circle.respawnMarkers[0]).toBe(CIRCLE.startS);
    expect(circle.respawnMarkers[1]).toBeCloseTo(CIRCLE.startS + spacing, 9);
    for (const m of circle.respawnMarkers) expect(m >= 0 && m < circle.length).toBe(true);
    const spawn = circle.poseAt(CIRCLE.startS + TUNING.progress.spawnOffset);
    expect(circle.spawnPose).toEqual(spawn);
    expect(circle.decor[0]).toMatchObject({ x: 0, z: 0 });
    expect(circle.ground).toEqual({ minX: -200, minZ: -190, maxX: 200, maxZ: 190 });
  });

  it('places bombs at (s, lateral) with the tuning radius', () => {
    const p = circle.poseAt(150, 1.5);
    expect(circle.bombs).toEqual([{ id: 'b', x: p.x, z: p.z, r: TUNING.bomb.radius }]);
  });

  it('builds closed inner (left) and outer barrier polylines at the barrier offset', () => {
    const inner = circle.walls.filter((w) => w.id.startsWith('wall-in-'));
    const outer = circle.walls.filter((w) => w.id.startsWith('wall-out-'));
    expect(inner.length).toBe(outer.length);
    expect(inner.length + outer.length).toBe(circle.walls.length);
    for (const w of inner) if (w.kind === 'wall') near(Math.hypot(w.ax, w.az), R - B, 0.5);
    for (const w of outer) if (w.kind === 'wall') near(Math.hypot(w.ax, w.az), R + B, 0.5);
    expect(new Set(circle.walls.map((w) => w.id)).size).toBe(circle.walls.length);
  });

  it('honours a custom tuning and never mutates the def', () => {
    const before = JSON.stringify(CIRCLE);
    const t = { ...TUNING, track: { ...TUNING.track, roadHalfWidth: 5 } };
    const narrow = buildTrack(CIRCLE, t);
    expect(narrow.barrier).toBe(barrierOffset(t));
    expect(narrow.surfaceAt(5.5)).toBe('curb');
    expect(JSON.stringify(CIRCLE)).toBe(before);
  });

  it('collidersNear: empty far away, ordered walls-first near the barrier', () => {
    expect(circle.collidersNear(1000, 1000, 5)).toEqual([]);
    const w = circle.poseAt(100, B);
    const got = circle.collidersNear(w.x, w.z, 3);
    expect(got.length).toBeGreaterThan(0);
    expect(got[0].kind).toBe('wall');
  });
});
