import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { SkidMarks, type Trail } from './skidMarks';

const newTrail = (): Trail => ({ active: false, edged: false, x: 0, z: 0, lx: 0, lz: 0, rx: 0, rz: 0, alpha: 0 });

/** y of the face normal of triangle (a, b, c) given by vertex indices (counter-clockwise front face). */
function normalY(pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, a: number, b: number, c: number): number {
  const va = new THREE.Vector3().fromBufferAttribute(pos, a);
  const ab = new THREE.Vector3().fromBufferAttribute(pos, b).sub(va);
  const ac = new THREE.Vector3().fromBufferAttribute(pos, c).sub(va);
  return ab.cross(ac).normalize().y;
}

describe('SkidMarks', () => {
  it('draws in a single pass: one-sided transparent material (no per-frame DoubleSide two-pass)', () => {
    const { material } = new SkidMarks().mesh;
    expect(material.transparent).toBe(true);
    expect(material.side === THREE.FrontSide || material.forceSinglePass).toBe(true);
  });

  it('winds every quad to face up, whatever the travel direction (front faces stay visible)', () => {
    const marks = new SkidMarks();
    const geo = marks.mesh.geometry;
    const pos = geo.getAttribute('position');
    const index = geo.getIndex();
    if (!index) throw new Error('skid marks need an index');
    const headings = 12;
    for (let k = 0; k < headings; k++) {
      // Straight run, then a gentle curve, from a fresh trail per heading.
      const t = newTrail();
      const h0 = (k / headings) * Math.PI * 2;
      let x = k * 50;
      let z = 0;
      marks.extend(t, x, z, 1);
      for (let i = 0; i < 12; i++) {
        const h = h0 + (i > 6 ? (i - 6) * 0.15 : 0);
        x += Math.sin(h) * 0.6;
        z += Math.cos(h) * 0.6;
        marks.extend(t, x, z, 1);
      }
    }
    marks.flush();
    const quads = geo.drawRange.count / 6;
    expect(quads).toBe(headings * 12);
    for (let q = 0; q < quads; q++) {
      for (const tri of [0, 3]) {
        const i = q * 6 + tri;
        expect(normalY(pos, index.getX(i), index.getX(i + 1), index.getX(i + 2))).toBeGreaterThan(0.99);
      }
    }
  });
});
