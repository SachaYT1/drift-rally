import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { separateInstancedShadowCasters } from './shadowCasters';

const box = new THREE.BoxGeometry();

function caster<T extends THREE.Mesh>(o: T, cast = true): T {
  o.castShadow = cast;
  return o;
}

describe('separateInstancedShadowCasters', () => {
  it('gives every instanced caster one shared depth material and leaves plain meshes on the default', () => {
    const root = new THREE.Group();
    const coins = caster(new THREE.InstancedMesh(box, new THREE.MeshLambertMaterial(), 8));
    const cups = caster(new THREE.InstancedMesh(box, [new THREE.MeshLambertMaterial(), new THREE.MeshLambertMaterial()], 4));
    const building = caster(new THREE.Mesh(box, new THREE.MeshLambertMaterial()));
    const nested = new THREE.Group().add(coins);
    root.add(nested, cups, building);
    const depth = separateInstancedShadowCasters(root);
    expect(depth).toBeInstanceOf(THREE.MeshDepthMaterial);
    expect(coins.customDepthMaterial).toBe(depth);
    expect(cups.customDepthMaterial).toBe(depth);
    expect(building.customDepthMaterial).toBeUndefined();
  });

  it('skips non-casters, custom depth materials and materials three needs a per-material variant for', () => {
    const root = new THREE.Group();
    const noShadow = caster(new THREE.InstancedMesh(box, new THREE.MeshLambertMaterial(), 2), false);
    const own = caster(new THREE.InstancedMesh(box, new THREE.MeshLambertMaterial(), 2));
    const mine = new THREE.MeshDepthMaterial();
    own.customDepthMaterial = mine;
    const cutout = caster(new THREE.InstancedMesh(box, new THREE.MeshLambertMaterial({ map: new THREE.Texture(), alphaTest: 0.5 }), 2));
    root.add(noShadow, own, cutout);
    separateInstancedShadowCasters(root);
    expect(noShadow.customDepthMaterial).toBeUndefined();
    expect(own.customDepthMaterial).toBe(mine);
    expect(cutout.customDepthMaterial).toBeUndefined();
  });
});
