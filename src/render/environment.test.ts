import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  FOG_FAR,
  FOG_NEAR,
  SHADOW_BOX,
  SHADOW_EDGE_FADE_FN,
  SHADOW_FADE_START,
  SHADOW_LEAD,
  SHADOW_MAP_SIZE,
  createRaceEnvironment,
  installShadowEdgeFade,
} from './environment';
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

  it('centres the shadow box SHADOW_LEAD ahead of the car along the camera yaw', () => {
    const { renderer } = fakeRenderer();
    const { sun, updateShadows } = createRaceEnvironment(renderer, 'medium');
    const texel = SHADOW_BOX / SHADOW_MAP_SIZE;
    expect(SHADOW_LEAD).toBeGreaterThanOrEqual(50);
    expect(SHADOW_LEAD).toBeLessThanOrEqual(65);
    for (const [x, z, fx, fz] of [[10, 20, 0, 24], [-150.3, 77.7, 3, -4], [300, -12, -0.001, 0]]) {
      updateShadows(x, z, fx, fz);
      const len = Math.hypot(fx, fz);
      const t = sun.target.position;
      // The forward vector's length does not matter, only its direction.
      expect(Math.hypot(t.x - (x + (fx / len) * SHADOW_LEAD), t.z - (z + (fz / len) * SHADOW_LEAD))).toBeLessThan(texel * 2);
    }
    // No forward direction: centred on the given point.
    updateShadows(40, -40, 0, 0);
    expect(Math.hypot(sun.target.position.x - 40, sun.target.position.z + 40)).toBeLessThan(texel * 2);
  });

  it('shades everything from the bottom of the chase view to 140 m ahead, for every heading', () => {
    const { renderer } = fakeRenderer();
    const { sun, updateShadows } = createRaceEnvironment(renderer, 'medium');
    const car = new THREE.Vector3(37.5, 0, -81.25);
    const p = new THREE.Vector3();
    for (let deg = 0; deg < 360; deg += 7.5) {
      const a = THREE.MathUtils.degToRad(deg);
      const f = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
      const left = new THREE.Vector3(f.z, 0, -f.x);
      updateShadows(car.x, car.z, f.x * 24, f.z * 24);
      sun.shadow.updateMatrices(sun);
      const frustum = sun.shadow.getFrustum();
      // Ground (and 10 m tall walls) the chase camera sees: from ~12 m behind the car (bottom edge of the
      // view, 14 m to each side) to 140 m ahead, the old pop-in distance being ~110-125 m. Up to 120 m
      // ahead the shadows are at full strength (inside the edge fade).
      const samples: [number, number][] = [[-12, 14], [-12, -14], [0, 25], [0, -25]];
      for (let d = -12; d <= 140; d += 4) samples.push([d, 0]);
      for (const [ahead, side] of samples) {
        for (const y of [0, 10]) {
          p.copy(car).addScaledVector(f, ahead).addScaledVector(left, side).setY(y);
          const where = `heading ${deg}°, ${ahead} m ahead, ${side} m left, y ${y}`;
          expect(frustum.containsPoint(p), where).toBe(true);
          const uv = p.clone().applyMatrix4(sun.shadow.matrix);
          const edge = Math.max(Math.abs(uv.x * 2 - 1), Math.abs(uv.y * 2 - 1));
          if (ahead <= 120) expect(edge, where).toBeLessThanOrEqual(SHADOW_FADE_START);
        }
      }
    }
  });

  it('fades directional shadows toward the box edge, patching three once and leaving spot shadows alone', () => {
    const { renderer } = fakeRenderer();
    createRaceEnvironment(renderer, 'medium');
    createRaceEnvironment(renderer, 'high');
    expect(installShadowEdgeFade()).toBe(true);
    const chunks = THREE.ShaderChunk as Record<string, string>;
    const count = (s: string, sub: string) => s.split(sub).length - 1;
    expect(count(chunks.shadowmap_pars_fragment, `float ${SHADOW_EDGE_FADE_FN}(`)).toBe(1);
    expect(count(chunks.lights_fragment_begin, `${SHADOW_EDGE_FADE_FN}( vDirectionalShadowCoord[ i ] )`)).toBe(1);
    expect(count(chunks.lights_fragment_begin, SHADOW_EDGE_FADE_FN)).toBe(1);
    expect(SHADOW_FADE_START).toBeGreaterThan(0.8);
    expect(SHADOW_FADE_START).toBeLessThan(1);
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
