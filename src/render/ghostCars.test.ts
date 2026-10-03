import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  GHOST_FADE_FAR,
  GHOST_FADE_NEAR,
  GHOST_OPACITY,
  LABEL_MAX_DISTANCE,
  createGhostLayer,
  ghostOpacity,
  type GhostView,
} from './ghostCars';
import { createCarState } from '../physics/car';

const ROSTER = [
  { name: 'Новичок', color: 0x3fd6a0 },
  { name: 'Профи', color: 0x4c8dff },
  { name: 'Мастер', color: 0xb070ff },
];

function meshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) out.push(o);
  });
  return out;
}

const single = (m: THREE.Mesh): THREE.Material => m.material as THREE.Material;

function view(x: number, z: number, opacity = GHOST_OPACITY, visible = true): GhostView {
  return { car: createCarState(x, z, 0.5), points: 1234, opacity, visible, snap: false };
}

describe('ghostOpacity', () => {
  it('is the ghost opacity far away and invisible where it overlaps the player', () => {
    expect(ghostOpacity(100, 1)).toBeCloseTo(GHOST_OPACITY);
    expect(ghostOpacity(GHOST_FADE_FAR, 1)).toBeCloseTo(GHOST_OPACITY);
    expect(ghostOpacity(0, 1)).toBe(0);
    expect(ghostOpacity(GHOST_FADE_NEAR, 1)).toBe(0);
  });

  it('rises monotonically between the near and far distances', () => {
    let prev = ghostOpacity(GHOST_FADE_NEAR, 1);
    for (let d = GHOST_FADE_NEAR + 0.5; d <= GHOST_FADE_FAR; d += 0.5) {
      const o = ghostOpacity(d, 1);
      expect(o).toBeGreaterThanOrEqual(prev);
      prev = o;
    }
  });

  it('scales with the fade and treats a non-finite distance as far', () => {
    expect(ghostOpacity(100, 0)).toBe(0);
    expect(ghostOpacity(100, 0.5)).toBeCloseTo(GHOST_OPACITY / 2);
    expect(ghostOpacity(100, 2)).toBeCloseTo(GHOST_OPACITY);
    expect(ghostOpacity(Number.NaN, 1)).toBeCloseTo(GHOST_OPACITY);
  });
});

describe('ghost layer', () => {
  it('builds one translucent, shadowless ghost per roster entry with a depth pre-pass', () => {
    const layer = createGhostLayer();
    layer.setRoster(ROSTER);
    expect(layer.group.children).toHaveLength(3);
    const all = meshes(layer.group);
    expect(all.length).toBeGreaterThan(0);
    const depth = all.filter((m) => single(m).colorWrite === false);
    const colour = all.filter((m) => single(m).colorWrite !== false);
    expect(depth.length).toBe(colour.length);
    for (const m of all) expect(m.castShadow).toBe(false);
    for (const m of colour) {
      const mat = single(m);
      expect(mat.transparent).toBe(true);
      expect(mat.depthWrite).toBe(false);
      expect(mat.depthFunc).toBe(THREE.LessEqualDepth);
    }
    for (const m of depth) {
      expect(single(m).depthWrite).toBe(true);
      expect(single(m).transparent).toBe(true);
    }
    // Each colour mesh draws right after its own depth twin.
    for (const m of colour) expect(m.children[0]).toBeInstanceOf(THREE.Mesh);
    for (const m of colour) expect((m.children[0] as THREE.Mesh).renderOrder).toBe(m.renderOrder - 1);
  });

  it('orders the ghosts far to near from the camera, so a ghost behind another blends through it', () => {
    const layer = createGhostLayer();
    layer.setRoster(ROSTER);
    const orders = (): number[] =>
      layer.group.children.map((g) => {
        const colour = meshes(g).filter((m) => single(m).colorWrite !== false);
        expect(new Set(colour.map((m) => m.renderOrder)).size).toBe(1);
        return colour[0].renderOrder;
      });
    const camera = new THREE.Vector3(0, 10, 0);
    // Ghost 0 nearest, ghost 2 farthest.
    layer.update([view(0, 20), view(0, 40), view(0, 60)], 0, camera);
    const [a, b, c] = orders();
    expect(c).toBeLessThan(b);
    expect(b).toBeLessThan(a);
    // Ghost 0 drives off ahead: now it is the farthest and draws first; ghost 1 is the nearest.
    layer.update([view(0, 80), view(0, 40), view(0, 60)], 1 / 60, camera);
    const [a2, b2, c2] = orders();
    expect(a2).toBeLessThan(c2);
    expect(c2).toBeLessThan(b2);
  });

  it('paints each ghost in its colour', () => {
    const layer = createGhostLayer();
    layer.setRoster(ROSTER);
    layer.group.children.forEach((g, i) => {
      const paints = meshes(g)
        .map(single)
        .filter((m): m is THREE.MeshStandardMaterial => m instanceof THREE.MeshStandardMaterial);
      expect(paints.length).toBeGreaterThan(0);
      for (const p of paints) expect(p.color.getHex()).toBe(ROSTER[i].color);
    });
  });

  it('poses the ghosts and applies their opacity; hidden or faded ghosts are not drawn', () => {
    const layer = createGhostLayer();
    layer.setRoster(ROSTER);
    const camera = new THREE.Vector3(0, 10, 0);
    layer.update([view(10, 20), view(-5, 3, 0.2), view(0, 0, GHOST_OPACITY, false)], 0, camera);
    const [a, b, c] = layer.group.children;
    expect(a.visible).toBe(true);
    expect(a.position.x).toBeCloseTo(10);
    expect(a.position.z).toBeCloseTo(20);
    const opacityOf = (g: THREE.Object3D): number[] =>
      meshes(g)
        .map(single)
        .filter((m) => m.colorWrite !== false)
        .map((m) => m.opacity);
    for (const o of opacityOf(a)) expect(o).toBeCloseTo(GHOST_OPACITY);
    for (const o of opacityOf(b)) expect(o).toBeCloseTo(0.2);
    expect(c.visible).toBe(false);
    layer.update([view(10, 20, 0), view(-5, 3), view(0, 0)], 1 / 60, camera);
    expect(a.visible).toBe(false);
    expect(c.visible).toBe(true);
  });

  it('hides a label beyond the label range from the camera', () => {
    const layer = createGhostLayer();
    layer.setRoster(ROSTER);
    const sprites = (): THREE.Sprite[] => {
      const out: THREE.Sprite[] = [];
      layer.group.traverse((o) => {
        if (o instanceof THREE.Sprite) out.push(o);
      });
      return out;
    };
    expect(sprites()).toHaveLength(3);
    const far = LABEL_MAX_DISTANCE + 50;
    layer.update([view(0, 0), view(far, 0), view(0, 5)], 0, new THREE.Vector3(0, 10, 0));
    expect(sprites().map((s) => s.visible)).toEqual([true, false, true]);
  });

  it('hide() hides every ghost', () => {
    const layer = createGhostLayer();
    layer.setRoster(ROSTER);
    layer.update([view(0, 0), view(5, 0), view(10, 0)], 0, new THREE.Vector3());
    layer.hide();
    for (const g of layer.group.children) expect(g.visible).toBe(false);
  });

  it('ignores views beyond the roster and hides ghosts without a view', () => {
    const layer = createGhostLayer();
    layer.setRoster(ROSTER.slice(0, 2));
    layer.update([view(0, 0), view(1, 1), view(2, 2)], 0, new THREE.Vector3());
    expect(layer.group.children.map((g) => g.visible)).toEqual([true, true]);
    layer.update([view(0, 0)], 1 / 60, new THREE.Vector3());
    expect(layer.group.children.map((g) => g.visible)).toEqual([true, false]);
  });
});
