import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createBombsLayer } from './bombs';
import { makeCircleTrack } from '../game/testTracks';
import { TUNING } from '../shared/tuning';

const r = TUNING.bomb.radius;
const track = makeCircleTrack(100, { bombs: [{ id: 'a', x: 1, z: 2, r }, { id: 'b', x: -3, z: 4, r }] });

describe('bombs layer', () => {
  it('stands one bomb model per spot on the road, about the trigger size', () => {
    const layer = createBombsLayer(track);
    const roots = layer.group.children;
    expect(roots.map((o) => o.name)).toEqual(['bomb-a', 'bomb-b']);
    expect(roots[0].position.toArray()).toEqual([1, 0, 2]);
    layer.group.updateMatrixWorld(true);
    const shell = roots[0].getObjectByName('bomb-shell')!;
    const box = new THREE.Box3().setFromObject(shell);
    expect(box.min.y).toBeLessThanOrEqual(0.01);
    expect(box.max.x - box.min.x).toBeCloseTo(2 * r, 1);
    expect(shell.castShadow).toBe(true);
  });

  it('hides blown bombs and shows them again when the state no longer lists them', () => {
    const layer = createBombsLayer(track);
    const visible = () => layer.group.children.map((o) => o.visible);
    layer.update({ blown: new Set(['a']) }, 0);
    expect(visible()).toEqual([false, true]);
    layer.update({ blown: new Set() }, 0.1);
    expect(visible()).toEqual([true, true]);
    layer.update({ blown: new Set(['b']) }, 0.2);
    layer.update(null, 0.3);
    expect(visible()).toEqual([true, true]);
  });

  it('blinks the fuse spark on the sim clock', () => {
    const layer = createBombsLayer(track);
    const spark = layer.group.children[0].getObjectByName('bomb-spark')!;
    const scales = [0, 0.03, 0.06, 0.09, 0.12].map((t) => (layer.update(null, t), spark.scale.x));
    expect(new Set(scales.map((s) => s.toFixed(4))).size).toBeGreaterThan(2);
    for (const s of scales) expect(s).toBeGreaterThan(0);
  });
});
