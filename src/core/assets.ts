/**
 * Loads the Kenney models listed in render/catalog.ts and hands out ready-to-place clones.
 *
 * Every model is prepared once into a template: materials converted to flat-shaded
 * MeshLambertMaterial, node transforms and the toy-world scale (realHeight x WORLD_SCALE) baked
 * into the geometry, origin at the ground centre, facing +Z. The pipeline names materials by content
 * ("colormap#<hash>"), so templates using one colormap share a single Lambert material and GPU texture
 * per tint.
 *
 * create() returns a deep clone: its materials are fresh per call (the caller owns them and may fade,
 * tint or dispose them), while geometry and textures stay shared with the template (never mutate or
 * dispose those). Static batching can still merge across clones: materialBatchKey() is equal for
 * clones of the same template material. Shadow flags are left off; the caller decides (buildings and
 * tall decor must not cast shadows, design spec §5).
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CATALOG, WORLD_SCALE, type CatalogEntry } from '../render/catalog';
import type { VisualId } from '../track/trackDef';

export interface AssetLibrary {
  /**
   * Deep-cloned, scaled (×12 of real size via catalog), origin at ground centre, facing +Z; null if the visual is procedural or failed.
   * Materials are per-call clones owned by the caller; geometry and textures are shared (read-only). Variant wraps modulo the count.
   */
  create(visual: VisualId, variant?: number): THREE.Object3D | null;
}

/** Material names written by scripts/build-assets.mjs: "<name>#<hash of the material's look>". */
const CONTENT_KEYED = /#[0-9a-f]{8}$/;

/**
 * Key for merging meshes by material: equal for every clone of one template material (and so across
 * visuals whose source material has the same content key and tint), the material's own uuid otherwise.
 */
export function materialBatchKey(material: THREE.Material): string {
  const key: unknown = material.userData.batchKey;
  return typeof key === 'string' ? key : material.uuid;
}

/** Fresh copy of a template material for one create() call; map textures stay shared. */
function cloneForCaller(material: THREE.Material): THREE.Material {
  const copy = material.clone();
  copy.userData.batchKey = materialBatchKey(material);
  return copy;
}

/** Where model files come from and how failures are handled. Injected so the logic is testable in node. */
export interface AssetSource {
  /** Loads one catalog file (path relative to the base URL) and returns its scene root; `onProgress` per chunk. */
  load(file: string, onProgress?: () => void): Promise<THREE.Object3D>;
  /** true (DEV): a missing model rejects the whole load. false (PROD): warn and skip it. */
  strict: boolean;
  /**
   * Stall deadline, ms (PROD): once no file has made progress or finished for this long, every load still
   * pending fails (and is skipped like a missing model) instead of hanging the loading screen. A slow network
   * that keeps delivering bytes never trips it. Absent: no deadline.
   */
  stallMs?: number;
  warn(message: string): void;
}

/** PROD stall deadline for model downloads, ms (AssetSource.stallMs). */
export const MODEL_STALL_MS = 25_000;

/**
 * One deadline shared by all pending loads, restarted by any activity (progress or a settled load). When it
 * expires every load still pending rejects. Late results of those requests are ignored.
 */
function createStallWatchdog(stallMs: number): { guard<T>(start: (onProgress: () => void) => Promise<T>): Promise<T> } {
  const pending = new Set<(err: Error) => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  function expire(): void {
    timer = undefined;
    const err = new Error(`download stalled (no progress for ${stallMs / 1000} s)`);
    for (const fail of [...pending]) fail(err);
  }

  /** Any download made progress or finished: restart the deadline (while something is still pending). */
  function activity(): void {
    clearTimeout(timer);
    timer = pending.size > 0 ? setTimeout(expire, stallMs) : undefined;
  }

  function guard<T>(start: (onProgress: () => void) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const settle = (): boolean => {
        if (settled) return false;
        settled = true;
        pending.delete(fail);
        activity();
        return true;
      };
      const fail = (err: Error): void => {
        if (settle()) reject(err);
      };
      pending.add(fail);
      activity();
      const onProgress = (): void => {
        if (!settled) activity();
      };
      // A synchronous throw from start() becomes a rejection like any failed load.
      new Promise<T>((started) => started(start(onProgress))).then(
        (value) => {
          if (settle()) resolve(value);
        },
        (err: unknown) => {
          if (settle()) reject(err);
        },
      );
    });
  }

  return { guard };
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

/** Deep clone of a template for one caller: shared geometry and textures, fresh materials. */
function instantiate(template: THREE.Group, visual: VisualId): THREE.Object3D {
  const clone = template.clone();
  clone.userData.visual = visual;
  clone.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const m: THREE.Material | THREE.Material[] = o.material;
    o.material = Array.isArray(m) ? m.map(cloneForCaller) : cloneForCaller(m);
  });
  return clone;
}

/**
 * Turns a loaded scene into a template: a Group of meshes with identity transforms whose geometry
 * is `targetHeight` metres tall, centred on x/z with its lowest point at y = 0. Content-keyed source
 * materials are converted once per `shared` map (one per library), any other material once per call.
 */
export function prepareTemplate(
  scene: THREE.Object3D,
  targetHeight: number,
  tint?: number,
  shared: Map<string, THREE.MeshLambertMaterial> = new Map(),
): THREE.Group {
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  const height = box.max.y - box.min.y;
  if (!(height > 0)) throw new Error(`model "${scene.name}" has no height`);
  const s = targetHeight / height;
  const fit = new THREE.Matrix4()
    .makeTranslation(-((box.min.x + box.max.x) / 2) * s, -box.min.y * s, -((box.min.z + box.max.z) / 2) * s)
    .multiply(new THREE.Matrix4().makeScale(s, s, s));

  const local = new Map<THREE.Material, THREE.MeshLambertMaterial>();
  const convert = (m: THREE.Material): THREE.MeshLambertMaterial => {
    const key = CONTENT_KEYED.test(m.name) ? `${m.name}|${tint ?? 'none'}|${m.vertexColors}` : null;
    const cached = key === null ? local.get(m) : shared.get(key);
    if (cached) return cached;
    const out = toLambert(m, tint);
    if (key === null) local.set(m, out);
    else shared.set(key, out);
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
  const materials = new Map<string, THREE.MeshLambertMaterial>();
  let done = 0;
  let failed = false;
  const watchdog = source.stallMs !== undefined && source.stallMs > 0 ? createStallWatchdog(source.stallMs) : null;
  const load = (file: string): Promise<THREE.Object3D> =>
    watchdog ? watchdog.guard((onProgress) => source.load(file, onProgress)) : source.load(file);
  onProgress?.(0);

  await Promise.all(
    jobs.map(async ({ visual, index, file }) => {
      const entry = catalog[visual];
      let template: THREE.Group | null = null;
      try {
        const scene = await load(file);
        template = prepareTemplate(scene, entry.realHeight * WORLD_SCALE, entry.tint, materials);
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
        if (template) return instantiate(template, visual);
      }
      return null;
    },
  };
}

/**
 * Loads all catalog models from `public/models` (BASE_URL-relative). DEV: a missing model throws; PROD: a
 * missing or stalled one (MODEL_STALL_MS without progress) warns and is skipped.
 */
export function loadAssets(onProgress?: (fraction: number) => void): Promise<AssetLibrary> {
  const loader = new GLTFLoader();
  const base = import.meta.env.BASE_URL;
  return createAssetLibrary(
    {
      load: async (file, onFileProgress) => (await loader.loadAsync(base + file, onFileProgress)).scene,
      strict: import.meta.env.DEV,
      stallMs: import.meta.env.DEV ? undefined : MODEL_STALL_MS,
      warn: (message) => console.warn(message),
    },
    onProgress,
  );
}
