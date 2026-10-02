/**
 * Geometry helpers for the procedural world objects (procedural.ts, proceduralBike.ts).
 *
 * Builders add primitive geometries with a material and tags to a PartSet; build() merges them into one
 * mesh per (material, part tag, occluder flag), so each object costs a handful of draw calls. Geometry is
 * normalised to non-indexed position + normal (flat shading), which lets primitives and extrusions merge.
 * Occluder parts get their own material instances (fading them must not fade the rest of the object) and
 * live under a child group tagged `userData.occluderGroup` that world.ts hands to the occlusion fader.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export type Vec3 = readonly [number, number, number];

export interface PartTags {
  /** Semantic tag copied to mesh.userData.part (tests and debugging). */
  part?: string;
  /** Fades when it blocks the camera -> car line. */
  occluder?: boolean;
  /** Default true. */
  castShadow?: boolean;
}

interface Entry {
  material: THREE.MeshLambertMaterial;
  tags: PartTags;
  geometries: THREE.BufferGeometry[];
  /** Occluder parts: one local AABB per added piece (min xyz, max xyz), see OCCLUDER_BOXES. */
  boxes: number[];
}

/**
 * userData key of an occluder mesh: flat array of per-piece local AABBs (6 numbers each). Merging pieces
 * per material would otherwise give the occlusion fader one box spanning e.g. both arch posts.
 */
export const OCCLUDER_BOXES = 'occluderBoxes';

/** Flat-shaded world material (design spec §5: MeshLambertMaterial for the world). */
export function lambert(hex: number): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color: hex, flatShading: true });
}

/** Non-indexed copy with only position + normal (per-face normals). */
function normalise(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  }
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  return g;
}

export class PartSet {
  private readonly entries = new Map<string, Entry>();
  private readonly occluderMaterials = new Map<THREE.MeshLambertMaterial, THREE.MeshLambertMaterial>();

  add(geometry: THREE.BufferGeometry, material: THREE.MeshLambertMaterial, tags: PartTags = {}): this {
    const mat = tags.occluder ? this.occluderMaterial(material) : material;
    const key = `${mat.uuid}|${tags.part ?? ''}|${tags.occluder === true}|${tags.castShadow !== false}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { material: mat, tags, geometries: [], boxes: [] };
      this.entries.set(key, entry);
    }
    const g = normalise(geometry);
    entry.geometries.push(g);
    if (tags.occluder) {
      g.computeBoundingBox();
      const b = g.boundingBox;
      if (b) entry.boxes.push(b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z);
    }
    return this;
  }

  /** Merged meshes under a new group; occluder meshes go into a tagged child group. */
  build(name: string): THREE.Group {
    const root = new THREE.Group();
    root.name = name;
    let occluders: THREE.Group | null = null;
    for (const { material, tags, geometries, boxes } of this.entries.values()) {
      const merged = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false);
      if (!merged) throw new Error(`${name}: cannot merge part geometries`);
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = `${name}-${tags.part ?? 'part'}`;
      mesh.castShadow = tags.castShadow !== false;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      if (tags.part) mesh.userData.part = tags.part;
      if (tags.occluder) {
        mesh.userData.occluder = true;
        mesh.userData[OCCLUDER_BOXES] = boxes;
        if (!occluders) {
          occluders = new THREE.Group();
          occluders.name = `${name}-occluder`;
          occluders.userData.occluderGroup = true;
          occluders.matrixAutoUpdate = false;
          root.add(occluders);
        }
        occluders.add(mesh);
      } else {
        root.add(mesh);
      }
    }
    root.updateMatrixWorld(true);
    return root;
  }

  private occluderMaterial(base: THREE.MeshLambertMaterial): THREE.MeshLambertMaterial {
    let m = this.occluderMaterials.get(base);
    if (!m) {
      m = base.clone();
      this.occluderMaterials.set(base, m);
    }
    return m;
  }
}

/** The fade units of a procedural object: its tagged occluder groups (empty if none). */
export function findOccluderGroups(root: THREE.Object3D): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (o.userData.occluderGroup === true) out.push(o);
  });
  return out;
}

// ---- Primitive placement helpers (creation time only; they allocate) ----

const tmpMatrix = new THREE.Matrix4();
const tmpQuat = new THREE.Quaternion();
const tmpEuler = new THREE.Euler();
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3(1, 1, 1);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** Applies rotation (XYZ Euler, rad) then translation to `g` in place. */
export function place(g: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry {
  tmpQuat.setFromEuler(tmpEuler.set(rx, ry, rz));
  tmpMatrix.compose(tmpPos.set(x, y, z), tmpQuat, tmpScale);
  return g.applyMatrix4(tmpMatrix);
}

/** Box with its centre at (x, y, z). */
export function boxAt(w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry {
  return place(new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz);
}

/** Vertical cylinder standing on y = `y0`, centred on (x, z). */
export function cylinderAt(
  rTop: number,
  rBottom: number,
  height: number,
  segments: number,
  x: number,
  y0: number,
  z: number,
): THREE.BufferGeometry {
  return place(new THREE.CylinderGeometry(rTop, rBottom, height, segments), x, y0 + height / 2, z);
}

/** Cylinder whose axis runs along X, centred at (x, y, z). */
export function discX(radius: number, thickness: number, segments: number, x: number, y: number, z: number): THREE.BufferGeometry {
  return place(new THREE.CylinderGeometry(radius, radius, thickness, segments), x, y, z, 0, 0, Math.PI / 2);
}

/** Round tube (cylinder) from a to b. */
export function tubeBetween(a: Vec3, b: Vec3, radius: number, segments = 6): THREE.BufferGeometry {
  const dir = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const length = dir.length();
  const g = new THREE.CylinderGeometry(radius, radius, length, segments);
  tmpQuat.setFromUnitVectors(Y_AXIS, dir.normalize());
  tmpMatrix.compose(tmpPos.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), tmpQuat, tmpScale);
  return g.applyMatrix4(tmpMatrix);
}

/** Ring (doughnut) around the X axis with an elliptical cross-section: `radial` half-thickness, `axial` half-width. */
export function ringX(
  centreRadius: number,
  radial: number,
  axial: number,
  segments: number,
  profileSegments: number,
  x: number,
  y: number,
  z: number,
): THREE.BufferGeometry {
  const profile: THREE.Vector2[] = [];
  for (let i = 0; i <= profileSegments; i++) {
    const t = (i / profileSegments) * Math.PI * 2;
    profile.push(new THREE.Vector2(centreRadius + radial * Math.cos(t), axial * Math.sin(t)));
  }
  // Lathe revolves around +Y; tip the axis onto X.
  return place(new THREE.LatheGeometry(profile, segments), x, y, z, 0, 0, Math.PI / 2);
}
