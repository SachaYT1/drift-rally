/**
 * Fades occluders (bench seat + backrest, start arch, planter canopy) to 25 % opacity while they block
 * the camera -> car line (design spec §3), and back when they no longer do. Raycast-free: the segment is
 * tested against world AABBs (precomputed once, occluders are static) expanded by a small margin so the
 * fade starts slightly before the car is hidden: one box per procedural piece when the mesh carries
 * `userData.occluderBoxes` (proceduralKit.ts), else the mesh geometry's box.
 *
 * Materials of an occluder are switched to `transparent = true` once at creation, so the transparent
 * program is compiled during loading (compileAsync / prewarm) and fading never recompiles; only
 * `opacity` and `depthWrite` change at runtime. Occluder meshes get renderOrder OCCLUDER_RENDER_ORDER,
 * i.e. they draw first among transparents: while opaque they write depth before skid marks (-2) and
 * smoke (-1) are tested against it. update() does not allocate.
 */
import type * as THREE from 'three';
import { OCCLUDER_BOXES } from './proceduralKit';

export interface OcclusionFader {
  /**
   * `target` = the car position (interpolated render state, y ~ car centre). `dt` in seconds; when
   * omitted, the wall-clock time since the previous call is used (clamped to 0.1 s).
   */
  update(camera: THREE.Camera, target: THREE.Vector3, dt?: number): void;
  /** Snap every occluder back to fully opaque (race restart, respawn). */
  reset(): void;
}

/** Faded opacity (relative to the material's own opacity) and fade time, s (design spec / plan). */
export const OCCLUDED_OPACITY = 0.25;
export const FADE_TIME = 0.2;
/** AABB margin, m: the car body (~1 m) and an early start of the fade. */
const BOX_MARGIN = 1.0;
const MAX_DT = 0.1;
export const OCCLUDER_RENDER_ORDER = -10;
/** Below this fade amount the material is treated as opaque again (depth writes restored). */
const OPAQUE_EPSILON = 1e-3;

interface Unit {
  materials: THREE.Material[];
  baseOpacity: number[];
  baseDepthWrite: boolean[];
  /** Index range into the box array. */
  boxStart: number;
  boxEnd: number;
  /** 0 = opaque, 1 = fully faded. */
  fade: number;
  applied: number;
}

type MeshLike = THREE.Object3D & { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };

/** Segment p -> p + d against the AABB stored at boxes[6k..6k+5] (min xyz, max xyz). Slab test. */
function segmentHitsBox(boxes: Float64Array, k: number, px: number, py: number, pz: number, dx: number, dy: number, dz: number): boolean {
  let t0 = 0;
  let t1 = 1;
  const o = k * 6;
  for (let axis = 0; axis < 3; axis++) {
    const p = axis === 0 ? px : axis === 1 ? py : pz;
    const d = axis === 0 ? dx : axis === 1 ? dy : dz;
    const lo = boxes[o + axis];
    const hi = boxes[o + 3 + axis];
    if (Math.abs(d) < 1e-9) {
      if (p < lo || p > hi) return false;
      continue;
    }
    let a = (lo - p) / d;
    let b = (hi - p) / d;
    if (a > b) {
      const tmp = a;
      a = b;
      b = tmp;
    }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return false;
  }
  return true;
}

function collect(root: THREE.Object3D, boxList: number[]): Pick<Unit, 'materials' | 'baseOpacity' | 'baseDepthWrite'> {
  const materials: THREE.Material[] = [];
  root.updateWorldMatrix(true, true);
  root.traverse((o: MeshLike) => {
    const g = o.geometry;
    const m = o.material;
    if (!g || !m) return;
    // Per-piece local boxes from the procedural builders, else the whole geometry's box.
    const pieces: unknown = o.userData[OCCLUDER_BOXES];
    let local: number[] = [];
    if (Array.isArray(pieces) && pieces.length >= 6 && pieces.every((v) => typeof v === 'number')) {
      local = pieces;
    } else {
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox;
      if (bb && !bb.isEmpty()) local = [bb.min.x, bb.min.y, bb.min.z, bb.max.x, bb.max.y, bb.max.z];
    }
    const e = o.matrixWorld.elements;
    for (let b = 0; b + 5 < local.length; b += 6) {
      // Transform the 8 corners by the world matrix and keep their AABB.
      let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let c = 0; c < 8; c++) {
        const x = local[b + (c & 1 ? 3 : 0)];
        const y = local[b + (c & 2 ? 4 : 1)];
        const z = local[b + (c & 4 ? 5 : 2)];
        const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
        const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
        const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
        minX = Math.min(minX, wx); minY = Math.min(minY, wy); minZ = Math.min(minZ, wz);
        maxX = Math.max(maxX, wx); maxY = Math.max(maxY, wy); maxZ = Math.max(maxZ, wz);
      }
      boxList.push(minX - BOX_MARGIN, minY - BOX_MARGIN, minZ - BOX_MARGIN, maxX + BOX_MARGIN, maxY + BOX_MARGIN, maxZ + BOX_MARGIN);
    }
    o.renderOrder = OCCLUDER_RENDER_ORDER;
    for (const mat of Array.isArray(m) ? m : [m]) if (!materials.includes(mat)) materials.push(mat);
  });
  const baseOpacity = materials.map((mat) => mat.opacity);
  const baseDepthWrite = materials.map((mat) => mat.depthWrite);
  for (const mat of materials) {
    if (!mat.transparent) {
      mat.transparent = true;
      mat.needsUpdate = true;
    }
  }
  return { materials, baseOpacity, baseDepthWrite };
}

/** `occluders` must already be in their final (static) world pose. Their materials must not be shared with non-occluders. */
export function createOcclusionFader(occluders: THREE.Object3D[]): OcclusionFader {
  const boxList: number[] = [];
  const units: Unit[] = occluders.map((root) => {
    const boxStart = boxList.length / 6;
    const mats = collect(root, boxList);
    return { ...mats, boxStart, boxEnd: boxList.length / 6, fade: 0, applied: 0 };
  });
  const boxes = Float64Array.from(boxList);
  let lastTime = -1;

  function apply(u: Unit): void {
    if (u.fade === u.applied) return;
    u.applied = u.fade;
    const k = 1 - u.fade * (1 - OCCLUDED_OPACITY);
    const opaque = u.fade < OPAQUE_EPSILON;
    for (let i = 0; i < u.materials.length; i++) {
      const m = u.materials[i];
      m.opacity = u.baseOpacity[i] * k;
      m.depthWrite = opaque ? u.baseDepthWrite[i] : false;
    }
  }

  function update(camera: THREE.Camera, target: THREE.Vector3, dt?: number): void {
    let step: number;
    if (dt === undefined) {
      const now = typeof performance === 'undefined' ? Date.now() : performance.now();
      step = lastTime < 0 ? 0 : (now - lastTime) / 1000;
      lastTime = now;
    } else {
      step = dt;
    }
    step = Number.isFinite(step) ? Math.min(Math.max(step, 0), MAX_DT) : 0;
    const e = camera.matrixWorld.elements;
    const px = e[12], py = e[13], pz = e[14];
    const dx = target.x - px, dy = target.y - py, dz = target.z - pz;
    const rate = step / FADE_TIME;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      let blocked = false;
      for (let k = u.boxStart; k < u.boxEnd && !blocked; k++) blocked = segmentHitsBox(boxes, k, px, py, pz, dx, dy, dz);
      u.fade = blocked ? Math.min(1, u.fade + rate) : Math.max(0, u.fade - rate);
      apply(u);
    }
  }

  function reset(): void {
    for (const u of units) {
      u.fade = 0;
      apply(u);
    }
    lastTime = -1;
  }

  return { update, reset };
}
