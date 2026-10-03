import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createRaceScene } from './raceScene';
import { SHADOW_BOX, SHADOW_LEAD, SHADOW_MAP_SIZE } from '../render/environment';
import { createCarState } from '../physics/car';
import { createPickups } from '../game/pickups';
import { buildTrack } from '../track/build';
import { PLAZA } from '../track/plaza';
import type { AssetLibrary } from '../core/assets';

// The scene-side consumers are irrelevant here (and need GPU-side assets): stub them.
vi.mock('../render/world', () => ({ createWorld: () => ({ group: new THREE.Group(), occluders: [] }) }));
vi.mock('../render/trackMesh', () => ({ createTrackMesh: () => new THREE.Group() }));
vi.mock('../render/props', () => ({
  createPropsLayer: () => ({ group: new THREE.Group(), update() {}, resetLap() {}, onEvent() {} }),
}));
vi.mock('../render/fx', () => ({ createFx: () => ({ update() {}, reset() {}, onEvent() {} }) }));
vi.mock('../render/carModel', () => ({
  createCarModel: () => ({ root: new THREE.Group(), update() {}, reset() {}, setEnvMap() {}, setColor() {} }),
}));

const track = buildTrack(PLAZA);

function fakeRenderer(): THREE.WebGLRenderer {
  return { setPixelRatio: () => {}, shadowMap: { enabled: false, type: THREE.PCFShadowMap } } as unknown as THREE.WebGLRenderer;
}

describe('race scene shadows', () => {
  it('centres the sun shadow box SHADOW_LEAD ahead of the car along the camera yaw', () => {
    const race = createRaceScene(fakeRenderer(), track, {} as AssetLibrary, 'medium', new THREE.Texture());
    const texel = SHADOW_BOX / SHADOW_MAP_SIZE;
    for (const heading of [0, 1.1, -2.4, Math.PI]) {
      const car = createCarState(120.5, -60.25, heading);
      race.sync({ car, surface: 'road', pickups: createPickups(), simTime: 0, snap: true }, 0);
      const t = race.env.sun.target.position;
      const ahead = { x: car.x + Math.sin(heading) * SHADOW_LEAD, z: car.z + Math.cos(heading) * SHADOW_LEAD };
      expect(Math.hypot(t.x - ahead.x, t.z - ahead.z)).toBeLessThan(texel * 2);
    }
  });
});
