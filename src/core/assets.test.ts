import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { describe, expect, it, vi } from 'vitest';
import { CATALOG, WORLD_SCALE } from '../render/catalog';
import { VISUAL_HEIGHT, type VisualId } from '../track/trackDef';
import {
  createAssetLibrary, materialBatchKey, prepareTemplate, toLambert, type AssetLibrary, type AssetSource,
} from './assets';

const MODELS_DIR = new URL('../../public/models/', import.meta.url);
const PROCEDURAL: VisualId[] = ['planterTree', 'bicycle', 'sneaker', 'startArch'];
const VISUALS = Object.keys(VISUAL_HEIGHT) as VisualId[];

interface GlbJson {
  extensionsUsed?: string[];
  skins?: unknown[];
  animations?: unknown[];
  images?: { uri?: string; bufferView?: number }[];
  textures?: { source?: number }[];
  bufferViews?: { byteOffset?: number; byteLength: number }[];
  materials?: {
    name?: string;
    alphaMode?: string;
    doubleSided?: boolean;
    emissiveFactor?: number[];
    pbrMetallicRoughness?: { metallicFactor?: number; baseColorFactor?: number[]; baseColorTexture?: { index: number } };
  }[];
  nodes?: { translation?: number[]; rotation?: number[]; scale?: number[]; matrix?: number[] }[];
  meshes: { primitives: { attributes: Record<string, number> }[] }[];
  accessors: { min?: number[]; max?: number[] }[];
}

function readGlb(file: string): { json: GlbJson; bin: Buffer } {
  const buf = readFileSync(new URL(file.replace(/^models\//, ''), MODELS_DIR));
  expect(buf.readUInt32LE(0)).toBe(0x46546c67);
  const length = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + length).toString('utf8')) as GlbJson;
  const binStart = 20 + length;
  return { json, bin: buf.subarray(binStart + 8, binStart + 8 + buf.readUInt32LE(binStart)) };
}

const readGlbJson = (file: string): GlbJson => readGlb(file).json;

/** sha1 of the embedded image behind a texture index, '' when there is none. */
function imageHash(json: GlbJson, bin: Buffer, textureIndex: number | undefined): string {
  if (textureIndex === undefined) return '';
  const view = json.bufferViews?.[json.images?.[json.textures?.[textureIndex]?.source ?? -1]?.bufferView ?? -1];
  if (!view) return 'missing';
  const start = view.byteOffset ?? 0;
  return createHash('sha1').update(bin.subarray(start, start + view.byteLength)).digest('hex');
}

/** A built GLB with its texture references removed: node has no image decoder for GLTFLoader. */
function glbWithoutImages(file: string): ArrayBuffer {
  const { json, bin } = readGlb(file);
  const stripped = { ...json, textures: undefined, images: undefined, samplers: undefined };
  for (const m of stripped.materials ?? []) delete m.pbrMetallicRoughness?.baseColorTexture;
  const text = Buffer.from(JSON.stringify(stripped));
  const jsonChunk = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const header = (length: number, type: number): Buffer => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(length, 0);
    h.writeUInt32LE(type, 4);
    return h;
  };
  const total = 12 + 8 + jsonChunk.length + 8 + bin.length;
  const fileHeader = Buffer.alloc(12);
  fileHeader.writeUInt32LE(0x46546c67, 0);
  fileHeader.writeUInt32LE(2, 4);
  fileHeader.writeUInt32LE(total, 8);
  const out = Buffer.concat([fileHeader, header(jsonChunk.length, 0x4e4f534a), jsonChunk, header(bin.length, 0x004e4942), bin]);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

function worldBox(obj: THREE.Object3D): THREE.Box3 {
  obj.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(obj);
}

function meshes(obj: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  obj.traverse((o) => {
    if (o instanceof THREE.Mesh) out.push(o);
  });
  return out;
}

/** Fake model: an off-centre 1 m tall box, as a loaded glTF scene would look. */
function fakeScene(color = 0x808080, name = '', map: THREE.Texture | null = null): THREE.Object3D {
  const root = new THREE.Group();
  const holder = new THREE.Group();
  holder.position.set(3, -2, 1);
  const material = new THREE.MeshStandardMaterial({ color, name, map });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1, 0.25), material);
  mesh.position.set(0.2, 0.5, 0);
  holder.add(mesh);
  root.add(holder);
  return root;
}

function fakeSource(
  fail: (file: string) => boolean = () => false,
  strict = true,
  scene: () => THREE.Object3D = () => fakeScene(),
): AssetSource & {
  loaded: string[];
  warnings: string[];
} {
  const loaded: string[] = [];
  const warnings: string[] = [];
  return {
    loaded,
    warnings,
    strict,
    warn: (m: string) => warnings.push(m),
    load: (file: string) => {
      loaded.push(file);
      return fail(file) ? Promise.reject(new Error('404')) : Promise.resolve(scene());
    },
  };
}

describe('catalog', () => {
  it('has an entry for every visual with realHeight x WORLD_SCALE = VISUAL_HEIGHT', () => {
    expect(WORLD_SCALE).toBe(12);
    for (const v of VISUALS) {
      expect(CATALOG[v], v).toBeDefined();
      expect(CATALOG[v].realHeight * WORLD_SCALE, v).toBeCloseTo(VISUAL_HEIGHT[v], 2);
    }
  });

  it('uses procedural builders exactly for planterTree, bicycle, sneaker and startArch', () => {
    for (const v of VISUALS) expect(CATALOG[v].files === null, v).toBe(PROCEDURAL.includes(v));
  });

  it('provides the planned variants', () => {
    expect(CATALOG.officeTower.files).toHaveLength(2);
    expect(CATALOG.officeBlock.files?.length).toBeGreaterThanOrEqual(2);
    expect(CATALOG.officeBlock.files?.length).toBeLessThanOrEqual(3);
    expect(CATALOG.person.files).toHaveLength(3);
    expect(CATALOG.tree.files).toHaveLength(2);
  });

  it('lists world-scale sizes that match the visual height', () => {
    for (const v of VISUALS) {
      const { files, sizes } = CATALOG[v];
      if (!files) continue;
      expect(sizes, v).toHaveLength(files.length);
      for (const s of sizes ?? []) expect(s[1], v).toBeCloseTo(VISUAL_HEIGHT[v], 0);
    }
  });
});

describe('built models (public/models)', () => {
  const files = VISUALS.flatMap((v) => (CATALOG[v].files ?? []).map((f) => ({ v, f })));

  it('every catalog file exists and the folder holds no stray models', () => {
    for (const { f } of files) expect(existsSync(new URL(f.replace(/^models\//, ''), MODELS_DIR)), f).toBe(true);
    const onDisk = readdirSync(MODELS_DIR).filter((n) => n.endsWith('.glb'));
    expect(onDisk.sort()).toEqual(files.map(({ f }) => f.replace(/^models\//, '')).sort());
    expect(existsSync(new URL('LICENSES.md', MODELS_DIR))).toBe(true);
  });

  it('stays under 6 MB in total', () => {
    const total = files.reduce((sum, { f }) => sum + statSync(new URL(f.replace(/^models\//, ''), MODELS_DIR)).size, 0);
    expect(total).toBeLessThan(6 * 1024 * 1024);
  });

  it('is static, lit, embedded and normalised to the real height at the ground centre', () => {
    for (const { v, f } of files) {
      const json = readGlbJson(f);
      expect(json.extensionsUsed ?? [], f).not.toContain('KHR_materials_unlit');
      expect(json.skins ?? [], f).toHaveLength(0);
      expect(json.animations ?? [], f).toHaveLength(0);
      for (const img of json.images ?? []) expect(img.uri, f).toBeUndefined();
      for (const m of json.materials ?? []) expect(m.pbrMetallicRoughness?.metallicFactor, f).toBe(0);
      for (const n of json.nodes ?? []) expect(n.translation ?? n.rotation ?? n.scale ?? n.matrix, f).toBeUndefined();
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (const mesh of json.meshes) {
        for (const prim of mesh.primitives) {
          const acc = json.accessors[prim.attributes.POSITION];
          for (let i = 0; i < 3; i++) {
            min[i] = Math.min(min[i], acc.min?.[i] ?? Infinity);
            max[i] = Math.max(max[i], acc.max?.[i] ?? -Infinity);
          }
        }
      }
      expect(min[1], f).toBeCloseTo(0, 3);
      expect(max[1] - min[1], f).toBeCloseTo(CATALOG[v].realHeight, 3);
      expect(min[0] + max[0], f).toBeCloseTo(0, 2);
      expect(min[2] + max[2], f).toBeCloseTo(0, 2);
    }
  });

  it('names materials by content, so equal names mean equal materials across files', () => {
    const looks = new Map<string, string>();
    for (const { f } of files) {
      const { json, bin } = readGlb(f);
      for (const m of json.materials ?? []) {
        expect(m.name, f).toMatch(/#[0-9a-f]{8}$/);
        const pbr = m.pbrMetallicRoughness;
        const look = JSON.stringify([
          pbr?.baseColorFactor, m.emissiveFactor, m.alphaMode, m.doubleSided, imageHash(json, bin, pbr?.baseColorTexture?.index),
        ]);
        const name = m.name ?? '';
        expect(looks.get(name) ?? look, `${f}: ${name}`).toBe(look);
        looks.set(name, look);
      }
    }
    // The five City Kit buildings end up on one material (one texture on the GPU).
    const city = [...(CATALOG.officeTower.files ?? []), ...(CATALOG.officeBlock.files ?? [])];
    expect(new Set(city.flatMap((f) => (readGlbJson(f).materials ?? []).map((m) => m.name))).size).toBe(1);
  });
});

describe('toLambert', () => {
  it('keeps colour, map, side and transparency and enables flat shading', () => {
    const map = new THREE.Texture();
    const src = new THREE.MeshStandardMaterial({
      color: 0x336699,
      map,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
    });
    const out = toLambert(src);
    expect(out).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(out.flatShading).toBe(true);
    expect(out.map).toBe(map);
    expect(out.color.getHex()).toBe(0x336699);
    expect(out.side).toBe(THREE.DoubleSide);
    expect(out.transparent).toBe(true);
    expect(out.opacity).toBeCloseTo(0.6);
    expect(out.depthWrite).toBe(false);
  });

  it('converts unlit (MeshBasicMaterial) sources and applies a tint', () => {
    const out = toLambert(new THREE.MeshBasicMaterial({ color: 0xffffff }), 0x8040ff);
    expect(out).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(out.color.getHex()).toBe(0x8040ff);
  });
});

describe('prepareTemplate', () => {
  it('scales to the target height, puts the origin at the ground centre and bakes transforms', () => {
    const template = prepareTemplate(fakeScene(), 20);
    const box = worldBox(template);
    expect(box.max.y - box.min.y).toBeCloseTo(20, 4);
    expect(box.min.y).toBeCloseTo(0, 4);
    expect(box.min.x + box.max.x).toBeCloseTo(0, 4);
    expect(box.min.z + box.max.z).toBeCloseTo(0, 4);
    for (const m of meshes(template)) {
      expect(m.material).toBeInstanceOf(THREE.MeshLambertMaterial);
      expect(m.matrixWorld.equals(new THREE.Matrix4())).toBe(true);
    }
  });

  it('works on a real built model (fountain.glb) parsed by GLTFLoader', async () => {
    const gltf = await new GLTFLoader().parseAsync(glbWithoutImages(CATALOG.fountain.files?.[0] ?? ''), '');
    const template = prepareTemplate(gltf.scene, CATALOG.fountain.realHeight * WORLD_SCALE);
    const box = worldBox(template);
    expect(box.max.y - box.min.y).toBeCloseTo(VISUAL_HEIGHT.fountain, 2);
    expect(box.min.y).toBeCloseTo(0, 3);
    const materials = meshes(template).flatMap((m) => m.material);
    expect(materials.every((m) => m instanceof THREE.MeshLambertMaterial && m.flatShading)).toBe(true);
    // The water stays a separate see-through material.
    expect(materials.filter((m) => m.transparent && !m.depthWrite)).toHaveLength(1);
  });
});

describe('createAssetLibrary', () => {
  it('loads every model file once and reports monotonic progress ending at 1', async () => {
    const src = fakeSource();
    const progress: number[] = [];
    await createAssetLibrary(src, (f) => progress.push(f));
    const expected = VISUALS.flatMap((v) => CATALOG[v].files ?? []);
    expect(src.loaded.sort()).toEqual([...expected].sort());
    expect(progress[0]).toBe(0);
    expect(progress[progress.length - 1]).toBe(1);
    for (let i = 1; i < progress.length; i++) expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]);
  });

  it('returns null for procedural visuals', async () => {
    const lib = await createAssetLibrary(fakeSource());
    for (const v of PROCEDURAL) expect(lib.create(v)).toBeNull();
  });

  it('creates deep clones: own materials (same batch key), shared geometry and textures', async () => {
    const map = new THREE.Texture();
    const lib = await createAssetLibrary(fakeSource(undefined, true, () => fakeScene(0xffffff, 'colormap#0123abcd', map)));
    const a = lib.create('person', 1);
    const b = lib.create('person', 1);
    expect(a).not.toBeNull();
    expect(a).not.toBe(b);
    if (!a || !b) return;
    const box = worldBox(a);
    expect(box.max.y - box.min.y).toBeCloseTo(VISUAL_HEIGHT.person, 2);
    expect(box.min.y).toBeCloseTo(0, 4);
    const [ma] = meshes(a);
    const [mb] = meshes(b);
    expect(ma.geometry).toBe(mb.geometry);
    const [matA, matB] = [ma.material, mb.material] as THREE.MeshLambertMaterial[];
    expect(matA).not.toBe(matB);
    expect(matA.map).toBe(map);
    expect(matB.map).toBe(map);
    expect(materialBatchKey(matA)).toBe(materialBatchKey(matB));
    // Fading one knocked prop or occluder must not fade its siblings.
    matA.transparent = true;
    matA.opacity = 0.25;
    expect(matB.opacity).toBe(1);
    const c = lib.create('person', 1);
    expect(c ? (meshes(c)[0].material as THREE.MeshLambertMaterial).opacity : null).toBe(1);
  });

  it('shares one Lambert material per content-keyed source material and tint across visuals', async () => {
    const keyed = await createAssetLibrary(fakeSource(undefined, true, () => fakeScene(0xffffff, 'colormap#0123abcd')));
    const key = (lib: AssetLibrary, v: VisualId): string => {
      const obj = lib.create(v);
      if (!obj) throw new Error(`no ${v}`);
      return materialBatchKey(meshes(obj)[0].material as THREE.Material);
    };
    expect(CATALOG.officeTower.tint).toBe(CATALOG.officeBlock.tint);
    expect(key(keyed, 'officeTower')).toBe(key(keyed, 'officeBlock'));
    expect(key(keyed, 'person')).toBe(key(keyed, 'bench'));
    expect(key(keyed, 'person')).not.toBe(key(keyed, 'officeTower'));
    // Materials without a content key (not from the pipeline) are never merged across templates.
    const plain = await createAssetLibrary(fakeSource());
    expect(key(plain, 'person')).not.toBe(key(plain, 'bench'));
  });

  it('wraps variant indices', async () => {
    const lib = await createAssetLibrary(fakeSource());
    const n = CATALOG.person.files?.length ?? 0;
    const geomOf = (o: THREE.Object3D | null) => (o ? meshes(o)[0].geometry : null);
    expect(geomOf(lib.create('person', n + 1))).toBe(geomOf(lib.create('person', 1)));
    expect(geomOf(lib.create('person', -1))).toBe(geomOf(lib.create('person', n - 1)));
    expect(geomOf(lib.create('person'))).toBe(geomOf(lib.create('person', 0)));
  });

  it('throws on a missing model in strict (DEV) mode', async () => {
    const src = fakeSource((f) => f.includes('lamp'), true);
    await expect(createAssetLibrary(src)).rejects.toThrow(/lamp/);
  });

  it('warns and skips missing models in non-strict (PROD) mode', async () => {
    const tower2 = CATALOG.officeTower.files?.[1] ?? '';
    const src = fakeSource((f) => f.includes('lamp') || f === tower2, false);
    const lib = await createAssetLibrary(src);
    expect(src.warnings.length).toBe(2);
    expect(lib.create('lamp')).toBeNull();
    // A failed variant falls back to a loaded one of the same visual.
    expect(lib.create('officeTower', 1)).not.toBeNull();
    expect(lib.create('tree')).not.toBeNull();
  });

  describe('stalled downloads (PROD stallMs)', () => {
    const lampFiles = CATALOG.lamp.files ?? [];

    /** Lamps never answer; every other file loads after `delayMs`, reporting progress every `tickMs`. */
    function stallingSource(stallMs: number, delayMs = 0, tickMs = 0): AssetSource & { warnings: string[] } {
      const warnings: string[] = [];
      return {
        warnings,
        strict: false,
        stallMs,
        warn: (m: string) => warnings.push(m),
        load: (file: string, onProgress?: () => void) =>
          new Promise<THREE.Object3D>((resolve) => {
            if (lampFiles.includes(file)) return; // a request that hangs forever
            if (tickMs > 0) {
              const tick = setInterval(() => onProgress?.(), tickMs);
              setTimeout(() => clearInterval(tick), delayMs);
            }
            setTimeout(() => resolve(fakeScene()), delayMs);
          }),
      };
    }

    it('skips a model whose request never answers instead of hanging the loading screen', async () => {
      vi.useFakeTimers();
      try {
        const src = stallingSource(25_000);
        const progress: number[] = [];
        let lib: AssetLibrary | null = null;
        void createAssetLibrary(src, (f) => progress.push(f)).then((l) => (lib = l));
        await vi.advanceTimersByTimeAsync(24_000);
        expect(lib).toBeNull();
        await vi.advanceTimersByTimeAsync(1_001);
        expect(lib).not.toBeNull();
        expect(src.warnings.length).toBe(lampFiles.length);
        expect(src.warnings[0]).toMatch(/lamp.*stalled/);
        expect(lib!.create('lamp')).toBeNull();
        expect(lib!.create('tree')).not.toBeNull();
        expect(progress.at(-1)).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('waits for slow downloads that keep making progress (slow network, not a stall)', async () => {
      vi.useFakeTimers();
      try {
        // Every working file takes 60 s (longer than stallMs) but reports progress every 5 s.
        const src = stallingSource(25_000, 60_000, 5_000);
        let lib: AssetLibrary | null = null;
        void createAssetLibrary(src).then((l) => (lib = l));
        await vi.advanceTimersByTimeAsync(60_001);
        expect(lib).toBeNull(); // the lamps are still pending: the stall clock starts with the last progress
        expect(src.warnings).toEqual([]);
        await vi.advanceTimersByTimeAsync(25_000);
        expect(lib).not.toBeNull();
        expect(lib!.create('tree')).not.toBeNull();
        expect(src.warnings.length).toBe(lampFiles.length);
      } finally {
        vi.useRealTimers();
      }
    });

    it('has no deadline without stallMs (DEV, tests)', async () => {
      vi.useFakeTimers();
      try {
        const src = { ...stallingSource(25_000), stallMs: undefined };
        let settled = false;
        void createAssetLibrary(src).finally(() => (settled = true));
        await vi.advanceTimersByTimeAsync(600_000);
        expect(settled).toBe(false);
        expect(src.warnings).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('does not log during a clean load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await createAssetLibrary(fakeSource());
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
