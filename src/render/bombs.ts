/**
 * Bombs on the road (plan/2026-10-04-bombs-design.md): cartoon bombs (dark ball, metal collar, curved fuse,
 * blinking spark). One small model per bomb (4 on the plaza: no instancing needed). A blown bomb hides until
 * the session's BombState no longer lists it (new lap). update() does not allocate.
 *
 * Model conventions as procedural.ts: built around a vertical axis, origin at ground centre, flat-shaded
 * Lambert parts merged per material; the spark is unlit and not tone-mapped so it glows without a light.
 */
import * as THREE from 'three';
import type { BombState } from '../game/bombs';
import type { Track } from '../track/build';
import { TAU } from '../shared/math';
import { PartSet, cylinderAt, lambert, tubeBetween, type Vec3 } from './proceduralKit';

export interface BombsLayer {
  group: THREE.Group;
  /** Hide blown bombs (every bomb shows when `state` is null); blink the fuse sparks on the sim clock `time`, s. */
  update(state: BombState | null, time: number): void;
}

// ---- Visual-only constants (not gameplay tuning) ----
const COLORS = { shell: 0x23242b, collar: 0x9aa0a8, fuse: 0xd8c49a } as const;
const SPARK_COLOR = 0xffc23a;
/** The shell sinks this share of its radius into the road, so it sits instead of balancing on a point. */
const SINK = 0.08;
/** Spark radius at full blink as a share of the bomb radius; blink rate (Hz) and smallest scale (0..1). */
const SPARK_SCALE = 0.42;
const BLINK_HZ = 5;
const BLINK_MIN = 0.45;
/** Yaw step between neighbouring bombs (rad) and blink phase step (cycles), so they do not look cloned. */
const YAW_STEP = 2.1;
const PHASE_STEP = 0.37;

/** One bomb of radius `r` (the trigger radius) and the local position of its fuse tip. */
export function createBomb(r: number): { root: THREE.Group; sparkAt: THREE.Vector3 } {
  const parts = new PartSet();
  const cy = r * (1 - SINK);
  const top = cy + r;
  parts.add(new THREE.SphereGeometry(r, 14, 10).translate(0, cy, 0), lambert(COLORS.shell), { part: 'shell' });
  parts.add(cylinderAt(r * 0.3, r * 0.34, r * 0.3, 10, 0, top - r * 0.12, 0), lambert(COLORS.collar), { part: 'collar' });
  // A fuse curling up and out of the collar in two straight pieces.
  const fuse = lambert(COLORS.fuse);
  const a: Vec3 = [0, top + r * 0.15, 0];
  const b: Vec3 = [r * 0.1, top + r * 0.5, r * 0.06];
  const c: Vec3 = [r * 0.36, top + r * 0.7, r * 0.18];
  parts.add(tubeBetween(a, b, r * 0.07, 6), fuse, { part: 'fuse' });
  parts.add(tubeBetween(b, c, r * 0.07, 6), fuse, { part: 'fuse' });
  return { root: parts.build('bomb'), sparkAt: new THREE.Vector3(c[0], c[1], c[2]) };
}

export function createBombsLayer(track: Track): BombsLayer {
  const group = new THREE.Group();
  group.name = 'bombs';
  const sparkGeometry = new THREE.IcosahedronGeometry(1, 0);
  const sparkMaterial = new THREE.MeshBasicMaterial({ color: SPARK_COLOR, toneMapped: false });
  const slots = track.bombs.map((spot, i) => {
    const { root, sparkAt } = createBomb(spot.r);
    root.name = `bomb-${spot.id}`;
    root.position.set(spot.x, 0, spot.z);
    root.rotation.y = i * YAW_STEP;
    const spark = new THREE.Mesh(sparkGeometry, sparkMaterial);
    spark.name = 'bomb-spark';
    spark.position.copy(sparkAt);
    root.add(spark);
    group.add(root);
    return { id: spot.id, root, spark, size: spot.r * SPARK_SCALE, phase: i * PHASE_STEP };
  });

  return {
    group,
    update(state: BombState | null, time: number): void {
      for (const s of slots) {
        s.root.visible = state === null || !state.blown.has(s.id);
        const blink = 0.5 + 0.5 * Math.sin(TAU * (time * BLINK_HZ + s.phase));
        s.spark.scale.setScalar(s.size * (BLINK_MIN + (1 - BLINK_MIN) * blink));
      }
    },
  };
}
