/**
 * Race FX (plan Task 12): tyre smoke, skid marks, hit/scrape sparks and coin bursts.
 * - Smoke / bursts: pooled camera-facing quads, one instanced draw each (unlit ShaderMaterial, per-instance
 *   position, colour+alpha, size; bursts stretch along screen-space velocity). Live particles are packed to the
 *   front of the buffers: instanceCount = live count, only that range is uploaded. depthWrite false.
 * - Skid marks: ring buffer of SKID_CAPACITY quads shared by the rear wheel pair (preallocated, DynamicDrawUsage,
 *   addUpdateRange per frame, y 0.07, polygonOffset, depthWrite false). Each rear wheel lays a continuous strip
 *   while sliding; grip, 'respawn' or a teleport break it.
 * Transparent draw order: skid marks (-2), particles (-1), then other transparents (fading occluders blend over).
 * Idle meshes stay visible with an empty draw range (frustumCulled false), so renderer.compile() during loading
 * prepares their programs. update() / onEvent() do not allocate; dt <= 0 (pause) freezes everything.
 */
import * as THREE from 'three';
import type { CarState, GameEvent, SurfaceKind } from '../shared/types';
import { TUNING } from '../shared/tuning';
import { DEG, TAU, clamp, damp, seededRandom } from '../shared/math';
import { COIN_CENTER_Y } from './props';

export interface Fx {
  /** Smoke from rear wheels when drifting or hard braking; skid marks while sliding. `car` = render state. */
  update(car: CarState, surface: SurfaceKind, dt: number): void;
  /** 'hit' → spark burst; 'scrape' → a few sparks; 'coin' → gold burst; 'respawn' → break skid trails. */
  onEvent(e: GameEvent): void;
  /** Remove all particles and skid marks. */
  reset(): void;
}

// ---- Visual-only constants (not gameplay tuning) ----
const SMOKE_CAPACITY = 200;
const BURST_CAPACITY = 192;
/** Skid-mark quads shared by both rear wheels (ring buffer). */
const SKID_CAPACITY = 2000;
const SKID_Y = 0.07;
const SKID_HALF_WIDTH = 0.2;
/** Minimum strip segment, m; a wheel jump longer than SKID_BREAK (teleport) starts a new strip. */
const SKID_SEGMENT = 0.45;
const SKID_BREAK = 4;
/** Slide intensity needed to mark, peak mark alpha, and mark strength per surface. */
const SKID_MIN = 0.12;
const SKID_ALPHA = 0.55;
const SKID_SURFACE: Record<SurfaceKind, number> = { road: 1, curb: 1, runoff: 0.6, outside: 0 };
/** Rear contact patches in car space: half track (+ = left) and axle offset (+ = forward), m. */
const REAR_HALF_TRACK = TUNING.car.width / 2 - 0.22;
const REAR_AXLE = -TUNING.car.wheelBase / 2;
/** Slide intensity ramps: drift slip (rad), lateral speed (m/s), car speed (m/s). */
const SLIP_RAMP = [6 * DEG, 30 * DEG] as const;
const LAT_RAMP = [3, 9] as const;
const SPEED_RAMP = [4, 12] as const;
/** Smoothed deceleration above this share of car.brakeDecel counts as hard braking (smoothing 1/s). */
const BRAKE_SHARE = 0.55;
const BRAKE_INTENSITY = 0.6;
const DECEL_SMOOTHING = 12;
/** Smoke puffs per second per rear wheel at full intensity, and the intensity needed to smoke. */
const SMOKE_RATE = 34;
const SMOKE_MIN = 0.15;
/** Burst streak length = size + screen speed x BURST_STRETCH (motion blur), m per m/s. */
const BURST_STRETCH = 0.06;
const MAX_DT = 0.1;
/** Skid-mark and particle colours (read-only). */
const C = {
  skid: new THREE.Color(0x26232a), smoke: new THREE.Color(0xf4f2f5), dust: new THREE.Color(0xe6dccb), hot: new THREE.Color(0xffd84a),
  cool: new THREE.Color(0xff5a0a), gold: new THREE.Color(0xffcf3a), pale: new THREE.Color(0xfff3c4),
};

/** Particle look: random life (s), start size (m) and growth factor ranges; drag 1/s; gravity m/s^2 (< 0 rises). */
type Range = [number, number];
type Preset = { life: Range; size: Range; grow: Range; drag: number; gravity: number };
const SMOKE: Preset = { life: [0.9, 1.5], size: [0.8, 1.3], grow: [2.6, 3.8], drag: 2.2, gravity: -0.5 };
const SPARK: Preset = { life: [0.25, 0.6], size: [0.2, 0.32], grow: [1, 1], drag: 1.5, gravity: 22 };
const SPARKLE: Preset = { life: [0.45, 0.75], size: [0.34, 0.42], grow: [0.6, 0.6], drag: 2.5, gravity: 8 };
const FLASH: Preset = { life: [0.26, 0.26], size: [1.2, 1.2], grow: [3.2, 3.2], drag: 0, gravity: 0 };

const VERT = /* glsl */ `
attribute vec3 iPos; attribute vec4 iColor; attribute float iSize;
#ifdef STRETCH
attribute vec3 iVel; uniform float uStretch;
#endif
varying vec2 vUv; varying vec4 vColor;
void main() {
  vUv = uv; vColor = iColor;
  vec3 p = iPos;
#ifdef SOFT
  p.y = max(p.y, iSize * 0.45); // growing puffs rise so the ground never clips them with a hard line
#endif
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec2 dir = vec2(1.0, 0.0); float len = iSize;
#ifdef STRETCH
  vec2 v = (modelViewMatrix * vec4(iVel, 0.0)).xy;
  float speed = length(v); if (speed > 1e-3) dir = v / speed;
  len += uStretch * speed;
#endif
  mv.xy += dir * position.x * len + vec2(-dir.y, dir.x) * position.y * iSize;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
varying vec2 vUv; varying vec4 vColor;
void main() {
  float r = length(vUv - 0.5) * 2.0;
#ifdef SOFT
  float a = 1.0 - smoothstep(0.2, 1.0, r);
  vec3 rgb = vColor.rgb * mix(0.92, 1.0, vUv.y);
#else
  float a = 1.0 - smoothstep(0.3, 1.0, r);
  vec3 rgb = mix(vColor.rgb, vec3(1.0), (1.0 - r) * (1.0 - r) * 0.6);
#endif
  a *= vColor.a; if (a < 0.004) discard;
  gl_FragColor = vec4(rgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// Per-particle state layout in ParticlePool.state.
const X = 0, V = 3, AGE = 6, LIFE = 7, S0 = 8, S1 = 9, ALPHA = 10, DRAG = 11, GRAV = 12, RGB = 13, STRIDE = 16;

class ParticlePool {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private readonly state: Float32Array;
  /** Instance attributes: iPos (3), iColor (rgb + alpha), iSize (1) and, for streaks, iVel (3). */
  private readonly attrs: THREE.InstancedBufferAttribute[];
  private readonly arrays: Float32Array[];
  private readonly capacity: number;
  /** Fraction of the life spent fading in (0 = full alpha at birth). */
  private readonly fadeIn: number;
  private readonly rand: () => number;
  private next = 0;
  private dirty = false;

  constructor(name: string, capacity: number, fadeIn: number, stretch: boolean, rand: () => number) {
    this.capacity = capacity;
    this.fadeIn = fadeIn;
    this.rand = rand;
    this.state = new Float32Array(capacity * STRIDE);
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex(quad.getIndex());
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    const layout: [string, number][] = [['iPos', 3], ['iColor', 4], ['iSize', 1]];
    if (stretch) layout.push(['iVel', 3]);
    this.arrays = layout.map(([, size]) => new Float32Array(capacity * size));
    this.attrs = layout.map(([key, size], i) => {
      const attr = new THREE.InstancedBufferAttribute(this.arrays[i], size).setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(key, attr);
      return attr;
    });
    geo.instanceCount = 0;
    const material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false,
      defines: stretch ? { STRETCH: '' } : { SOFT: '' },
      uniforms: stretch ? { uStretch: { value: BURST_STRETCH } } : {},
    });
    this.mesh = Object.assign(new THREE.Mesh(geo, material), { name, frustumCulled: false, renderOrder: -1 });
  }

  /** Spawns one particle (recycling the oldest slot when full); look randomised within `p`. */
  spawn(p: Preset, x: number, y: number, z: number, vx: number, vy: number, vz: number, alpha: number, color: THREE.Color): void {
    const s = this.state;
    const o = this.next * STRIDE;
    this.next = (this.next + 1) % this.capacity;
    const r = this.rand;
    s[o + X] = x; s[o + X + 1] = y; s[o + X + 2] = z;
    s[o + V] = vx; s[o + V + 1] = vy; s[o + V + 2] = vz;
    s[o + LIFE] = p.life[0] + (p.life[1] - p.life[0]) * r();
    s[o + S0] = p.size[0] + (p.size[1] - p.size[0]) * r();
    s[o + S1] = s[o + S0] * (p.grow[0] + (p.grow[1] - p.grow[0]) * r());
    s[o + AGE] = 0; s[o + ALPHA] = alpha; s[o + DRAG] = p.drag; s[o + GRAV] = p.gravity;
    s[o + RGB] = color.r; s[o + RGB + 1] = color.g; s[o + RGB + 2] = color.b;
    this.dirty = true;
  }

  /** Integrates live particles and packs them into the instance buffers. */
  update(dt: number): void {
    if (!this.dirty && !(dt > 0)) return;
    this.dirty = false;
    const s = this.state;
    const arr = this.arrays, pos = arr[0], col = arr[1], size = arr[2], vel = arr.length > 3 ? arr[3] : null;
    let n = 0;
    for (let o = 0; o < s.length; o += STRIDE) {
      if (s[o + AGE] >= s[o + LIFE]) continue;
      s[o + AGE] += dt;
      if (s[o + AGE] >= s[o + LIFE]) continue;
      const keep = Math.exp(-s[o + DRAG] * dt);
      s[o + V] *= keep; s[o + V + 2] *= keep;
      s[o + V + 1] = s[o + V + 1] * keep - s[o + GRAV] * dt;
      for (let k = 0; k < 3; k++) {
        s[o + X + k] += s[o + V + k] * dt;
        pos[n * 3 + k] = s[o + X + k];
        col[n * 4 + k] = s[o + RGB + k];
        if (vel) vel[n * 3 + k] = s[o + V + k];
      }
      const t = s[o + AGE] / s[o + LIFE];
      const fadeIn = this.fadeIn > 0 ? Math.min(1, t / this.fadeIn) : 1;
      col[n * 4 + 3] = s[o + ALPHA] * fadeIn * (1 - t) * Math.sqrt(1 - t);
      size[n] = s[o + S0] + (s[o + S1] - s[o + S0]) * (1 - (1 - t) * (1 - t));
      n++;
    }
    this.mesh.geometry.instanceCount = n;
    if (n === 0) return;
    for (const a of this.attrs) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * a.itemSize);
      a.needsUpdate = true;
    }
  }

  clear(): void {
    for (let o = 0; o < this.state.length; o += STRIDE) this.state[o + LIFE] = 0;
    this.mesh.geometry.instanceCount = 0;
    this.dirty = false;
  }
}

/** Marks `count` quads from ring slot `start` (wrapping) for upload; a full lap uploads everything. */
function uploadRing(attr: THREE.BufferAttribute, perQuad: number, start: number, count: number): void {
  attr.clearUpdateRanges();
  if (count < SKID_CAPACITY) {
    const first = Math.min(count, SKID_CAPACITY - start);
    attr.addUpdateRange(start * perQuad, first * perQuad);
    if (first < count) attr.addUpdateRange(0, (count - first) * perQuad);
  }
  attr.needsUpdate = true;
}

/** Skid strip of one wheel: last point, its left/right edge, mark alpha; `edged` false until a segment sets the direction. */
type Trail = { active: boolean; edged: boolean; x: number; z: number; lx: number; lz: number; rx: number; rz: number; alpha: number };
/** Quad q = vertices 4q..4q+3 (start left, start right, end right, end left) as triangles 012, 023. */
const QUAD = [0, 1, 2, 0, 2, 3];

class SkidMarks {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private readonly pos: THREE.BufferAttribute;
  private readonly col: THREE.BufferAttribute;
  /** Quads written since the last clear (slot = written % capacity) and at the last flush. */
  private written = 0;
  private flushed = 0;

  constructor() {
    this.pos = new THREE.BufferAttribute(new Float32Array(SKID_CAPACITY * 12), 3).setUsage(THREE.DynamicDrawUsage);
    this.col = new THREE.BufferAttribute(new Float32Array(SKID_CAPACITY * 16).fill(1), 4).setUsage(THREE.DynamicDrawUsage);
    const index = new Uint16Array(SKID_CAPACITY * 6).map((_, i) => 4 * Math.floor(i / 6) + QUAD[i % 6]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', this.pos);
    geo.setAttribute('color', this.col);
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.setDrawRange(0, 0);
    const material = new THREE.MeshBasicMaterial({
      color: C.skid, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
    });
    this.mesh = Object.assign(new THREE.Mesh(geo, material), { name: 'fx-skidmarks', frustumCulled: false, renderOrder: -2 });
  }

  /** Extends `t` to the wheel position (x, z) with mark alpha `alpha` (0 = break the strip). */
  extend(t: Trail, x: number, z: number, alpha: number): void {
    const dx = x - t.x, dz = z - t.z;
    const len = Math.hypot(dx, dz);
    if (alpha <= 0 || !t.active || len > SKID_BREAK) {
      t.active = alpha > 0;
      t.edged = false;
      t.x = x; t.z = z; t.alpha = alpha;
      return;
    }
    if (len < SKID_SEGMENT) return;
    // Half-width edge across the travel direction: left = (dz, -dx) / len.
    const ex = (dz / len) * SKID_HALF_WIDTH;
    const ez = (-dx / len) * SKID_HALF_WIDTH;
    if (!t.edged) {
      t.lx = t.x + ex; t.lz = t.z + ez; t.rx = t.x - ex; t.rz = t.z - ez;
    }
    const slot = this.written++ % SKID_CAPACITY;
    const p = this.pos.array;
    const v = slot * 12;
    p[v] = t.lx; p[v + 1] = SKID_Y; p[v + 2] = t.lz;
    p[v + 3] = t.rx; p[v + 4] = SKID_Y; p[v + 5] = t.rz;
    p[v + 6] = x - ex; p[v + 7] = SKID_Y; p[v + 8] = z - ez;
    p[v + 9] = x + ex; p[v + 10] = SKID_Y; p[v + 11] = z + ez;
    const c = this.col.array;
    c[slot * 16 + 3] = c[slot * 16 + 7] = t.alpha;
    c[slot * 16 + 11] = c[slot * 16 + 15] = alpha;
    t.edged = true; t.x = x; t.z = z; t.alpha = alpha;
    t.lx = x + ex; t.lz = z + ez; t.rx = x - ex; t.rz = z - ez;
  }

  /** Uploads the quads written since the last flush. */
  flush(): void {
    const count = this.written - this.flushed;
    if (count === 0) return;
    const start = this.flushed % SKID_CAPACITY;
    this.flushed = this.written;
    uploadRing(this.pos, 12, start, count);
    uploadRing(this.col, 16, start, count);
    this.mesh.geometry.setDrawRange(0, Math.min(this.written, SKID_CAPACITY) * 6);
  }

  clear(): void {
    this.written = this.flushed = 0;
    this.mesh.geometry.setDrawRange(0, 0);
  }
}

const ramp = (v: number, [a, b]: readonly [number, number]) => clamp((v - a) / (b - a), 0, 1);

/** Rear tyre slide 0..1: drift slip, lateral speed (grip slides) or hard braking (`decel`, m/s^2); fades at low speed. */
function slideIntensity(car: CarState, decel: number): number {
  let k = ramp(Math.abs(car.lateralSpeed), LAT_RAMP);
  if (car.mode === 'drift') k = Math.max(k, ramp(Math.abs(car.slip), SLIP_RAMP));
  if (car.forwardSpeed > SPEED_RAMP[0] && decel > BRAKE_SHARE * TUNING.car.brakeDecel) k = Math.max(k, BRAKE_INTENSITY);
  return k * ramp(car.speed, SPEED_RAMP);
}

export function createFx(scene: THREE.Scene): Fx {
  const rand = seededRandom(0x5eed);
  const smoke = new ParticlePool('fx-smoke', SMOKE_CAPACITY, 0.12, false, rand);
  const bursts = new ParticlePool('fx-bursts', BURST_CAPACITY, 0, true, rand);
  const skids = new SkidMarks();
  scene.add(skids.mesh, smoke.mesh, bursts.mesh);

  const newTrail = (): Trail => ({ active: false, edged: false, x: 0, z: 0, lx: 0, lz: 0, rx: 0, rz: 0, alpha: 0 });
  const trails = [newTrail(), newTrail()];
  const smokeDebt = [0, 0];
  const sparkColor = new THREE.Color();
  let prevSpeed = 0;
  let hasPrev = false;
  let decel = 0;

  function breakTrails(): void {
    trails[0].active = trails[1].active = false;
    hasPrev = false;
    decel = 0;
  }

  /** `count` sparks flying out of (x, y, z) with horizontal speed up to `speed`, m/s. */
  function sparks(x: number, y: number, z: number, count: number, speed: number): void {
    for (let i = 0; i < count; i++) {
      const a = rand() * TAU;
      const hs = speed * (0.35 + 0.65 * rand());
      sparkColor.lerpColors(C.hot, C.cool, rand());
      bursts.spawn(SPARK, x, y, z, Math.cos(a) * hs, 1.5 + rand() * speed * 0.5, Math.sin(a) * hs, 1, sparkColor);
    }
  }

  /** A short flash disc, then gold and white sparkles thrown up and out. */
  function coinBurst(x: number, z: number): void {
    bursts.spawn(FLASH, x, COIN_CENTER_Y, z, 0, 0, 0, 0.9, C.pale);
    for (let i = 0; i < 18; i++) {
      const a = rand() * TAU;
      const hs = 2.5 + rand() * 3.5;
      const c = i % 3 === 0 ? C.pale : C.gold;
      bursts.spawn(SPARKLE, x, COIN_CENTER_Y, z, Math.cos(a) * hs, 2 + rand() * 4, Math.sin(a) * hs, 1, c);
    }
  }

  return {
    update(car: CarState, surface: SurfaceKind, dt: number): void {
      if (!(dt > 0)) return;
      const step = Math.min(dt, MAX_DT);
      if (hasPrev) decel += ((prevSpeed - car.speed) / step - decel) * damp(DECEL_SMOOTHING, step);
      prevSpeed = car.speed;
      hasPrev = true;

      const k = slideIntensity(car, decel);
      const mark = k >= SKID_MIN ? SKID_ALPHA * (0.4 + 0.6 * k) * SKID_SURFACE[surface] : 0;
      const tint = surface === 'runoff' || surface === 'outside' ? C.dust : C.smoke;
      const fx = Math.sin(car.heading);
      const fz = Math.cos(car.heading);
      for (let w = 0; w < 2; w++) {
        // Car space -> world: forward (sin h, cos h), left (cos h, -sin h).
        const side = w === 0 ? REAR_HALF_TRACK : -REAR_HALF_TRACK;
        const x = car.x + fx * REAR_AXLE + fz * side;
        const z = car.z + fz * REAR_AXLE - fx * side;
        skids.extend(trails[w], x, z, mark);
        smokeDebt[w] = k < SMOKE_MIN ? 0 : smokeDebt[w] + SMOKE_RATE * k * step;
        for (; smokeDebt[w] >= 1; smokeDebt[w]--) {
          // Left behind with a fifth of the car velocity, jittered, drifting up.
          const vx = car.vx * 0.2 + (rand() - 0.5) * 2.4;
          const vz = car.vz * 0.2 + (rand() - 0.5) * 2.4;
          const px = x + (rand() - 0.5) * 0.4;
          smoke.spawn(SMOKE, px, 0.3, z + (rand() - 0.5) * 0.4, vx, 0.6 + rand(), vz, 0.16 + 0.24 * k, tint);
        }
      }
      smoke.update(step);
      bursts.update(step);
      skids.flush();
    },
    onEvent(e: GameEvent): void {
      if (e.type === 'hit') sparks(e.x, 0.5, e.z, Math.round(clamp(6 + e.impactSpeed * 1.6, 10, 32)), clamp(e.impactSpeed, 6, 16));
      else if (e.type === 'scrape') sparks(e.x, 0.4, e.z, 5, 5);
      else if (e.type === 'coin') coinBurst(e.x, e.z);
      else if (e.type === 'respawn') breakTrails();
    },
    reset(): void {
      smoke.clear();
      bursts.clear();
      skids.clear();
      breakTrails();
      smokeDebt[0] = smokeDebt[1] = 0;
    },
  };
}
