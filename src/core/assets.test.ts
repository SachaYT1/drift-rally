import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { describe, expect, it, vi } from 'vitest';
import { CATALOG, WORLD_SCALE } from '../render/catalog';
import { VISUAL_HEIGHT, type VisualId } from '../track/trackDef';
import { createAssetLibrary, prepareTemplate, toLambert, type AssetSource } from './assets';

const MODELS_DIR = new URL('../../public/models/', import.meta.url);
const PROCEDURAL: VisualId[] = ['planterTree', 'bicycle', 'sneaker', 'startArch'];
const VISUALS = Object.keys(VISUAL_HEIGHT) as VisualId[];

interface GlbJson {
  extensionsUsed?: string[];
  skins?: unknown[];
  animations?: unknown[];
  images?: { uri?: string; bufferView?: number }[];
  materials?: { pbrMetallicRoughness?: { metallicFactor?: number } }[];
  nodes?: { translation?: number[]; rotation?: number[]; scale?: number[]; matrix?: number[] }[];
  meshes: { primitives: { attributes: Record<string, number> }[] }[];
  accessors: { min?: number[]; max?: number[] }[];
}

function readGlbJson(file: string): GlbJson {
  const buf = readFileSync(new URL(file.replace(/^models\//, ''), MODELS_DIR));
  expect(buf.readUInt32LE(0)).toBe(0x46546c67);
  const length = buf.readUInt32LE(12);
  return JSON.parse(buf.subarray(20, 20 + length).toString('utf8')) as GlbJson;
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
function fakeScene(color = 0x808080): THREE.Object3D {
  const root = new THREE.Group();
  const holder = new THREE.Group();
  holder.position.set(3, -2, 1);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1, 0.25), new THREE.MeshStandardMaterial({ color }));
  mesh.position.set(0.2, 0.5, 0);
  holder.add(mesh);
  root.add(holder);
  return root;
}

function fakeSource(fail: (file: string) => boolean = () => false, strict = true): AssetSource & {
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
      return fail(file) ? Promise.reject(new Error('404')) : Promise.resolve(fakeScene());
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

  it('works on a real built model (bush.glb, no textures) parsed by GLTFLoader', async () => {
    const file = CATALOG.bush.files?.[0] ?? '';
    const buf = readFileSync(new URL(file.replace(/^models\//, ''), MODELS_DIR));
    const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const gltf = await new GLTFLoader().parseAsync(data, '');
    const template = prepareTemplate(gltf.scene, CATALOG.bush.realHeight * WORLD_SCALE);
    const box = worldBox(template);
    expect(box.max.y - box.min.y).toBeCloseTo(VISUAL_HEIGHT.bush, 2);
    expect(box.min.y).toBeCloseTo(0, 3);
    expect(meshes(template).every((m) => m.material instanceof THREE.MeshLambertMaterial)).toBe(true);
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

  it('creates scaled clones that share geometry and materials', async () => {
    const lib = await createAssetLibrary(fakeSource());
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
    expect(ma.material).toBe(mb.material);
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

  it('does not log during a clean load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await createAssetLibrary(fakeSource());
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
