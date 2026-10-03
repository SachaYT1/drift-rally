/**
 * Static decor batching for world.ts: asset clones are posed, restyled, then merged per
 * (sector, materialBatchKey, castShadow) into a few static meshes (design spec §5: static decor merged per
 * sector by material, matrixAutoUpdate false). Also builds the merged contact-shadow blobs used under
 * tall decor that does not cast real shadows.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { materialBatchKey } from '../core/assets';
import { createBlobTexture } from './groundTextures';

/** Side of a merge sector, m: big enough for few draw calls, small enough for frustum culling. */
const SECTOR_SIZE = 250;
const BLOB_COLOR = 0x4a4458;
const BLOB_OPACITY = 0.32;
/** Blobs sit just above the plaza layer (below runoff 0.02), m. */
const BLOB_LIFT = 0.01;

interface Batch {
  material: THREE.Material;
  cast: boolean;
  geometries: THREE.BufferGeometry[];
}

export interface RestyleOptions {
  /** Linear colour multiplier for every Lambert material. */
  tint?: readonly [number, number, number];
  /** Map swap, e.g. a recoloured atlas copy (recolor.ts). */
  map?: (map: THREE.Texture) => THREE.Texture;
}

/**
 * Restyles the per-call material clones under `root` (tint and/or map swap) and tags their batch key, so
 * restyled clones never merge with plain clones of the same template material.
 */
export function restyleObject(root: THREE.Object3D, tag: string, options: RestyleOptions): void {
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const mats: THREE.Material[] = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (m instanceof THREE.MeshLambertMaterial) {
        if (options.tint) {
          m.color.r *= options.tint[0];
          m.color.g *= options.tint[1];
          m.color.b *= options.tint[2];
        }
        if (options.map && m.map) m.map = options.map(m.map);
      }
      m.userData.batchKey = `${materialBatchKey(m)}|${tag}`;
    }
  });
}

/** Geometries with matching attribute sets and index presence, ready for mergeGeometries. */
function compatible(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry[] {
  const names = Object.keys(geometries[0].attributes).filter((n) => geometries.every((g) => g.getAttribute(n) !== undefined));
  const indexed = geometries.every((g) => g.index !== null);
  return geometries.map((g) => {
    const h = indexed || g.index === null ? g : g.toNonIndexed();
    for (const n of Object.keys(h.attributes)) if (!names.includes(n)) h.deleteAttribute(n);
    h.morphAttributes = {};
    return h;
  });
}

export class StaticBatcher {
  private readonly batches = new Map<string, Batch>();

  /**
   * Bakes every mesh under `root` (already posed; root must not have a parent) into the batches. The root's
   * meshes are consumed: their geometry is cloned, their per-call materials only serve as batch templates.
   */
  add(root: THREE.Object3D, cast: boolean): void {
    root.updateMatrixWorld(true);
    const sector = `${Math.floor(root.position.x / SECTOR_SIZE)},${Math.floor(root.position.z / SECTOR_SIZE)}`;
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || Array.isArray(o.material)) return;
      const material: THREE.Material = o.material;
      const key = `${sector}|${materialBatchKey(material)}|${cast}`;
      let batch = this.batches.get(key);
      if (!batch) {
        batch = { material, cast, geometries: [] };
        this.batches.set(key, batch);
      }
      const g = o.geometry.clone();
      g.applyMatrix4(o.matrixWorld);
      batch.geometries.push(g);
    });
  }

  /** One static mesh per batch. */
  build(): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const [key, batch] of this.batches) {
      const merged = batch.geometries.length === 1 ? batch.geometries[0] : mergeGeometries(compatible(batch.geometries), false);
      if (!merged) {
        console.warn(`world: could not merge decor batch ${key}`);
        continue;
      }
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, batch.material);
      mesh.name = `decor:${key}`;
      mesh.castShadow = batch.cast;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      out.push(mesh);
    }
    this.batches.clear();
    return out;
  }
}

/** Soft dark discs under decor that does not cast shadows (tall trees, lamps). One draw call. */
export class BlobBatcher {
  private readonly pos: number[] = [];
  private readonly uv: number[] = [];
  private readonly index: number[] = [];

  add(x: number, z: number, radius: number, groundY: number): void {
    const base = this.pos.length / 3;
    const y = groundY + BLOB_LIFT;
    this.pos.push(x - radius, y, z - radius, x + radius, y, z - radius, x + radius, y, z + radius, x - radius, y, z + radius);
    this.uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    // Counter-clockwise seen from above (+Y).
    this.index.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }

  build(): THREE.Mesh | null {
    if (this.index.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.index);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    const material = new THREE.MeshBasicMaterial({
      color: BLOB_COLOR,
      map: createBlobTexture(64),
      transparent: true,
      opacity: BLOB_OPACITY,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    material.name = 'decor-blobs';
    const mesh = new THREE.Mesh(g, material);
    mesh.name = 'decor-blobs';
    mesh.matrixAutoUpdate = false;
    // Ground decals draw before skid marks (-2), particles (-1) and fading occluders (0).
    mesh.renderOrder = -3;
    return mesh;
  }
}
