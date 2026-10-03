/**
 * Coins and light knockable props (plan Task 12; design spec §2.5 and §5 rendering rules).
 *
 * - Coins: one InstancedMesh (gold disc r 0.9, 0.18 thick, standing upright, emissive rim) spinning
 *   and bobbing in place. A taken coin gets a zero-scale matrix.
 * - Cans / cups: one InstancedMesh per (kind, model variant) and source mesh; the meshes of a batch
 *   share one instance-matrix attribute. Models come from the AssetLibrary, a procedural cylinder
 *   stands in when a model is missing. All instanced meshes have frustumCulled = false.
 * - A knocked prop hides its instance and shows a pre-built clone that flies a kinematic arc (event
 *   velocity + LAUNCH_UP), tumbles about the axis across its travel, bounces, settles on its side or
 *   end, rests, then fades out (the clone owns its transparent materials). The instance comes back
 *   on resetLap() or when a new lap's PickupState no longer lists the prop. Idle clones stay `visible`
 *   but are parked (zero scale, far below the ground, so always frustum-culled): renderer.compile()
 *   during loading then prepares their transparent program and the first knock does not hitch.
 *
 * update() does not allocate. Geometry and textures handed out by the AssetLibrary are shared and
 * are never mutated or disposed here.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { GameEvent, LightPropSpot } from '../shared/types';
import type { PickupState } from '../game/pickups';
import type { Track } from '../track/build';
import type { AssetLibrary } from '../core/assets';
import { CATALOG } from './catalog';
import { clamp, damp } from '../shared/math';

export interface PropsLayer {
  group: THREE.Group;
  /** Hide taken coins / knocked props; spin coins; animate knocked props along a kinematic arc + tumble, fade after landing. */
  update(pickups: PickupState, time: number, dt: number): void;
  /** 'propKnocked' starts an arc with the event velocity (+ upward LAUNCH_UP m/s); other events are ignored. */
  onEvent(e: GameEvent): void;
  /** All props back to rest pose (in-flight props vanish). */
  resetLap(): void;
}

// ---- Visual-only constants (not gameplay tuning) ----
const COIN_RADIUS = 0.9;
const COIN_THICKNESS = 0.18;
const COIN_SEGMENTS = 20;
/** Coin centre height above the plaza, m (fx.ts spawns the pickup burst here). */
export const COIN_CENTER_Y = 1.25;
const COIN_BOB = 0.12;
/** Bob and spin rates, rad/s; each coin gets a phase offset so the row does not move in lockstep. */
const COIN_BOB_RATE = 2.4;
const COIN_SPIN_RATE = 2.6;
const COIN_PHASE_STEP = 0.7;
/** Props stand on the road layer (design spec §5 ground layers). */
const PROP_BASE_Y = 0.04;
const LAUNCH_UP = 6;
const GRAVITY = 16;
/** Horizontal air drag while flying and sliding friction after landing, 1/s. */
const AIR_DRAG = 1.2;
const SLIDE_FRICTION = 8;
/** Bounce: vertical restitution and the share of horizontal / spin speed kept. */
const BOUNCE = 0.35;
const BOUNCE_KEEP = 0.55;
/** A landing slower than this (m/s) ends the bounces. */
const SETTLE_SPEED = 1.5;
/** Tumble rate = horizontal speed x TUMBLE_PER_SPEED, clamped, rad/s. */
const TUMBLE_PER_SPEED = 0.5;
const TUMBLE_MIN = 5;
const TUMBLE_MAX = 14;
/** Easing rate toward the nearest flat pose after landing, 1/s. */
const SETTLE_RATE = 10;
const REST_TIME = 0.6;
const FADE_TIME = 0.5;
const MAX_DT = 0.1;

const COIN_COLORS = {
  rim: { color: 0xf2a91f, emissive: 0xff9a1a, intensity: 0.55 },
  face: { color: 0xffc933, emissive: 0x8a5a00, intensity: 0.35 },
  boss: { color: 0xffe066, emissive: 0x8a6400, intensity: 0.35 },
};
/** Fallback prop looks: [radius top, radius bottom, height, colour]. Heights match the catalog (x12). */
const FALLBACK: Record<LightPropSpot['kind'], [number, number, number, number]> = {
  can: [0.5, 0.5, 1.5, 0xe2483d],
  cup: [0.55, 0.4, 1.8, 0xf3efe6],
};

const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);
const ZERO_SCALE = new THREE.Matrix4().makeScale(0, 0, 0);
const PARKED = new THREE.Matrix4().makeScale(0, 0, 0).setPosition(0, -1e4, 0);

interface Batch {
  meshes: THREE.InstancedMesh[];
  matrices: THREE.InstancedBufferAttribute;
  used: number;
}

interface Flight {
  root: THREE.Object3D;
  materials: THREE.Material[];
  /** Half height and radius of the prop's bounds, m (ground clearance while tumbling). */
  half: number;
  radius: number;
  active: boolean;
  landed: boolean;
  timer: number;
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  axis: THREE.Vector3;
  theta: number;
  omega: number;
}

interface PropSlot {
  spot: LightPropSpot;
  batch: Batch;
  index: number;
  rest: THREE.Matrix4;
  /** Rest instance currently visible. */
  shown: boolean;
  flight: Flight;
}

function goldMaterial(c: { color: number; emissive: number; intensity: number }): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color: c.color, emissive: c.emissive, emissiveIntensity: c.intensity, flatShading: true });
}

/** Upright coin facing ±Z: groups 0 = rim, 1 = faces, 2 = raised centre boss. */
function createCoinGeometry(): THREE.BufferGeometry {
  const half = COIN_THICKNESS / 2;
  const rim = new THREE.CylinderGeometry(COIN_RADIUS, COIN_RADIUS, COIN_THICKNESS, COIN_SEGMENTS, 1, true);
  const top = new THREE.CircleGeometry(COIN_RADIUS, COIN_SEGMENTS).rotateX(-Math.PI / 2).translate(0, half, 0);
  const bottom = new THREE.CircleGeometry(COIN_RADIUS, COIN_SEGMENTS).rotateX(Math.PI / 2).translate(0, -half, 0);
  const faces = mergeGeometries([top, bottom]);
  const boss = new THREE.CylinderGeometry(COIN_RADIUS * 0.62, COIN_RADIUS * 0.62, COIN_THICKNESS + 0.08, COIN_SEGMENTS);
  const merged = mergeGeometries([rim, faces, boss], true);
  for (const g of [rim, top, bottom, faces, boss]) g.dispose();
  return merged.rotateX(Math.PI / 2);
}

type FallbackCache = Map<LightPropSpot['kind'], THREE.BufferGeometry>;

/** Asset model, or a procedural cylinder (origin at ground centre) when the model is missing. */
function createVisual(assets: AssetLibrary, kind: LightPropSpot['kind'], variant: number, cache: FallbackCache): THREE.Object3D {
  const model = assets.create(kind, variant);
  if (model) return model;
  const [rt, rb, h, color] = FALLBACK[kind];
  let geo = cache.get(kind);
  if (!geo) {
    geo = new THREE.CylinderGeometry(rt, rb, h, 14).translate(0, h / 2, 0);
    cache.set(kind, geo);
  }
  const root = new THREE.Group();
  root.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color, flatShading: true })));
  return root;
}

function meshesOf(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) out.push(o);
  });
  return out;
}

/** One InstancedMesh per source mesh (asset meshes have identity transforms), sharing one matrix attribute. */
function createBatch(visual: THREE.Object3D, count: number, name: string, group: THREE.Group): Batch {
  const matrices = new THREE.InstancedBufferAttribute(new Float32Array(count * 16), 16);
  const meshes = meshesOf(visual).map((src, k) => {
    const mesh = new THREE.InstancedMesh(src.geometry, src.material, count);
    mesh.instanceMatrix = matrices;
    mesh.name = k === 0 ? name : `${name}#${k}`;
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    group.add(mesh);
    return mesh;
  });
  return { meshes, matrices, used: 0 };
}

function createFlight(visual: THREE.Object3D, name: string, group: THREE.Group): Flight {
  const size = new THREE.Box3().setFromObject(visual).getSize(new THREE.Vector3());
  const materials: THREE.Material[] = [];
  for (const mesh of meshesOf(visual)) {
    mesh.castShadow = true;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      m.transparent = true;
      materials.push(m);
    }
  }
  visual.name = name;
  visual.matrixAutoUpdate = false;
  visual.matrix.copy(PARKED);
  group.add(visual);
  return {
    root: visual, materials, half: size.y / 2, radius: Math.max(size.x, size.z) / 2,
    active: false, landed: false, timer: 0, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0,
    axis: new THREE.Vector3(1, 0, 0), theta: 0, omega: 0,
  };
}

/** Lowest point of a cylinder tilted by theta, below its centre. */
const clearance = (f: Flight, theta: number) => f.half * Math.abs(Math.cos(theta)) + f.radius * Math.abs(Math.sin(theta));

function setOpacity(f: Flight, opacity: number): void {
  for (const m of f.materials) m.opacity = opacity;
}

export function createPropsLayer(track: Track, assets: AssetLibrary): PropsLayer {
  const group = new THREE.Group();
  group.name = 'props';

  // ---- Coins ----
  const coins = track.coins;
  const coinMesh = new THREE.InstancedMesh(
    createCoinGeometry(),
    [goldMaterial(COIN_COLORS.rim), goldMaterial(COIN_COLORS.face), goldMaterial(COIN_COLORS.boss)],
    coins.length,
  );
  coinMesh.name = 'coins';
  coinMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  coinMesh.frustumCulled = false;
  coinMesh.castShadow = true;
  group.add(coinMesh);

  // ---- Light props: one batch per (kind, variant) ----
  const batches = new Map<string, Batch>();
  const fallback: FallbackCache = new Map();
  const ordinal = { can: 0, cup: 0 };
  const variantOf = track.lightProps.map((spot) => ordinal[spot.kind]++ % (CATALOG[spot.kind].files?.length ?? 1));
  const slots: PropSlot[] = track.lightProps.map((spot, i) => {
    const key = `${spot.kind}-${variantOf[i]}`;
    let batch = batches.get(key);
    if (!batch) {
      const count = variantOf.filter((v, j) => v === variantOf[i] && track.lightProps[j].kind === spot.kind).length;
      batch = createBatch(createVisual(assets, spot.kind, variantOf[i], fallback), count, `props-${key}`, group);
      batches.set(key, batch);
    }
    const rest = new THREE.Matrix4().makeRotationY(spot.heading).setPosition(spot.x, PROP_BASE_Y, spot.z);
    const index = batch.used++;
    rest.toArray(batch.matrices.array, index * 16);
    const flight = createFlight(createVisual(assets, spot.kind, variantOf[i], fallback), `flight-${spot.id}`, group);
    return { spot, batch, index, rest, shown: true, flight };
  });
  const slotById = new Map(slots.map((s) => [s.spot.id, s]));

  // Scratch objects (update() must not allocate).
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const mat = new THREE.Matrix4();
  const tmp = new THREE.Matrix4();

  function showRest(slot: PropSlot, show: boolean): void {
    if (slot.shown === show) return;
    slot.shown = show;
    (show ? slot.rest : ZERO_SCALE).toArray(slot.batch.matrices.array, slot.index * 16);
    slot.batch.matrices.needsUpdate = true;
  }

  function stopFlight(f: Flight): void {
    f.active = false;
    f.root.matrix.copy(PARKED);
    f.root.matrixWorldNeedsUpdate = true;
  }

  function advance(slot: PropSlot, dt: number): void {
    const f = slot.flight;
    if (!f.landed) {
      const drag = Math.exp(-AIR_DRAG * dt);
      f.vx *= drag;
      f.vz *= drag;
      f.vy -= GRAVITY * dt;
      f.theta += f.omega * dt;
    } else {
      const friction = Math.exp(-SLIDE_FRICTION * dt);
      f.vx *= friction;
      f.vz *= friction;
      const flat = Math.round(f.theta / (Math.PI / 2)) * (Math.PI / 2);
      f.theta += (flat - f.theta) * damp(SETTLE_RATE, dt);
      f.timer += dt;
    }
    f.px += f.vx * dt;
    f.py += f.vy * dt;
    f.pz += f.vz * dt;
    const floor = PROP_BASE_Y + clearance(f, f.theta);
    if (f.landed || f.py <= floor) {
      f.py = floor;
      if (!f.landed && f.vy < 0) {
        if (-f.vy > SETTLE_SPEED) {
          f.vy *= -BOUNCE;
          f.vx *= BOUNCE_KEEP;
          f.vz *= BOUNCE_KEEP;
          f.omega *= BOUNCE_KEEP;
        } else {
          f.landed = true;
          f.vy = 0;
        }
      }
    }
    if (f.timer > REST_TIME) {
      const opacity = 1 - (f.timer - REST_TIME) / FADE_TIME;
      if (opacity <= 0) return stopFlight(f);
      setOpacity(f, opacity);
    }
    // root = T(p) * R(axis, theta) * R_y(heading) * T(0, -half, 0): tumble about the prop's centre.
    mat.makeTranslation(0, -f.half, 0);
    mat.premultiply(tmp.makeRotationY(slot.spot.heading));
    mat.premultiply(tmp.makeRotationAxis(f.axis, f.theta));
    mat.premultiply(tmp.makeTranslation(f.px, f.py, f.pz));
    f.root.matrix.copy(mat);
    f.root.matrixWorldNeedsUpdate = true;
  }

  function launch(slot: PropSlot, vx: number, vz: number): void {
    const f = slot.flight;
    const speed = Math.hypot(vx, vz);
    // Rolling forward: axis = up x travel direction.
    if (speed > 1e-3) f.axis.set(vz / speed, 0, -vx / speed);
    else f.axis.set(1, 0, 0);
    f.omega = clamp(speed * TUMBLE_PER_SPEED, TUMBLE_MIN, TUMBLE_MAX);
    f.theta = 0;
    f.px = slot.spot.x;
    f.py = PROP_BASE_Y + f.half;
    f.pz = slot.spot.z;
    f.vx = vx;
    f.vy = LAUNCH_UP;
    f.vz = vz;
    f.timer = 0;
    f.landed = false;
    f.active = true;
    setOpacity(f, 1);
    showRest(slot, false);
    advance(slot, 0);
  }

  return {
    group,
    update(pickups: PickupState, time: number, dt: number): void {
      for (let i = 0; i < coins.length; i++) {
        const coin = coins[i];
        if (pickups.coinsTaken.has(coin.id)) {
          coinMesh.setMatrixAt(i, ZERO_SCALE);
          continue;
        }
        const phase = coin.id * COIN_PHASE_STEP;
        pos.set(coin.x, COIN_CENTER_Y + Math.sin(time * COIN_BOB_RATE + phase) * COIN_BOB, coin.z);
        quat.setFromAxisAngle(UP, time * COIN_SPIN_RATE + phase);
        coinMesh.setMatrixAt(i, mat.compose(pos, quat, ONE));
      }
      coinMesh.instanceMatrix.needsUpdate = true;

      const step = clamp(dt, 0, MAX_DT);
      for (const slot of slots) {
        if (slot.flight.active) advance(slot, step);
        showRest(slot, !slot.flight.active && !pickups.propsKnocked.has(slot.spot.id));
      }
    },
    onEvent(e: GameEvent): void {
      if (e.type !== 'propKnocked') return;
      const slot = slotById.get(e.id);
      if (slot) launch(slot, e.vx, e.vz);
    },
    resetLap(): void {
      for (const slot of slots) {
        stopFlight(slot.flight);
        showRest(slot, true);
      }
    },
  };
}
