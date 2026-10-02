/**
 * Loads the Kenney models listed in render/catalog.ts and hands out ready-to-place clones.
 *
 * Every model is prepared once into a template: materials converted to flat-shaded
 * MeshLambertMaterial, node transforms and the toy-world scale (realHeight x WORLD_SCALE) baked
 * into the geometry, origin at the ground centre, facing +Z. Clones share geometry and materials
 * with the template: callers must not dispose them, and must clone a material before mutating it
 * (e.g. fading) unless the change is meant for every instance of the visual. Shadow flags are left
 * off; the caller decides (buildings and tall decor must not cast shadows, design spec §5).
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CATALOG, WORLD_SCALE, type CatalogEntry } from '../render/catalog';
import type { VisualId } from '../track/trackDef';

export interface AssetLibrary {
  /** Deep-cloned, scaled (×12 of real size via catalog), origin at ground centre, facing +Z; null if the visual is procedural or failed. */
  create(visual: VisualId, variant?: number): THREE.Object3D | null;
}

/** Where model files come from and how failures are handled. Injected so the logic is testable in node. */
export interface AssetSource {
  /** Loads one catalog file (path relative to the base URL) and returns its scene root. */
  load(file: string): Promise<THREE.Object3D>;
  /** true (DEV): a missing model rejects the whole load. false (PROD): warn and skip it. */
  strict: boolean;
  warn(message: string): void;
}

type Catalog = Record<VisualId, CatalogEntry>;

/** Material properties shared by the glTF loader's output types (standard / basic for unlit). */
type SourceMaterial = THREE.Material & {
  color?: THREE.Color;
  map?: THREE.Texture | null;
  emissive?: THREE.Color;
  emissiveMap?: THREE.Texture | null;
};

/** Converts any glTF material to a flat-shaded Lambert material, keeping colour, map and blending. */
export function toLambert(source: THREE.Material, tint?: number): THREE.MeshLambertMaterial {
  const src = source as SourceMaterial;
  const out = new THREE.MeshLambertMaterial({
    name: src.name,
    map: src.map ?? null,
    flatShading: true,
    side: src.side,
    transparent: src.transparent,
    opacity: src.opacity,
    alphaTest: src.alphaTest,
    depthWrite: src.depthWrite,
    vertexColors: src.vertexColors,
  });
  if (src.color) out.color.copy(src.color);
  if (tint !== undefined) out.color.multiply(new THREE.Color(tint));
  if (src.emissive) out.emissive.copy(src.emissive);
  if (src.emissiveMap) out.emissiveMap = src.emissiveMap;
  return out;
}

/**
 * Turns a loaded scene into a template: a Group of meshes with identity transforms whose geometry
 * is `targetHeight` metres tall, centred on x/z with its lowest point at y = 0.
 */
export function prepareTemplate(scene: THREE.Object3D, targetHeight: number, tint?: number): THREE.Group {
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  const height = box.max.y - box.min.y;
  if (!(height > 0)) throw new Error(`model "${scene.name}" has no height`);
  const s = targetHeight / height;
  const fit = new THREE.Matrix4()
    .makeTranslation(-((box.min.x + box.max.x) / 2) * s, -box.min.y * s, -((box.min.z + box.max.z) / 2) * s)
    .multiply(new THREE.Matrix4().makeScale(s, s, s));

  const converted = new Map<THREE.Material, THREE.MeshLambertMaterial>();
  const convert = (m: THREE.Material): THREE.MeshLambertMaterial => {
    let out = converted.get(m);
    if (!out) {
      out = toLambert(m, tint);
      converted.set(m, out);
    }
    return out;
  };

  const template = new THREE.Group();
  template.name = scene.name;
  const sources: THREE.Mesh[] = [];
  scene.traverse((o) => {
    if (o instanceof THREE.Mesh) sources.push(o);
  });
  for (const src of sources) {
    const geometry = src.geometry.clone();
    geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(fit, src.matrixWorld));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const material = Array.isArray(src.material) ? src.material.map(convert) : convert(src.material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = src.name;
    template.add(mesh);
  }
  template.updateMatrixWorld(true);
  return template;
}

/** Loads every catalog model through `source`. Exposed for tests; the app uses loadAssets(). */
export async function createAssetLibrary(
  source: AssetSource,
  onProgress?: (fraction: number) => void,
  catalog: Catalog = CATALOG,
): Promise<AssetLibrary> {
  const jobs: { visual: VisualId; index: number; file: string }[] = [];
  for (const visual of Object.keys(catalog) as VisualId[]) {
    (catalog[visual].files ?? []).forEach((file, index) => jobs.push({ visual, index, file }));
  }
  const templates = new Map<VisualId, (THREE.Group | null)[]>();
  let done = 0;
  let failed = false;
  onProgress?.(0);

  await Promise.all(
    jobs.map(async ({ visual, index, file }) => {
      const entry = catalog[visual];
      let template: THREE.Group | null = null;
      try {
        const scene = await source.load(file);
        template = prepareTemplate(scene, entry.realHeight * WORLD_SCALE, entry.tint);
        template.name = `${visual}-${index}`;
      } catch (err) {
        const message = `Missing asset "${file}" (${visual}): ${err instanceof Error ? err.message : String(err)}`;
        if (source.strict) {
          failed = true;
          throw new Error(message);
        }
        source.warn(message);
      }
      const list = templates.get(visual) ?? [];
      list[index] = template;
      templates.set(visual, list);
      done++;
      if (!failed) onProgress?.(done / jobs.length);
    }),
  );
  if (jobs.length === 0) onProgress?.(1);

  return {
    create(visual: VisualId, variant = 0): THREE.Object3D | null {
      const list = templates.get(visual);
      if (!list || list.length === 0) return null;
      const n = list.length;
      const index = Number.isFinite(variant) ? Math.floor(variant) : 0;
      const start = ((index % n) + n) % n;
      // A variant that failed to load (PROD only) falls back to the next loaded one.
      for (let k = 0; k < n; k++) {
        const template = list[(start + k) % n];
        if (template) {
          const clone = template.clone();
          clone.userData.visual = visual;
          return clone;
        }
      }
      return null;
    },
  };
}

/** Loads all catalog models from `public/models` (BASE_URL-relative). DEV: missing model throws; PROD: warns and skips. */
export function loadAssets(onProgress?: (fraction: number) => void): Promise<AssetLibrary> {
  const loader = new GLTFLoader();
  const base = import.meta.env.BASE_URL;
  return createAssetLibrary(
    {
      load: async (file) => (await loader.loadAsync(base + file)).scene,
      strict: import.meta.env.DEV,
      warn: (message) => console.warn(message),
    },
    onProgress,
  );
}
