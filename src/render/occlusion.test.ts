import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FADE_TIME, OCCLUDED_OPACITY, OCCLUDER_RENDER_ORDER, createOcclusionFader } from './occlusion';

/** A 10 x 1 x 6 slab (like the bench seat) centred at (0, 5, z). */
function slab(z: number): { mesh: THREE.Mesh; material: THREE.MeshLambertMaterial } {
  const material = new THREE.MeshLambertMaterial({ color: 0xc98a57 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(10, 1, 6), material);
  mesh.position.set(0, 5, z);
  mesh.updateMatrixWorld(true);
  return { mesh, material };
}

function cameraAt(x: number, y: number, z: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(58, 16 / 9, 1, 1500);
  camera.position.set(x, y, z);
  camera.updateMatrixWorld(true);
  return camera;
}

describe('occlusion fader', () => {
  it('prepares materials as transparent once, keeping them opaque', () => {
    const { mesh, material } = slab(0);
    createOcclusionFader([mesh]);
    expect(material.transparent).toBe(true);
    expect(mesh.renderOrder).toBe(OCCLUDER_RENDER_ORDER);
    expect(material.opacity).toBe(1);
    expect(material.depthWrite).toBe(true);
  });

  it('fades to 25 % over 0.2 s while the slab blocks the camera -> car line, then back', () => {
    const { mesh, material } = slab(0);
    const fader = createOcclusionFader([mesh]);
    const camera = cameraAt(0, 9.5, -12);
    const car = new THREE.Vector3(0, 0.6, 8);

    fader.update(camera, car, FADE_TIME / 2);
    expect(material.opacity).toBeCloseTo(1 - 0.5 * (1 - OCCLUDED_OPACITY), 5);
    expect(material.depthWrite).toBe(false);
    fader.update(camera, car, FADE_TIME);
    expect(material.opacity).toBeCloseTo(OCCLUDED_OPACITY, 5);

    // Car moves far to the side: the line no longer crosses the slab.
    car.set(40, 0.6, 8);
    fader.update(camera, car, FADE_TIME / 2);
    expect(material.opacity).toBeGreaterThan(OCCLUDED_OPACITY);
    expect(material.opacity).toBeLessThan(1);
    fader.update(camera, car, FADE_TIME);
    expect(material.opacity).toBe(1);
    expect(material.depthWrite).toBe(true);
  });

  it('ignores occluders that do not block, and reset() snaps back to opaque', () => {
    const near = slab(0);
    const far = slab(200);
    const fader = createOcclusionFader([near.mesh, far.mesh]);
    const camera = cameraAt(0, 9.5, -12);
    for (let i = 0; i < 3; i++) fader.update(camera, new THREE.Vector3(0, 0.6, 8), 0.1);
    expect(near.material.opacity).toBeCloseTo(OCCLUDED_OPACITY, 5);
    expect(far.material.opacity).toBe(1);
    fader.reset();
    expect(near.material.opacity).toBe(1);
    expect(near.material.depthWrite).toBe(true);
  });

  it('does not fade when the car is in front of the occluder (segment ends before it)', () => {
    const { mesh, material } = slab(30);
    const fader = createOcclusionFader([mesh]);
    fader.update(cameraAt(0, 9.5, -12), new THREE.Vector3(0, 0.6, 6), 1);
    expect(material.opacity).toBe(1);
  });

  it('uses each mesh box of a group, not the group bounds (passing under a banner does not fade)', () => {
    const group = new THREE.Group();
    const material = new THREE.MeshLambertMaterial();
    const left = new THREE.Mesh(new THREE.BoxGeometry(1.8, 13, 1.8), material);
    left.position.set(-15, 6.5, 0);
    const right = left.clone();
    right.position.x = 15;
    const banner = new THREE.Mesh(new THREE.BoxGeometry(28, 2, 0.6), material);
    banner.position.set(0, 11.8, 0);
    group.add(left, right, banner);
    const fader = createOcclusionFader([group]);
    // Camera just behind the arch at 9.5 m, car well past it.
    fader.update(cameraAt(0, 9.5, -2), new THREE.Vector3(0, 0.6, 16), 1);
    expect(material.opacity).toBe(1);
  });

  it('survives a zero / missing dt and non-finite dt without NaN', () => {
    const { mesh, material } = slab(0);
    const fader = createOcclusionFader([mesh]);
    const camera = cameraAt(0, 9.5, -12);
    const car = new THREE.Vector3(0, 0.6, 8);
    fader.update(camera, car, 0);
    fader.update(camera, car, Number.NaN);
    fader.update(camera, car);
    expect(Number.isFinite(material.opacity)).toBe(true);
    expect(material.opacity).toBeLessThanOrEqual(1);
  });
});
