import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { FOG_FAR, FOG_NEAR, SHADOW_BOX, SHADOW_MAP_SIZE, createRaceEnvironment } from './environment';
import { TUNING } from '../shared/tuning';

/** Just enough of a WebGLRenderer for createRaceEnvironment in node. */
function fakeRenderer(): { renderer: THREE.WebGLRenderer; setPixelRatio: ReturnType<typeof vi.fn>; shadowMap: { enabled: boolean } } {
  const setPixelRatio = vi.fn();
  const shadowMap = { enabled: false, type: THREE.PCFShadowMap };
  const renderer = { setPixelRatio, shadowMap } as unknown as THREE.WebGLRenderer;
  return { renderer, setPixelRatio, shadowMap };
}

describe('race environment', () => {
  it('uses fog = clear colour inside camera.far and no scene.environment', () => {
    const { renderer } = fakeRenderer();
    const { scene } = createRaceEnvironment(renderer, 'medium');
    expect(scene.fog).toBeInstanceOf(THREE.Fog);
    const fog = scene.fog as THREE.Fog;
    expect(fog.near).toBe(FOG_NEAR);
    expect(fog.far).toBe(FOG_FAR);
    expect(fog.far).toBeLessThanOrEqual(TUNING.camera.far);
    expect(scene.background).toBeInstanceOf(THREE.Color);
    expect((scene.background as THREE.Color).getHex()).toBe(fog.color.getHex());
    expect(scene.environment).toBeNull();
  });

  it('has exactly one hemisphere and one directional light, with the target in the scene', () => {
    const { renderer } = fakeRenderer();
    const { scene, sun } = createRaceEnvironment(renderer, 'medium');
    const lights: THREE.Light[] = [];
    scene.traverse((o) => {
      if (o instanceof THREE.Light) lights.push(o);
    });
    expect(lights.filter((l) => l instanceof THREE.HemisphereLight)).toHaveLength(1);
    expect(lights.filter((l) => l instanceof THREE.DirectionalLight)).toHaveLength(1);
    expect(sun.target.parent).toBe(scene);
    expect(sun.shadow.mapSize.x).toBe(SHADOW_MAP_SIZE);
    const cam = sun.shadow.camera;
    expect(cam.right - cam.left).toBeCloseTo(SHADOW_BOX, 6);
    expect(cam.top - cam.bottom).toBeCloseTo(SHADOW_BOX, 6);
  });

  it('applies quality: shadows on for medium, off for low', () => {
    const { renderer, setPixelRatio, shadowMap } = fakeRenderer();
    const env = createRaceEnvironment(renderer, 'medium');
    expect(shadowMap.enabled).toBe(true);
    expect(env.sun.castShadow).toBe(true);
    env.setQuality('low');
    expect(shadowMap.enabled).toBe(false);
    expect(env.sun.castShadow).toBe(false);
    expect(setPixelRatio).toHaveBeenLastCalledWith(1);
  });

  it('centres the shadow box on the focus, light 400 m back, snapped to whole texels', () => {
    const { renderer } = fakeRenderer();
    const { sun, updateShadows } = createRaceEnvironment(renderer, 'medium');
    const texel = SHADOW_BOX / SHADOW_MAP_SIZE;
    for (const [x, z] of [[0, 0], [123.456, -78.9], [-210.01, 140.77]]) {
      updateShadows(x, z);
      const t = sun.target.position;
      const p = sun.position;
      expect(p.distanceTo(t)).toBeCloseTo(400, 6);
      // The snapped target lies within a texel or so of the focus.
      expect(Math.hypot(t.x - x, t.z - z)).toBeLessThan(texel * 2);
      // Shadow camera basis (Matrix4.lookAt with up = +Y): light-space coordinates are texel multiples.
      const zAxis = p.clone().sub(t).normalize();
      const right = new THREE.Vector3(0, 1, 0).cross(zAxis).normalize();
      const up = zAxis.clone().cross(right);
      for (const axis of [right, up]) {
        const k = t.dot(axis) / texel;
        expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-6);
      }
    }
  });

  it('keeps the light still for sub-texel focus moves (no shimmer)', () => {
    const { renderer } = fakeRenderer();
    const { sun, updateShadows } = createRaceEnvironment(renderer, 'medium');
    updateShadows(50.0, 20.0);
    const a = sun.target.position.clone();
    const zAxis = sun.position.clone().sub(sun.target.position).normalize();
    const right = new THREE.Vector3(0, 1, 0).cross(zAxis).normalize();
    const up = zAxis.clone().cross(right);
    updateShadows(50.004, 20.003);
    // Only a slide along the light direction is allowed; the texel grid (right/up) stays put.
    const d = sun.target.position.clone().sub(a);
    expect(Math.abs(d.dot(right))).toBeLessThan(1e-9);
    expect(Math.abs(d.dot(up))).toBeLessThan(1e-9);
  });

  it('ignores non-finite focus points', () => {
    const { renderer } = fakeRenderer();
    const { sun, updateShadows } = createRaceEnvironment(renderer, 'medium');
    updateShadows(10, 10);
    const before = sun.position.clone();
    updateShadows(Number.NaN, 3);
    expect(sun.position.equals(before)).toBe(true);
  });
});
