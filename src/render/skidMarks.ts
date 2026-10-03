/**
 * Skid marks for render/fx.ts: a ring buffer of SKID_CAPACITY quads shared by the rear wheel pair (preallocated,
 * DynamicDrawUsage, partial uploads via update ranges, y 0.07, polygonOffset, depthWrite false). Each rear wheel
 * lays a continuous strip while sliding; a long jump (teleport) or alpha 0 breaks it.
 */
import * as THREE from 'three';

/** Skid-mark quads shared by both rear wheels (ring buffer). */
export const SKID_CAPACITY = 2000;
const SKID_Y = 0.07;
const SKID_HALF_WIDTH = 0.2;
/** Minimum strip segment, m; a wheel jump longer than SKID_BREAK (teleport) starts a new strip. */
const SKID_SEGMENT = 0.45;
const SKID_BREAK = 4;
const SKID_COLOR = new THREE.Color(0x26232a);

/**
 * Upload queue of a ring attribute: mark(start, count) queues `count` quads from slot `start` (wrapping). The
 * queue grows until three uploads the attribute (onUpload), so several update() calls between two renders (one
 * per fixed step) all reach the GPU; a full lap uploads everything. reset() drops it (clear()).
 */
function ringUpload(attr: THREE.BufferAttribute, perQuad: number): { mark(start: number, count: number): void; reset(): void } {
  let first = 0;
  let pending = 0;
  attr.onUpload(() => (pending = 0));
  return {
    mark(start, count) {
      if (pending === 0) first = start;
      pending = Math.min(SKID_CAPACITY, pending + count);
      attr.clearUpdateRanges();
      const head = Math.min(pending, SKID_CAPACITY - first);
      if (pending < SKID_CAPACITY) attr.addUpdateRange(first * perQuad, head * perQuad);
      if (pending < SKID_CAPACITY && head < pending) attr.addUpdateRange(0, (pending - head) * perQuad);
      attr.needsUpdate = true;
    },
    reset: () => (pending = 0),
  };
}

/** Skid strip of one wheel: last point, its left/right edge, mark alpha; `edged` false until a segment sets the direction. */
export type Trail = { active: boolean; edged: boolean; x: number; z: number; lx: number; lz: number; rx: number; rz: number; alpha: number };
/**
 * Quad q = vertices 4q..4q+3 (start left, start right, end right, end left) as triangles 012, 023: counter-
 * clockwise seen from above for any travel direction, so the front face points up.
 */
const QUAD = [0, 1, 2, 0, 2, 3];

export class SkidMarks {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private readonly pos: THREE.BufferAttribute;
  private readonly col: THREE.BufferAttribute;
  private readonly uploads: ReturnType<typeof ringUpload>[];
  /** Quads written since the last clear (slot = written % capacity) and at the last flush. */
  private written = 0;
  private flushed = 0;

  constructor() {
    this.pos = new THREE.BufferAttribute(new Float32Array(SKID_CAPACITY * 12), 3).setUsage(THREE.DynamicDrawUsage);
    this.col = new THREE.BufferAttribute(new Float32Array(SKID_CAPACITY * 16).fill(1), 4).setUsage(THREE.DynamicDrawUsage);
    this.uploads = [ringUpload(this.pos, 12), ringUpload(this.col, 16)];
    const index = new Uint16Array(SKID_CAPACITY * 6).map((_, i) => 4 * Math.floor(i / 6) + QUAD[i % 6]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', this.pos);
    geo.setAttribute('color', this.col);
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.setDrawRange(0, 0);
    // FrontSide: the quads face +y (extend() winds them counter-clockwise seen from above). A transparent
    // DoubleSide material would be drawn twice per frame by three (back, then front), re-resolving its shader
    // program each time.
    const material = new THREE.MeshBasicMaterial({
      color: SKID_COLOR, vertexColors: true, transparent: true, depthWrite: false, side: THREE.FrontSide,
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
    for (const u of this.uploads) u.mark(start, count);
    this.mesh.geometry.setDrawRange(0, Math.min(this.written, SKID_CAPACITY) * 6);
  }

  clear(): void {
    this.written = this.flushed = 0;
    for (const u of this.uploads) u.reset();
    this.mesh.geometry.setDrawRange(0, 0);
  }
}
