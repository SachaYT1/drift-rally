import { describe, expect, it } from 'vitest';
import { buildTrack } from './build';
import { PLAZA } from './plaza';
import { TUNING, barrierOffset } from '../shared/tuning';

const track = buildTrack(PLAZA);
const B = barrierOffset();

/** Lateral extent [min, max] of an obstacle's colliders, sampled densely along capsules. */
function lateralExtent(id: string): [number, number] {
  const def = PLAZA.heavy.find((h) => h.id === id);
  if (!def) throw new Error(`missing obstacle ${id}`);
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of track.heavyColliders.filter((k) => k.id.startsWith(id + '#'))) {
    if (c.kind === 'wall') continue;
    const pts = c.kind === 'circle'
      ? [[c.x, c.z]]
      : Array.from({ length: 11 }, (_, i) => [c.ax + ((c.bx - c.ax) * i) / 10, c.az + ((c.bz - c.az) * i) / 10]);
    for (const [x, z] of pts) {
      const lat = track.project(x, z, def.s, 40).lateral;
      lo = Math.min(lo, lat - c.r);
      hi = Math.max(hi, lat + c.r);
    }
  }
  return [lo, hi];
}

describe('plaza map data', () => {
  it('uses unique ids for heavy obstacles, light props and bombs', () => {
    const ids = [...PLAZA.heavy.map((h) => h.id), ...PLAZA.light.map((l) => l.id), ...PLAZA.bombs.map((b) => b.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('authors every s inside one lap', () => {
    const all = [...PLAZA.heavy, ...PLAZA.light, ...PLAZA.bombs, ...PLAZA.coins].map((d) => d.s);
    for (const s of all) expect(s >= 0 && s < track.length).toBe(true);
  });

  it('one bomb in each long drift, off the centreline', () => {
    expect(PLAZA.bombs.map((b) => b.id)).toEqual(['bomb-fountain', 'bomb-bicycle', 'bomb-hairpin', 'bomb-corner']);
    for (const b of PLAZA.bombs) {
      expect(Math.abs(b.lateral)).toBeGreaterThanOrEqual(1.5);
      expect(Math.abs(b.lateral)).toBeLessThanOrEqual(3.5);
    }
  });

  it('bench legs straddle the road at lateral +/-5.5 and the bench fades as an occluder', () => {
    const [lo, hi] = lateralExtent('bench');
    expect(lo).toBeCloseTo(-5.95, 0);
    expect(hi).toBeCloseTo(5.95, 0);
    expect(PLAZA.heavy.find((h) => h.id === 'bench')?.occluder).toBe(true);
  });

  it('bicycle front wheel crosses the right barrier and protrudes onto the road edge', () => {
    // Changed by the final review (bicycle-collider-beyond-tyre): the capsule is fitted to the visible
    // tyre at car height, ~0.8 m onto the road (was ~2 m, the tyre's full ground-plane silhouette, which
    // at car height left the collider up to ~1 m beyond the visible rubber).
    const [lo, hi] = lateralExtent('bicycle');
    expect(lo).toBeLessThanOrEqual(-B);
    expect(hi).toBeGreaterThan(-TUNING.track.roadHalfWidth + 0.4);
    expect(hi).toBeLessThan(-TUNING.track.roadHalfWidth + 1.1);
  });

  it('sneaker lies on the inside of the right-hand kink, reaching ~2.5 m onto the road', () => {
    const def = PLAZA.heavy.find((h) => h.id === 'sneaker');
    expect(track.sampleAt(def?.s ?? NaN).curvature).toBeLessThan(0);
    const [, hi] = lateralExtent('sneaker');
    expect(hi).toBeGreaterThan(-5);
    expect(hi).toBeLessThan(-4);
  });

  it('cans alternate sides along the slalom; cups sit on the outer edge of a left-hand sweeper', () => {
    const cans = PLAZA.light.filter((l) => l.kind === 'can').sort((a, b) => a.s - b.s);
    cans.slice(1).forEach((c, i) => expect(Math.sign(c.lateral)).toBe(-Math.sign(cans[i].lateral)));
    for (const cup of PLAZA.light.filter((l) => l.kind === 'cup')) {
      expect(cup.lateral).toBeLessThan(0);
      expect(track.sampleAt(cup.s).curvature).toBeGreaterThan(0);
    }
  });

  it('start arch spans the start line; all decor lies on the plaza ground', () => {
    const arch = track.decor.find((d) => d.def.visual === 'startArch');
    if (!arch) throw new Error('missing start arch');
    const p = track.project(arch.x, arch.z);
    expect(Math.abs(p.s - PLAZA.startS)).toBeLessThan(1);
    expect(Math.abs(p.lateral)).toBeLessThan(0.5);
    const g = track.ground;
    for (const d of track.decor) {
      expect(d.x > g.minX && d.x < g.maxX && d.z > g.minZ && d.z < g.maxZ).toBe(true);
    }
  });
});
