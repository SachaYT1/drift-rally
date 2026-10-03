import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  PROCEDURAL_SIZE,
  createBench,
  createBicycle,
  createPlanterTree,
  createSneaker,
  createStartArch,
  startArchSize,
  type Size3,
} from './procedural';
import { OCCLUDER_BOXES } from './proceduralKit';
import { PLAZA } from '../track/plaza';
import { VISUAL_HEIGHT, type FootprintShape } from '../track/trackDef';

/**
 * Footprints are authored in obstacle-local coordinates (+x along the track tangent, +z = left).
 * Models face +Z with +X on their left, so a footprint point (fx, fz) sits at model (X = fz, Z = fx).
 */
function footprint(id: string): FootprintShape[] {
  const def = PLAZA.heavy.find((h) => h.id === id);
  if (!def) throw new Error(`missing heavy obstacle ${id}`);
  return def.footprint;
}

function boxOf(obj: THREE.Object3D): THREE.Box3 {
  obj.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(obj);
}

function sizeOf(obj: THREE.Object3D): THREE.Vector3 {
  return boxOf(obj).getSize(new THREE.Vector3());
}

function expectWithin(actual: number, expected: number, tolerance = 0.1): void {
  expect(actual).toBeGreaterThanOrEqual(expected * (1 - tolerance));
  expect(actual).toBeLessThanOrEqual(expected * (1 + tolerance));
}

function expectSize(obj: THREE.Object3D, size: Size3): void {
  const s = sizeOf(obj);
  expectWithin(s.x, size.x);
  expectWithin(s.y, size.y);
  expectWithin(s.z, size.z);
}

/** Every vertex of every mesh under `root`, in root space. */
function vertices(root: THREE.Object3D, filter: (m: THREE.Mesh) => boolean = () => true): THREE.Vector3[] {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  const out: THREE.Vector3[] = [];
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !filter(o)) return;
    const pos = o.geometry.getAttribute('position');
    const m = inv.clone().multiply(o.matrixWorld);
    for (let i = 0; i < pos.count; i++) out.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m));
  });
  return out;
}

function meshesTagged(root: THREE.Object3D, key: string, value: unknown = true): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.Mesh && o.userData[key] === value) out.push(o);
  });
  return out;
}

/** Union box of the given meshes, in root space (root at identity). */
function unionBox(meshes: THREE.Mesh[]): THREE.Box3 {
  const box = new THREE.Box3();
  for (const m of meshes) {
    m.updateWorldMatrix(true, false);
    box.union(new THREE.Box3().setFromObject(m));
  }
  return box;
}

/** Distance in the ground plane from (x, z) to a footprint capsule mapped to model space. */
function capsuleDistance(x: number, z: number, f: Extract<FootprintShape, { type: 'capsule' }>): number {
  // Model space: X = footprint z, Z = footprint x.
  const ax = f.az, az = f.ax, bx = f.bz, bz = f.bx;
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const u = len2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
  return Math.hypot(ax + dx * u - x, az + dz * u - z);
}

describe('procedural world objects', () => {
  it('every builder returns finite Lambert meshes with shadows decided per mesh', () => {
    for (const obj of [createBench(), createBicycle(), createSneaker(), createPlanterTree(), createStartArch(28)]) {
      let meshes = 0;
      obj.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        meshes++;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) expect(m).toBeInstanceOf(THREE.MeshLambertMaterial);
        const pos = o.geometry.getAttribute('position');
        for (let i = 0; i < pos.array.length; i++) expect(Number.isFinite(pos.array[i])).toBe(true);
        expect(o.geometry.getAttribute('normal')).toBeDefined();
      });
      expect(meshes).toBeGreaterThan(0);
      const box = boxOf(obj);
      expect(box.min.y).toBeCloseTo(0, 1);
    }
  });

  describe('bench (zone 4 obstacle)', () => {
    const bench = createBench();

    it('matches the documented size and the catalog height', () => {
      expectSize(bench, PROCEDURAL_SIZE.bench);
      expectWithin(sizeOf(bench).y, VISUAL_HEIGHT.bench);
    });

    it('stands exactly on the four leg footprints of plaza.ts', () => {
      const legs = footprint('bench').filter((f): f is Extract<FootprintShape, { type: 'circle' }> => f.type === 'circle');
      expect(legs).toHaveLength(4);
      const low = vertices(bench).filter((v) => v.y < 0.5);
      expect(low.length).toBeGreaterThan(0);
      // Nothing touches the ground outside a leg circle.
      for (const v of low) {
        const d = Math.min(...legs.map((l) => Math.hypot(v.x - l.z, v.z - l.x) - l.r));
        expect(d).toBeLessThanOrEqual(0.05);
      }
      // Every leg has geometry centred on its footprint.
      for (const l of legs) {
        const near = low.filter((v) => Math.hypot(v.x - l.z, v.z - l.x) <= l.r + 0.05);
        expect(near.length).toBeGreaterThan(0);
        const cx = near.reduce((a, v) => a + v.x, 0) / near.length;
        const cz = near.reduce((a, v) => a + v.z, 0) / near.length;
        expect(Math.abs(cx - l.z)).toBeLessThan(0.1);
        expect(Math.abs(cz - l.x)).toBeLessThan(0.1);
        // The leg is about as thick as its collider.
        const r = Math.max(...near.map((v) => Math.hypot(v.x - l.z, v.z - l.x)));
        expect(r).toBeGreaterThan(l.r * 0.8);
      }
    });

    it('has its seat top at 5.4 m with room for the car underneath', () => {
      const seat = unionBox(meshesTagged(bench, 'part', 'seat'));
      expect(seat.isEmpty()).toBe(false);
      expect(seat.max.y).toBeCloseTo(5.4, 1);
      expect(seat.min.y).toBeGreaterThan(4.2);
      // The seat spans the whole road between the legs.
      expect(seat.min.x).toBeLessThan(-7);
      expect(seat.max.x).toBeGreaterThan(7);
    });

    it('tags the seat and backrest as occluders, nothing low enough to hide the car', () => {
      const occ = meshesTagged(bench, 'occluder');
      expect(occ.length).toBeGreaterThan(0);
      const box = unionBox(occ);
      expect(box.min.y).toBeGreaterThan(4.2);
      expectWithin(box.max.y, VISUAL_HEIGHT.bench);
      const seatMeshes = meshesTagged(bench, 'part', 'seat');
      for (const m of seatMeshes) expect(m.userData.occluder).toBe(true);
    });
  });

  describe('bicycle (zone 3 obstacle)', () => {
    const bike = createBicycle();

    it('matches the documented size: ~21 m long, wheels r 4.2, catalog height', () => {
      expectSize(bike, PROCEDURAL_SIZE.bicycle);
      expectWithin(sizeOf(bike).z, 21);
      expectWithin(sizeOf(bike).y, VISUAL_HEIGHT.bicycle);
      const front = unionBox(meshesTagged(bike, 'part', 'frontTyre'));
      expectWithin(front.max.y - front.min.y, 8.4, 0.05);
    });

    it('front tyre is fat and covers the collider capsule of plaza.ts', () => {
      const cap = footprint('bicycle')[0];
      if (cap.type !== 'capsule') throw new Error('bicycle footprint must be a capsule');
      const tyre = unionBox(meshesTagged(bike, 'part', 'frontTyre'));
      expect(tyre.isEmpty()).toBe(false);
      const width = tyre.max.x - tyre.min.x;
      expect(width).toBeGreaterThanOrEqual(2.4);
      expect(width).toBeLessThanOrEqual(2 * cap.r + 0.1);
      // Ground-plane extent of the tyre matches the capsule ends within a few decimetres.
      expect(Math.abs(tyre.min.z - (cap.ax - cap.r))).toBeLessThan(0.4);
      expect(Math.abs(tyre.max.z - (cap.bx + cap.r))).toBeLessThan(0.4);
      // Every tyre vertex projects inside the capsule (the visible wheel is what the car hits); the
      // tyre's round ends (r 4.2) may overhang the capsule ends by a few centimetres.
      for (const v of vertices(bike, (m) => m.userData.part === 'frontTyre')) {
        expect(capsuleDistance(v.x, v.z, cap)).toBeLessThanOrEqual(cap.r + 0.2);
      }
    });

    it('has a coral frame', () => {
      const frame = meshesTagged(bike, 'part', 'frame');
      expect(frame.length).toBeGreaterThan(0);
      const m = frame[0].material as THREE.MeshLambertMaterial;
      const hsl = m.color.getHSL({ h: 0, s: 0, l: 0 });
      expect(hsl.h < 0.06 || hsl.h > 0.95).toBe(true);
      expect(hsl.s).toBeGreaterThan(0.5);
    });
  });

  describe('sneaker (zone 7 obstacle)', () => {
    const shoe = createSneaker();

    it('matches the documented size and the catalog height', () => {
      expectSize(shoe, PROCEDURAL_SIZE.sneaker);
      expectWithin(sizeOf(shoe).y, VISUAL_HEIGHT.sneaker);
      expectWithin(sizeOf(shoe).z, 6);
    });

    it('stays inside its collider capsule from plaza.ts', () => {
      const cap = footprint('sneaker')[0];
      if (cap.type !== 'capsule') throw new Error('sneaker footprint must be a capsule');
      for (const v of vertices(shoe)) expect(capsuleDistance(v.x, v.z, cap)).toBeLessThanOrEqual(cap.r + 0.1);
    });
  });

  describe('planter tree (zone 5)', () => {
    const planter = createPlanterTree();

    it('matches the documented size: ~40 m wide planter, catalog height', () => {
      expectSize(planter, PROCEDURAL_SIZE.planterTree);
      expectWithin(sizeOf(planter).y, VISUAL_HEIGHT.planterTree);
      const tub = unionBox(meshesTagged(planter, 'part', 'planter'));
      expectWithin(tub.max.x - tub.min.x, 40);
      expectWithin(tub.max.z - tub.min.z, 40);
    });

    it('tags the canopy as an occluder', () => {
      const occ = meshesTagged(planter, 'occluder');
      expect(occ.length).toBeGreaterThan(0);
      expect(unionBox(occ).min.y).toBeGreaterThan(10);
    });
  });

  describe('start arch', () => {
    it.each([24, 28, 32])('spans width %f with posts outside it and a banner above the camera', (width) => {
      const arch = createStartArch(width);
      expectSize(arch, startArchSize(width));
      expectWithin(sizeOf(arch).y, VISUAL_HEIGHT.startArch);
      // Below the banner nothing stands inside the span (road, runoff, barrier and camera stay clear).
      for (const v of vertices(arch).filter((p) => p.y < 10.5)) expect(Math.abs(v.x)).toBeGreaterThanOrEqual(width / 2 - 0.02);
      expect(meshesTagged(arch, 'occluder').length).toBeGreaterThan(0);
    });

    /** Per-piece boxes of the arch meshes whose colour is `hex` (pieces are merged per material). */
    function archPieces(arch: THREE.Object3D, hex: number): THREE.Box3[] {
      const out: THREE.Box3[] = [];
      for (const m of meshesTagged(arch, 'part', 'arch')) {
        if ((m.material as THREE.MeshLambertMaterial).color.getHex() !== hex) continue;
        const b: number[] = m.userData[OCCLUDER_BOXES];
        for (let i = 0; i < b.length; i += 6) {
          out.push(new THREE.Box3(new THREE.Vector3(b[i], b[i + 1], b[i + 2]), new THREE.Vector3(b[i + 3], b[i + 4], b[i + 5])));
        }
      }
      return out;
    }

    it.each([24, 28, 32])('wraps each post band proud of every post face so nothing z-fights (width %f)', (width) => {
      const arch = createStartArch(width);
      const posts = archPieces(arch, 0xf7f5f1);
      // Coral pieces low on the post are the bands (the other coral pieces are the caps on top).
      const bands = archPieces(arch, 0xf0573a).filter((b) => b.max.y < 6);
      expect(posts).toHaveLength(2);
      expect(bands).toHaveLength(2);
      // A gap this size stays resolvable by a 24-bit depth buffer (near 1 m) far beyond fog start.
      const proud = 0.03;
      for (const band of bands) {
        const post = posts.find((p) => p.min.x < band.max.x && p.max.x > band.min.x);
        if (!post) throw new Error('band without a post');
        expect(band.min.y).toBeGreaterThan(post.min.y);
        expect(band.max.y).toBeLessThan(post.max.y);
        expect(band.min.x).toBeLessThanOrEqual(post.min.x - proud);
        expect(band.max.x).toBeGreaterThanOrEqual(post.max.x + proud);
        expect(band.min.z).toBeLessThanOrEqual(post.min.z - proud);
        expect(band.max.z).toBeGreaterThanOrEqual(post.max.z + proud);
      }
      // The banner still meets both posts (no sky showing between banner end and post).
      const banner = unionBox(meshesTagged(arch, 'part', 'banner'));
      for (const post of posts) {
        const inner = post.min.x > 0 ? post.min.x : post.max.x;
        expect(banner.max.x).toBeGreaterThanOrEqual(Math.abs(inner) - 1e-6);
        expect(banner.min.x).toBeLessThanOrEqual(-Math.abs(inner) + 1e-6);
      }
    });
  });

  it('documents sizes consistent with the plan', () => {
    expect(PROCEDURAL_SIZE.bicycle.z).toBeCloseTo(21, 0);
    expect(PROCEDURAL_SIZE.sneaker.z).toBeCloseTo(6, 0);
    expect(PROCEDURAL_SIZE.planterTree.x).toBeCloseTo(40, 0);
    expect(PROCEDURAL_SIZE.bench.y).toBeCloseTo(VISUAL_HEIGHT.bench, 0);
  });
});
