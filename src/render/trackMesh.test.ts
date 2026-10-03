import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BARRIER_HEIGHT, BARRIER_THICKNESS, LAYER_Y, createTrackMesh } from './trackMesh';
import { buildTrack } from '../track/build';
import { PLAZA } from '../track/plaza';
import { TUNING } from '../shared/tuning';

const track = buildTrack(PLAZA);
const group = createTrackMesh(track);

function mesh(name: string): THREE.Mesh {
  const m = group.getObjectByName(name);
  if (!(m instanceof THREE.Mesh)) throw new Error(`missing ${name}`);
  return m;
}

/** Every `step`-th vertex position. */
function sampleVertices(m: THREE.Mesh, step: number): THREE.Vector3[] {
  const pos = m.geometry.getAttribute('position');
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < pos.count; i += step) out.push(new THREE.Vector3().fromBufferAttribute(pos, i));
  return out;
}

/** Triangle normals' y components (indexed or not). */
function triangleUps(m: THREE.Mesh): number[] {
  const g = m.geometry;
  const pos = g.getAttribute('position');
  const idx = g.getIndex();
  const count = idx ? idx.count : pos.count;
  const at = (k: number) => new THREE.Vector3().fromBufferAttribute(pos, idx ? idx.getX(k) : k);
  const ups: number[] = [];
  for (let k = 0; k < count; k += 3) {
    const a = at(k), b = at(k + 1), c = at(k + 2);
    ups.push(new THREE.Vector3().crossVectors(b.sub(a), c.sub(a)).normalize().y);
  }
  return ups;
}

describe('track mesh', () => {
  it('is four static meshes, one per material; only the barrier casts shadows', () => {
    const meshes = group.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
    expect(meshes.map((m) => m.name).sort()).toEqual(['track-barrier', 'track-paint', 'track-road', 'track-runoff']);
    expect(group.matrixAutoUpdate).toBe(false);
    for (const m of meshes) {
      expect(m.matrixAutoUpdate).toBe(false);
      expect(m.receiveShadow).toBe(true);
      expect(m.castShadow).toBe(m.name === 'track-barrier');
      expect(m.material).toBeInstanceOf(THREE.MeshLambertMaterial);
    }
  });

  it('puts each ground layer at its spec height (§5)', () => {
    expect(LAYER_Y).toMatchObject({ plaza: 0, runoff: 0.02, road: 0.04, paint: 0.06 });
    for (const [name, y] of [['track-road', LAYER_Y.road], ['track-runoff', LAYER_Y.runoff], ['track-paint', LAYER_Y.paint]] as const) {
      const box = new THREE.Box3().setFromBufferAttribute(mesh(name).geometry.getAttribute('position') as THREE.BufferAttribute);
      expect(box.min.y).toBeCloseTo(y, 6);
      expect(box.max.y).toBeCloseTo(y, 6);
    }
    const paint = mesh('track-paint').material as THREE.Material;
    expect(paint.polygonOffset).toBe(true);
  });

  it('ground ribbons face up everywhere (no folds, no culled triangles)', () => {
    for (const name of ['track-road', 'track-runoff', 'track-paint']) {
      for (const up of triangleUps(mesh(name))) expect(up).toBeGreaterThan(0.99);
    }
  });

  it('keeps every layer inside its lateral band', () => {
    const half = TUNING.track.roadHalfWidth;
    const curbOuter = half + TUNING.track.curbWidth;
    const lat = (v: THREE.Vector3) => Math.abs(track.project(v.x, v.z).lateral);
    for (const v of sampleVertices(mesh('track-road'), 37)) expect(lat(v)).toBeLessThanOrEqual(half + 0.3);
    for (const v of sampleVertices(mesh('track-paint'), 41)) expect(lat(v)).toBeLessThanOrEqual(curbOuter + 0.01);
    for (const v of sampleVertices(mesh('track-runoff'), 23)) {
      expect(lat(v)).toBeGreaterThanOrEqual(curbOuter - 0.6);
      expect(lat(v)).toBeLessThanOrEqual(track.barrier + 0.3);
    }
  });

  it('builds a 0.9 m barrier just outside the barrier offset on both sides', () => {
    const barrier = mesh('track-barrier');
    const box = new THREE.Box3().setFromBufferAttribute(barrier.geometry.getAttribute('position') as THREE.BufferAttribute);
    expect(box.min.y).toBeCloseTo(0, 6);
    expect(box.max.y).toBeCloseTo(BARRIER_HEIGHT, 6);
    let left = 0;
    let right = 0;
    for (const v of sampleVertices(barrier, 29)) {
      const p = track.project(v.x, v.z);
      expect(Math.abs(p.lateral)).toBeGreaterThanOrEqual(track.barrier - 0.05);
      expect(Math.abs(p.lateral)).toBeLessThanOrEqual(track.barrier + BARRIER_THICKNESS + 0.05);
      if (p.lateral > 0) left++;
      else right++;
    }
    expect(left).toBeGreaterThan(100);
    expect(right).toBeGreaterThan(100);
  });

  it('leaves the barrier open where the bicycle wheel stands on the barrier line', () => {
    const wheel = track.heavyColliders.find((c) => c.id.startsWith('bicycle#'));
    if (!wheel || wheel.kind !== 'capsule') throw new Error('bicycle capsule missing');
    const pos = mesh('track-barrier').geometry.getAttribute('position');
    let minClear = Infinity;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const dx = wheel.bx - wheel.ax, dz = wheel.bz - wheel.az;
      const u = Math.min(1, Math.max(0, ((x - wheel.ax) * dx + (z - wheel.az) * dz) / (dx * dx + dz * dz)));
      minClear = Math.min(minClear, Math.hypot(wheel.ax + dx * u - x, wheel.az + dz * u - z) - wheel.r);
    }
    expect(minClear).toBeGreaterThan(0);
  });

  it('marks the start line with a checker strip across the road', () => {
    const colors = mesh('track-paint').geometry.getAttribute('color');
    const pos = mesh('track-paint').geometry.getAttribute('position');
    const start = track.poseAt(track.startS);
    let dark = 0;
    for (let i = 0; i < pos.count; i++) {
      if (Math.hypot(pos.getX(i) - start.x, pos.getZ(i) - start.z) > 8) continue;
      if (colors.getX(i) < 0.1 && colors.getY(i) < 0.1) dark++;
    }
    expect(dark).toBeGreaterThan(20 * 6);
  });
});
