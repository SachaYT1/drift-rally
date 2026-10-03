/**
 * Building blocks shared by the procedural cars (render/bodies/*, carModel.ts): the four materials every car
 * uses, the trim palette, PartBuilder (collects transformed parts and merges them per material) and the wheel
 * geometry.
 *
 * Model space: built facing +Z, local +X = the car's LEFT side, y up from the ground (see bridge.ts).
 * Rotations (PartBuilder rx, about X): rx < 0 lifts a part's front (+Z) end and leans its top back; rx > 0 the
 * opposite. rx = PI/2 turns a cylinder's axis from +Y to +Z (a lamp facing forward).
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TUNING } from '../shared/tuning';

export const WHEEL_WIDTH = 0.35;
/** Hub disc + cap protrude this far beyond the tyre's outer face; the car width includes them. */
export const CAP_OUT = 0.045;

/** Trim colours shared by every body (sRGB hex; converted to linear vertex colours via Color.setHex). */
export const COLORS = {
  dark: 0x1c1a1c,
  seat: 0x2e2a2c,
  metal: 0x4a4b50,
  frame: 0xc4c8cc,
  glass: 0x1f3a39,
  headlight: 0xfff6e2,
  taillight: 0xff2b24,
  tyre: 0x1e1e21,
} as const;

export interface Materials {
  paint: THREE.MeshStandardMaterial;
  /** Every other body part: one vertex-coloured Lambert mesh (one draw call). */
  trim: THREE.MeshLambertMaterial;
  /** Head/tail lights: unlit so they read as emissive (no real lights). */
  lamps: THREE.MeshBasicMaterial;
  /** Tyre + hub + cap, flat-shaded so the low-poly facets show the wheel spin. */
  wheel: THREE.MeshLambertMaterial;
}

export function createMaterials(color: number): Materials {
  return {
    paint: new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0 }),
    trim: new THREE.MeshLambertMaterial({ vertexColors: true }),
    lamps: new THREE.MeshBasicMaterial({ vertexColors: true }),
    wheel: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
  };
}

/** Hub and centre-cap colours of a body's wheels. */
export interface WheelColors {
  hub: number;
  cap: number;
}

/** One procedural car body: its default paint, its wheel colours and its parts. */
export interface CarBody {
  /** Default paint colour (sRGB hex). */
  readonly paint: number;
  readonly wheel: WheelColors;
  /** Adds every part except the wheels to `b`, in model space (see the file header), on `m`'s materials. */
  build(b: PartBuilder, m: Materials): void;
}

/** Collects transformed part geometries per material and merges them into one geometry each. */
export class PartBuilder {
  private readonly parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3(1, 1, 1);
  private readonly c = new THREE.Color();

  /** `color` fills a vertex-colour attribute (for vertexColors materials); null for plain materials. */
  add(mat: THREE.Material, geo: THREE.BufferGeometry, color: number | null, x: number, y: number, z: number, rx = 0, rz = 0): void {
    this.q.setFromEuler(this.e.set(rx, 0, rz));
    this.m.compose(this.p.set(x, y, z), this.q, this.s);
    geo.applyMatrix4(this.m);
    // RoundedBoxGeometry is non-indexed; mergeGeometries needs all parts in the same form.
    const flat = geo.index ? geo.toNonIndexed() : geo;
    if (flat !== geo) geo.dispose();
    if (color !== null) {
      this.c.setHex(color);
      const n = flat.getAttribute('position').count;
      const rgb = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        rgb[i * 3] = this.c.r;
        rgb[i * 3 + 1] = this.c.g;
        rgb[i * 3 + 2] = this.c.b;
      }
      flat.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
    }
    const list = this.parts.get(mat) ?? [];
    list.push(flat);
    this.parts.set(mat, list);
  }

  box(mat: THREE.Material, color: number | null, w: number, h: number, d: number, x: number, y: number, z: number, rx = 0): void {
    this.add(mat, new THREE.BoxGeometry(w, h, d), color, x, y, z, rx);
  }

  rounded(
    mat: THREE.Material, color: number | null,
    w: number, h: number, d: number, r: number, x: number, y: number, z: number, rx = 0,
  ): void {
    this.add(mat, new RoundedBoxGeometry(w, h, d, 3, r), color, x, y, z, rx);
  }

  /** Cylinder of radius r and height h, axis along Y before the rotation (rx = PI/2 points it along +Z). */
  cylinder(
    mat: THREE.Material, color: number | null,
    r: number, h: number, segments: number, x: number, y: number, z: number, rx = 0, rz = 0,
  ): void {
    this.add(mat, new THREE.CylinderGeometry(r, r, h, segments), color, x, y, z, rx, rz);
  }

  /** Merge (and forget) everything collected for `mat`. */
  merged(mat: THREE.Material): THREE.BufferGeometry {
    const geos = this.parts.get(mat) ?? [];
    this.parts.delete(mat);
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) throw new Error('carParts: failed to merge part geometries');
    return merged;
  }

  /** One mesh per material. */
  build(target: THREE.Object3D): void {
    for (const mat of [...this.parts.keys()]) target.add(new THREE.Mesh(this.merged(mat), mat));
  }
}

/** Tyre + hub disc + cap as one geometry, axle along X; hub and cap on the `outward` (+1/-1) face. */
export function createWheelGeometry(mat: THREE.Material, outward: number, colors: WheelColors): THREE.BufferGeometry {
  const r = TUNING.car.wheelRadius;
  const axle = Math.PI / 2;
  const b = new PartBuilder();
  b.add(mat, new THREE.CylinderGeometry(r, r, WHEEL_WIDTH, 16), COLORS.tyre, 0, 0, 0, 0, axle);
  b.add(mat, new THREE.CylinderGeometry(r * 0.6, r * 0.6, 0.03, 16), colors.hub, outward * (WHEEL_WIDTH / 2 + 0.01), 0, 0, 0, axle);
  b.add(mat, new THREE.CylinderGeometry(r * 0.26, r * 0.26, CAP_OUT * 2, 8), colors.cap, outward * (WHEEL_WIDTH / 2), 0, 0, 0, axle);
  return b.merged(mat);
}
