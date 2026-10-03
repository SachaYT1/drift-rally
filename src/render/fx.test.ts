import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createFx } from './fx';
import { createPropsLayer } from './props';
import { createPickups, type PickupState } from '../game/pickups';
import { makeCircleTrack } from '../game/testTracks';
import type { AssetLibrary } from '../core/assets';
import type { CarState, DriveMode, LightPropSpot } from '../shared/types';

const DT = 1 / 60;

/** Kinematic car driving a circle of radius `radius` (CCW), body yawed `slip` rad off the velocity. */
function makeDriver(speed: number, slip: number, mode: DriveMode, radius = 30) {
  let phi = 0;
  let x = 0;
  let z = 0;
  return {
    step(dt: number): CarState {
      phi += (speed / radius) * dt;
      x += Math.sin(phi) * speed * dt;
      z += Math.cos(phi) * speed * dt;
      return this.state();
    },
    teleport(nx: number, nz: number): void {
      x = nx;
      z = nz;
    },
    state(): CarState {
      const heading = phi + slip;
      return {
        x, z, heading,
        vx: Math.sin(phi) * speed, vz: Math.cos(phi) * speed,
        yawRate: speed / radius, steer: 0.5, mode, driftDir: mode === 'drift' ? 1 : 0,
        driftTime: 1, gripBlend: 1, modeTimer: 0, reverseHold: 0, wheelSpin: 0,
        speed, forwardSpeed: speed * Math.cos(slip), lateralSpeed: -speed * Math.sin(slip), slip, rpm: 0.7,
      };
    },
  };
}

function mesh(root: THREE.Object3D, name: string): THREE.Mesh {
  const found = root.getObjectByName(name);
  if (!(found instanceof THREE.Mesh)) throw new Error(`no mesh named ${name}`);
  return found;
}

const skidQuads = (scene: THREE.Scene) => mesh(scene, 'fx-skidmarks').geometry.drawRange.count / 6;
const live = (scene: THREE.Scene, name: string) =>
  (mesh(scene, name).geometry as THREE.InstancedBufferGeometry).instanceCount;

/** Longest edge of any written skid quad, m. */
function longestSkidEdge(scene: THREE.Scene): number {
  const pos = mesh(scene, 'fx-skidmarks').geometry.getAttribute('position');
  let worst = 0;
  for (let q = 0; q < skidQuads(scene); q++) {
    for (let k = 0; k < 4; k++) {
      const a = q * 4 + k;
      const b = q * 4 + ((k + 1) % 4);
      worst = Math.max(worst, Math.hypot(pos.getX(a) - pos.getX(b), pos.getZ(a) - pos.getZ(b)));
    }
  }
  return worst;
}

describe('fx', () => {
  it('lays skid marks and smoke while drifting', () => {
    const scene = new THREE.Scene();
    const fx = createFx(scene);
    const car = makeDriver(20, 0.6, 'drift');
    for (let i = 0; i < 120; i++) fx.update(car.step(DT), 'road', DT);
    expect(skidQuads(scene)).toBeGreaterThan(20);
    expect(live(scene, 'fx-smoke')).toBeGreaterThan(10);
    expect(longestSkidEdge(scene)).toBeLessThan(3);
    const pos = mesh(scene, 'fx-skidmarks').geometry.getAttribute('position');
    expect(pos.getY(0)).toBeCloseTo(0.07, 5);
  });

  it('leaves no marks or smoke when gripping', () => {
    const scene = new THREE.Scene();
    const fx = createFx(scene);
    const car = makeDriver(20, 0, 'grip', 200);
    for (let i = 0; i < 120; i++) fx.update(car.step(DT), 'road', DT);
    expect(skidQuads(scene)).toBe(0);
    expect(live(scene, 'fx-smoke')).toBe(0);
  });

  it('does not mark the ground outside the barriers', () => {
    const scene = new THREE.Scene();
    const fx = createFx(scene);
    const car = makeDriver(20, 0.6, 'drift');
    for (let i = 0; i < 60; i++) fx.update(car.step(DT), 'outside', DT);
    expect(skidQuads(scene)).toBe(0);
  });

  it('freezes while dt is 0 (pause)', () => {
    const scene = new THREE.Scene();
    const fx = createFx(scene);
    const car = makeDriver(20, 0.6, 'drift');
    for (let i = 0; i < 30; i++) fx.update(car.step(DT), 'road', DT);
    const quads = skidQuads(scene);
    const smoke = live(scene, 'fx-smoke');
    for (let i = 0; i < 30; i++) fx.update(car.state(), 'road', 0);
    expect(skidQuads(scene)).toBe(quads);
    expect(live(scene, 'fx-smoke')).toBe(smoke);
  });

  it('breaks the trails on respawn and on teleports', () => {
    const scene = new THREE.Scene();
    const fx = createFx(scene);
    const car = makeDriver(20, 0.6, 'drift');
    for (let i = 0; i < 60; i++) fx.update(car.step(DT), 'road', DT);
    fx.onEvent({ type: 'respawn' });
    car.teleport(car.state().x + 2, car.state().z);
    const before = skidQuads(scene);
    fx.update(car.state(), 'road', DT);
    expect(skidQuads(scene)).toBe(before);
    car.teleport(200, 200);
    for (let i = 0; i < 60; i++) fx.update(car.step(DT), 'road', DT);
    expect(skidQuads(scene)).toBeGreaterThan(before);
    expect(longestSkidEdge(scene)).toBeLessThan(3);
  });

  it('keeps skid marks within the ring buffer', () => {
    const scene = new THREE.Scene();
    const fx = createFx(scene);
    const car = makeDriver(30, 0.7, 'drift', 40);
    for (let i = 0; i < 60 * 90; i++) fx.update(car.step(DT), 'road', DT);
    const geo = mesh(scene, 'fx-skidmarks').geometry;
    const index = geo.getIndex();
    expect(index).not.toBeNull();
    expect(geo.drawRange.count).toBe(index?.count);
    expect(live(scene, 'fx-smoke')).toBeLessThanOrEqual(200);
    expect(longestSkidEdge(scene)).toBeLessThan(3);
  });

  it('keeps every skid quad written between two renders queued for upload (several updates per frame)', () => {
    const scene = new THREE.Scene();
    const fx = createFx(scene);
    const car = makeDriver(20, 0.6, 'drift');
    const attrs = (['position', 'color'] as const).map((k) => mesh(scene, 'fx-skidmarks').geometry.getAttribute(k));
    /** Element indices [lo, hi) covered by the pending update ranges of `a`. */
    const covered = (a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute) => {
      const ranges = (a as THREE.BufferAttribute).updateRanges.map((r) => [r.start, r.start + r.count]).sort((p, q) => p[0] - q[0]);
      let hi = 0;
      for (const [s, e] of ranges) if (s <= hi) hi = Math.max(hi, e);
      return hi;
    };
    /** What three does after uploading an attribute: clear its ranges, then call onUpload. */
    const upload = () => {
      for (const a of attrs) {
        (a as THREE.BufferAttribute).clearUpdateRanges();
        (a as THREE.BufferAttribute).onUploadCallback();
      }
    };
    // One fx.update per fixed step (120 Hz) and no render in between: no quad may be dropped.
    for (let i = 0; i < 240; i++) fx.update(car.step(DT / 2), 'road', DT / 2);
    const quads = skidQuads(scene);
    expect(quads).toBeGreaterThan(20);
    expect(covered(attrs[0])).toBe(quads * 12);
    expect(covered(attrs[1])).toBe(quads * 16);

    // After an upload only the newer quads are queued.
    upload();
    for (let i = 0; i < 20; i++) fx.update(car.step(DT / 2), 'road', DT / 2);
    const ranges = (attrs[0] as THREE.BufferAttribute).updateRanges;
    expect(ranges.length).toBeGreaterThan(0);
    expect(Math.min(...ranges.map((r) => r.start))).toBe(quads * 12);

    // reset() drops the queue: new marks start at slot 0 and are queued from there.
    fx.reset();
    for (let i = 0; i < 60; i++) fx.update(car.step(DT), 'road', DT);
    expect(covered(attrs[0])).toBe(skidQuads(scene) * 12);
  });

  it('bursts sparks on hits and gold on coins, then clears', () => {
    const scene = new THREE.Scene();
    const fx = createFx(scene);
    const car = makeDriver(0, 0, 'grip');
    fx.onEvent({ type: 'hit', impactSpeed: 9, x: 1, z: 2 });
    fx.update(car.state(), 'road', DT);
    const sparks = live(scene, 'fx-bursts');
    expect(sparks).toBeGreaterThan(5);
    fx.onEvent({ type: 'coin', id: 0, x: 0, z: 0 });
    fx.update(car.state(), 'road', DT);
    expect(live(scene, 'fx-bursts')).toBeGreaterThan(sparks);
    for (let i = 0; i < 120; i++) fx.update(car.state(), 'road', DT);
    expect(live(scene, 'fx-bursts')).toBe(0);
  });

  it('a bomb flashes, bursts sparks and rolls up smoke', () => {
    const scene = new THREE.Scene();
    const fx = createFx(scene);
    fx.onEvent({ type: 'bomb', id: 'b', x: 1, z: 2 });
    fx.update(makeDriver(0, 0, 'grip').state(), 'road', DT);
    expect(live(scene, 'fx-bursts')).toBeGreaterThanOrEqual(30);
    expect(live(scene, 'fx-smoke')).toBeGreaterThanOrEqual(8);
  });

  it('reset clears marks, smoke and bursts', () => {
    const scene = new THREE.Scene();
    const fx = createFx(scene);
    const car = makeDriver(20, 0.6, 'drift');
    for (let i = 0; i < 60; i++) fx.update(car.step(DT), 'road', DT);
    fx.onEvent({ type: 'hit', impactSpeed: 9, x: 1, z: 2 });
    fx.reset();
    expect(skidQuads(scene)).toBe(0);
    expect(live(scene, 'fx-smoke')).toBe(0);
    expect(live(scene, 'fx-bursts')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Props layer
// ---------------------------------------------------------------------------

const NO_ASSETS: AssetLibrary = { create: () => null };

function propTrack() {
  const lightProps: LightPropSpot[] = [
    { id: 'can-1', kind: 'can', x: 0, z: 10, r: 0.5, heading: 0 },
    { id: 'cup-1', kind: 'cup', x: 0, z: 20, r: 0.6, heading: 0.4 },
  ];
  const coins = [0, 1, 2].map((id) => ({ id, x: 0, z: 30 + id * 6 }));
  return makeCircleTrack(100, { coins, lightProps });
}

/** Zero-scale instance: the whole 3x3 rotation/scale block is zero. */
const isHidden = (m: THREE.Matrix4) => [0, 1, 2, 4, 5, 6, 8, 9, 10].every((i) => Math.abs(m.elements[i]) < 1e-9);

function instanceMatrix(group: THREE.Object3D, name: string, index: number): THREE.Matrix4 {
  const m = mesh(group, name);
  if (!(m instanceof THREE.InstancedMesh)) throw new Error(`${name} is not instanced`);
  const out = new THREE.Matrix4();
  m.getMatrixAt(index, out);
  return out;
}

function pickups(coins: number[], props: string[]): PickupState {
  return { ...createPickups(), coinsTaken: new Set(coins), propsKnocked: new Set(props) };
}

describe('props layer', () => {
  it('builds instanced coins and props (fallback geometry without assets)', () => {
    const layer = createPropsLayer(propTrack(), NO_ASSETS);
    const coins = mesh(layer.group, 'coins');
    expect(coins).toBeInstanceOf(THREE.InstancedMesh);
    expect((coins as THREE.InstancedMesh).count).toBe(3);
    expect(coins.frustumCulled).toBe(false);
    expect(mesh(layer.group, 'props-can-0').frustumCulled).toBe(false);
    expect(mesh(layer.group, 'props-cup-0')).toBeInstanceOf(THREE.InstancedMesh);
  });

  it('hides taken coins with a zero-scale matrix and spins the rest', () => {
    const layer = createPropsLayer(propTrack(), NO_ASSETS);
    layer.update(pickups([1], []), 0, DT);
    expect(isHidden(instanceMatrix(layer.group, 'coins', 1))).toBe(true);
    const a = instanceMatrix(layer.group, 'coins', 0);
    expect(isHidden(a)).toBe(false);
    layer.update(pickups([1], []), 0.5, DT);
    expect(instanceMatrix(layer.group, 'coins', 0).equals(a)).toBe(false);
  });

  it('flies a knocked prop on an arc, lands it above ground, fades it and restores it on resetLap', () => {
    const layer = createPropsLayer(propTrack(), NO_ASSETS);
    layer.update(createPickups(), 0, DT);
    const rest = instanceMatrix(layer.group, 'props-can-0', 0);
    layer.onEvent({ type: 'propKnocked', id: 'can-1', kind: 'can', x: 0, z: 10, vx: 24, vz: 0 });
    const flight = layer.group.getObjectByName('flight-can-1');
    if (!flight) throw new Error('no flight object');
    /** Idle flight clones are parked far below the ground at zero scale. */
    const parked = () => flight.matrix.elements[13] < -1000 && flight.matrix.elements[0] === 0;
    expect(parked()).toBe(false);
    const box = new THREE.Box3();
    let maxY = 0;
    let lowest = Infinity;
    let t = 0;
    for (; t < 0.8; t += DT) {
      layer.update(pickups([], ['can-1']), t, DT);
      expect(isHidden(instanceMatrix(layer.group, 'props-can-0', 0))).toBe(true);
      expect(parked()).toBe(false);
      layer.group.updateMatrixWorld(true);
      box.setFromObject(flight, true);
      maxY = Math.max(maxY, box.min.y);
      lowest = Math.min(lowest, box.min.y);
    }
    expect(maxY).toBeGreaterThan(0.5);
    expect(lowest).toBeGreaterThan(-0.05);
    for (; t < 5; t += DT) layer.update(pickups([], ['can-1']), t, DT);
    expect(parked()).toBe(true);
    expect(isHidden(instanceMatrix(layer.group, 'props-can-0', 0))).toBe(true);
    layer.resetLap();
    layer.update(createPickups(), t, DT);
    expect(instanceMatrix(layer.group, 'props-can-0', 0).equals(rest)).toBe(true);
  });

  it('ignores events for unknown props and other event types', () => {
    const layer = createPropsLayer(propTrack(), NO_ASSETS);
    layer.onEvent({ type: 'propKnocked', id: 'nope', kind: 'can', x: 0, z: 0, vx: 1, vz: 1 });
    layer.onEvent({ type: 'coin', id: 0, x: 0, z: 30 });
    layer.update(createPickups(), 0, DT);
    expect(isHidden(instanceMatrix(layer.group, 'props-can-0', 0))).toBe(false);
    expect(layer.group.getObjectByName('flight-can-1')?.matrix.elements[13]).toBeLessThan(-1000);
  });
});
