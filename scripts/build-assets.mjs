#!/usr/bin/env node
/**
 * Offline asset pipeline: Kenney CC0 packs -> normalised GLBs + render catalog (design spec §5 Assets).
 *
 *   node scripts/build-assets.mjs           build public/models/*.glb + LICENSES.md, refresh the
 *                                           generated block of src/render/catalog.ts, then verify
 *   node scripts/build-assets.mjs --verify  print file, size, triangle count and height of every GLB
 *
 * Zips are cached in temp/kenney/ (gitignored). A pack page must show the CC0 licence line before
 * its zip is downloaded, and the License.txt inside every zip is checked again before use.
 * Each model: idle pose baked (skinned characters), skins/animations stripped, flattened, joined,
 * deduplicated, metallic 0 / roughness 1, KHR_materials_unlit removed, kit colormap embedded,
 * origin moved to the ground centre and scaled to its real-world height in metres.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  clearNodeTransform, dedup, flatten, getBounds, join as joinPrimitives, prune, transformMesh, unpartition,
} from '@gltf-transform/functions';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(ROOT, 'temp/kenney');
const OUT_DIR = join(ROOT, 'public/models');
const CATALOG_FILE = join(ROOT, 'src/render/catalog.ts');
const CATALOG_BEGIN = '  // BEGIN GENERATED (scripts/build-assets.mjs)';
const CATALOG_END = '  // END GENERATED';
/** Toy-world scale: props are this many times their real size (design spec §3). */
const WORLD_SCALE = 12;
const MAX_TEXTURE_SIZE = 1024;
const MAX_TOTAL_BYTES = 6 * 1024 * 1024;
const CC0_URL = 'creativecommons.org/publicdomain/zero/1.0';

/** Kenney packs: slug on kenney.nl and the folder that holds the binary models inside the zip. */
const PACKS = {
  city: { slug: 'city-kit-commercial', title: 'City Kit (Commercial)', dir: 'Models/GLB format' },
  characters: { slug: 'mini-characters', title: 'Mini Characters', dir: 'Models/GLB format' },
  food: { slug: 'food-kit', title: 'Food Kit', dir: 'Models/GLB format' },
  nature: { slug: 'nature-kit', title: 'Nature Kit', dir: 'Models/GLTF format' },
  coaster: { slug: 'coaster-kit', title: 'Coaster Kit', dir: 'Models/GLB format' },
  holiday: { slug: 'holiday-kit', title: 'Holiday Kit', dir: 'Models/GLB format' },
  fantasy: { slug: 'fantasy-town-kit', title: 'Fantasy Town Kit', dir: 'Models/GLB format' },
};

/**
 * Every VisualId, in trackDef.ts order. realHeight: real-world height in metres; x WORLD_SCALE it
 * must equal VISUAL_HEIGHT (checked by src/core/assets.test.ts); each variant is normalised to it.
 * models: [pack, name] per variant, absent for procedural visuals (render/procedural.ts).
 * pose: animation whose first frame is baked into skinned meshes. tint: runtime colour multiplier.
 */
const VISUALS = {
  officeTower: { realHeight: 25, models: [['city', 'building-skyscraper-b'], ['city', 'building-skyscraper-e']] },
  officeBlock: { realHeight: 12.5, models: [['city', 'building-i'], ['city', 'building-l'], ['city', 'building-n']] },
  person: {
    realHeight: 1.6667,
    pose: 'idle',
    models: [['characters', 'character-female-b'], ['characters', 'character-male-d'], ['characters', 'character-female-e']],
  },
  bench: { realHeight: 0.8, models: [['holiday', 'bench']] },
  lamp: { realHeight: 4, models: [['fantasy', 'lantern']] },
  tree: { realHeight: 5, models: [['coaster', 'tree-large'], ['coaster', 'tree']] },
  // Nature Kit mint shifted toward the Coaster Kit tree green.
  bush: { realHeight: 1, tint: 0x9ccf8a, models: [['nature', 'plant_bushDetailed']] },
  trashBin: { realHeight: 1, models: [['coaster', 'trash']] },
  fountain: { realHeight: 1.5, models: [['fantasy', 'fountain-round-detail']] },
  planterTree: { realHeight: 4.1667 },
  bicycle: { realHeight: 1.0833 },
  sneaker: { realHeight: 0.1333 },
  can: { realHeight: 0.125, models: [['food', 'soda-can']] },
  cup: { realHeight: 0.15, models: [['food', 'soda'], ['food', 'frappe']] },
  startArch: { realHeight: 1 },
};

const out = (line) => process.stdout.write(`${line}\n`);

// ---- Download + licence checks ----

async function fetchOk(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'drift-rally-asset-script' } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res;
}

/** Returns an AdmZip for the pack, downloading it (after a CC0 check of the pack page) if not cached. */
async function openPack(pack) {
  const zipPath = join(CACHE_DIR, `${pack.slug}.zip`);
  if (!existsSync(zipPath)) {
    const pageUrl = `https://kenney.nl/assets/${pack.slug}`;
    const page = await (await fetchOk(pageUrl)).text();
    if (!page.includes('Creative Commons CC0') || !page.includes(CC0_URL)) {
      throw new Error(`${pageUrl}: CC0 licence line not found, refusing to download`);
    }
    const match = page.match(new RegExp(`https://kenney\\.nl/media/pages/assets/${pack.slug}/[^"' ]+\\.zip`));
    if (!match) throw new Error(`${pageUrl}: download link not found`);
    out(`download ${match[0]}`);
    const data = Buffer.from(await (await fetchOk(match[0])).arrayBuffer());
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(zipPath, data);
  }
  const zip = new AdmZip(zipPath);
  if (!/Creative Commons Zero, CC0/.test(zip.readAsText('License.txt'))) throw new Error(`${zipPath}: not CC0`);
  return zip;
}

// ---- Reading ----

/** Splits a GLB into its JSON and BIN chunks. */
function parseGlb(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
  const jsonLength = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8'));
  const binStart = 20 + jsonLength;
  const bin = buf.length > binStart ? buf.subarray(binStart + 8, binStart + 8 + buf.readUInt32LE(binStart)) : null;
  return { json, bin };
}

/** Reads a model straight from the zip, resolving external images (Textures/colormap.png). */
async function readModel(io, zip, pack, name) {
  const entry = `${pack.dir}/${name}.glb`;
  const buf = zip.readFile(entry);
  if (!buf) throw new Error(`${pack.slug}: missing ${entry}`);
  const { json, bin } = parseGlb(buf);
  const resources = bin ? { '@glb.bin': new Uint8Array(bin) } : {};
  for (const image of json.images ?? []) {
    if (!image.uri || image.uri.startsWith('data:')) continue;
    const data = zip.readFile(`${pack.dir}/${decodeURIComponent(image.uri)}`);
    if (!data) throw new Error(`${pack.slug}/${name}: missing texture ${image.uri}`);
    resources[image.uri] = new Uint8Array(data);
  }
  return io.readJSON({ json, resources });
}

// ---- Skinned pose bake ("frozen idle") ----

/** Column-major 4x4 multiply: a * b. */
function mul4(a, b) {
  const r = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let row = 0; row < 4; row++) for (let k = 0; k < 4; k++) r[c * 4 + row] += a[k * 4 + row] * b[c * 4 + k];
  }
  return r;
}

const isIdentity = (m) => m.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-6);

/** Applies the first keyframe of `animName` to the joints and bakes the skinning into the vertices. */
function bakePose(doc, animName) {
  const root = doc.getRoot();
  const anim = root.listAnimations().find((a) => a.getName() === animName);
  if (!anim) throw new Error(`animation "${animName}" not found`);
  for (const channel of anim.listChannels()) {
    const sampler = channel.getSampler();
    const value = sampler.getOutput().getElement(sampler.getInterpolation() === 'CUBICSPLINE' ? 1 : 0, []);
    const node = channel.getTargetNode();
    const path = channel.getTargetPath();
    if (path === 'translation') node.setTranslation(value);
    else if (path === 'rotation') node.setRotation(value);
    else if (path === 'scale') node.setScale(value);
  }
  const buffer = root.listBuffers()[0];
  for (const node of root.listNodes()) {
    const skin = node.getSkin();
    const mesh = node.getMesh();
    if (!skin || !mesh) continue;
    if (!isIdentity(node.getWorldMatrix())) throw new Error(`skinned node ${node.getName()} is transformed`);
    const ibm = skin.getInverseBindMatrices();
    const jointMats = skin.listJoints().map((j, i) => mul4(j.getWorldMatrix(), ibm.getElement(i, [])));
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      const nrm = prim.getAttribute('NORMAL');
      const joints = prim.getAttribute('JOINTS_0');
      const weights = prim.getAttribute('WEIGHTS_0');
      const n = pos.getCount();
      const newPos = new Float32Array(n * 3);
      const newNrm = new Float32Array(n * 3);
      const [p, q, ji, w] = [[], [], [], []];
      const m = new Float64Array(16);
      for (let v = 0; v < n; v++) {
        pos.getElement(v, p);
        joints.getElement(v, ji);
        weights.getElement(v, w);
        m.fill(0);
        const wsum = w.reduce((sum, x) => sum + x, 0) || 1;
        for (let k = 0; k < 4; k++) {
          for (let e = 0; w[k] && e < 16; e++) m[e] += (jointMats[ji[k]][e] * w[k]) / wsum;
        }
        for (let a = 0; a < 3; a++) newPos[v * 3 + a] = m[a] * p[0] + m[4 + a] * p[1] + m[8 + a] * p[2] + m[12 + a];
        if (!nrm) continue;
        nrm.getElement(v, q);
        const t = [0, 1, 2].map((a) => m[a] * q[0] + m[4 + a] * q[1] + m[8 + a] * q[2]);
        const len = Math.hypot(t[0], t[1], t[2]) || 1;
        for (let a = 0; a < 3; a++) newNrm[v * 3 + a] = t[a] / len;
      }
      prim.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(newPos).setBuffer(buffer));
      if (nrm) prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(newNrm).setBuffer(buffer));
      prim.setAttribute('JOINTS_0', null).setAttribute('WEIGHTS_0', null);
    }
    node.setSkin(null);
  }
}

// ---- Normalisation ----

/** TextureInfos of every texture slot the material actually uses. */
const textureInfos = (mat) =>
  [
    [mat.getBaseColorTexture(), mat.getBaseColorTextureInfo()],
    [mat.getEmissiveTexture(), mat.getEmissiveTextureInfo()],
    [mat.getNormalTexture(), mat.getNormalTextureInfo()],
    [mat.getOcclusionTexture(), mat.getOcclusionTextureInfo()],
    [mat.getMetallicRoughnessTexture(), mat.getMetallicRoughnessTextureInfo()],
  ]
    .filter(([texture, info]) => texture && info)
    .map(([, info]) => info);

/** True when every KHR_texture_transform in the document is a no-op (Kenney sets only texCoord). */
const onlyIdentityTransforms = (root) =>
  root.listMaterials().flatMap(textureInfos).every((info) => {
    const t = info.getExtension('KHR_texture_transform');
    if (!t) return true;
    const [[ox, oy], [sx, sy]] = [t.getOffset(), t.getScale()];
    const sameUv = (t.getTexCoord() ?? info.getTexCoord()) === info.getTexCoord();
    return !ox && !oy && sx === 1 && sy === 1 && !t.getRotation() && sameUv;
  });

async function normalise(doc, label) {
  const root = doc.getRoot();
  if (root.listNodes().some((node) => node.getSkin())) throw new Error(`${label}: skinned model needs a pose`);
  // Channels/samplers outlive a disposed Animation and would keep joints and keyframes alive.
  for (const anim of root.listAnimations()) {
    for (const channel of anim.listChannels()) channel.dispose();
    for (const sampler of anim.listSamplers()) sampler.dispose();
    anim.dispose();
  }
  for (const skin of root.listSkins()) skin.dispose();

  for (const mat of root.listMaterials()) mat.setMetallicFactor(0).setRoughnessFactor(1);
  for (const ext of root.listExtensionsUsed()) {
    if (ext.extensionName === 'KHR_materials_unlit') ext.dispose();
    else if (ext.extensionName === 'KHR_texture_transform' && onlyIdentityTransforms(root)) ext.dispose();
  }

  // Lambert + flat shading needs no tangents; drop UV sets no texture reads.
  for (const prim of root.listMeshes().flatMap((mesh) => mesh.listPrimitives())) {
    const mat = prim.getMaterial();
    const used = new Set(mat ? textureInfos(mat).map((info) => info.getTexCoord()) : []);
    prim.setAttribute('TANGENT', null);
    for (const semantic of prim.listSemantics()) {
      const m = semantic.match(/^TEXCOORD_(\d+)$/);
      if (m && !used.has(Number(m[1]))) prim.setAttribute(semantic, null);
    }
  }

  // Kenney colormaps are 512 px; resizing would need sharp, so oversized textures are an error.
  for (const size of root.listTextures().map((texture) => texture.getSize() ?? [Infinity])) {
    if (Math.max(...size) > MAX_TEXTURE_SIZE) throw new Error(`${label}: texture ${size.join('x')} > ${MAX_TEXTURE_SIZE}`);
  }

  await doc.transform(prune(), flatten());
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    if (mesh.listParents().filter((p) => p !== root).length > 1) node.setMesh(mesh.clone());
    clearNodeTransform(node);
  }
}

/** Re-centres on the ground centre and scales to `realHeight` metres. Returns the [x, y, z] size. */
async function fitToGround(doc, realHeight) {
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  const before = getBounds(scene);
  const s = realHeight / (before.max[1] - before.min[1]);
  const cx = (before.min[0] + before.max[0]) / 2;
  const cz = (before.min[2] + before.max[2]) / 2;
  const matrix = [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, -cx * s, -before.min[1] * s, -cz * s, 1];
  for (const mesh of root.listMeshes()) transformMesh(mesh, matrix);
  await doc.transform(joinPrimitives(), dedup(), prune(), unpartition());
  const { min, max } = getBounds(scene);
  return [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
}

const countTriangles = (doc) =>
  doc.getRoot().listMeshes().flatMap((mesh) => mesh.listPrimitives())
    .reduce((sum, prim) => sum + (prim.getIndices() ?? prim.getAttribute('POSITION')).getCount() / 3, 0);

// ---- Outputs ----

/** Rewrites the generated block of src/render/catalog.ts (the rest of that file is hand-written). */
function writeCatalog(entries) {
  const lines = Object.entries(entries).map(([id, e]) => {
    const files = e.files ? `[${e.files.map((f) => `'${f}'`).join(', ')}]` : 'null';
    const tint = e.tint === undefined ? '' : `, tint: 0x${e.tint.toString(16).padStart(6, '0')}`;
    const sizes = e.sizes ? `, sizes: [${e.sizes.map((s) => `[${s.join(', ')}]`).join(', ')}]` : '';
    return `  ${id}: { files: ${files}, realHeight: ${e.realHeight}${tint}${sizes} },`;
  });
  const source = readFileSync(CATALOG_FILE, 'utf8');
  const begin = source.indexOf(CATALOG_BEGIN);
  const end = source.indexOf(CATALOG_END);
  if (begin < 0 || end < begin) throw new Error(`${CATALOG_FILE}: generated-block markers not found`);
  const block = [CATALOG_BEGIN, ...lines, ''].join('\n');
  writeFileSync(CATALOG_FILE, source.slice(0, begin) + block + source.slice(end));
}

function licensesSource(used) {
  const rows = Object.entries(used).map(([key, files]) =>
    `| ${PACKS[key].title} | https://kenney.nl/assets/${PACKS[key].slug} | CC0 1.0 | ${files.join(', ')} |`);
  return `# Model licences

Every \`.glb\` in this folder is generated by \`scripts/build-assets.mjs\` from Kenney asset packs
(www.kenney.nl), released under Creative Commons Zero, CC0 1.0
(https://${CC0_URL}/). Credit is not required; thanks, Kenney.

| Pack | Source | Licence | Files (source model) |
|---|---|---|---|
${rows.join('\n')}
`;
}

// ---- Commands ----

async function build() {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  mkdirSync(OUT_DIR, { recursive: true });
  for (const f of readdirSync(OUT_DIR)) if (f.endsWith('.glb')) rmSync(join(OUT_DIR, f));

  const zips = {};
  const entries = {};
  const used = {};
  for (const [id, visual] of Object.entries(VISUALS)) {
    if (!visual.models) {
      entries[id] = { files: null, realHeight: visual.realHeight };
      continue;
    }
    const files = [];
    const sizes = [];
    for (const [i, [packKey, name]] of visual.models.entries()) {
      const pack = PACKS[packKey];
      zips[packKey] ??= await openPack(pack);
      const doc = await readModel(io, zips[packKey], pack, name);
      if (visual.pose) bakePose(doc, visual.pose);
      await normalise(doc, `${pack.slug}/${name}`);
      const size = await fitToGround(doc, visual.realHeight);
      const file = visual.models.length > 1 ? `${id}-${i + 1}.glb` : `${id}.glb`;
      writeFileSync(join(OUT_DIR, file), await io.writeBinary(doc));
      files.push(`models/${file}`);
      sizes.push(size.map((v) => Number((v * WORLD_SCALE).toFixed(1))));
      (used[packKey] ??= []).push(`${file} (${name})`);
      out(`built ${file.padEnd(18)} <- ${pack.slug}/${name}`);
    }
    entries[id] = { files, realHeight: visual.realHeight, tint: visual.tint, sizes };
  }
  writeCatalog(entries);
  writeFileSync(join(OUT_DIR, 'LICENSES.md'), licensesSource(used));
  out('wrote src/render/catalog.ts (generated block) and public/models/LICENSES.md');
  await verify();
}

/** Prints every GLB with its size, triangle count and height; fails on rule violations. */
async function verify() {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const files = readdirSync(OUT_DIR).filter((f) => f.endsWith('.glb')).sort();
  const problems = [];
  let total = 0;
  const cols = ['KB', 'tris', 'real h', 'world h'].map((c) => c.padStart(9)).join('');
  out(`${'file'.padEnd(20)}${cols}  footprint x * z (world m)`);
  for (const f of files) {
    const buf = readFileSync(join(OUT_DIR, f));
    total += buf.length;
    const doc = await io.readBinary(new Uint8Array(buf));
    const root = doc.getRoot();
    const { min, max } = getBounds(root.listScenes()[0]);
    const h = max[1] - min[1];
    const stats = [(buf.length / 1024).toFixed(1), countTriangles(doc), h.toFixed(3), (h * WORLD_SCALE).toFixed(1)];
    const footprint = `${((max[0] - min[0]) * WORLD_SCALE).toFixed(1)} x ${((max[2] - min[2]) * WORLD_SCALE).toFixed(1)}`;
    out(`${f.padEnd(20)}${stats.map((v) => String(v).padStart(9)).join('')}  ${footprint}`);
    const check = (bad, what) => bad && problems.push(`${f}: ${what}`);
    check(root.listSkins().length || root.listAnimations().length, 'has skins/animations');
    check(root.listExtensionsUsed().some((e) => e.extensionName === 'KHR_materials_unlit'), 'unlit material');
    check(root.listMaterials().some((m) => m.getMetallicFactor() !== 0), 'metallic material');
    check(root.listTextures().some((t) => Math.max(...(t.getSize() ?? [Infinity])) > MAX_TEXTURE_SIZE), 'texture too big');
    check((parseGlb(buf).json.images ?? []).some((img) => img.uri), 'external image (must be embedded)');
    check(Math.abs(min[1]) > 1e-4 || Math.abs(min[0] + max[0]) > 1e-3 || Math.abs(min[2] + max[2]) > 1e-3, 'origin not at ground centre');
  }
  out(`total ${(total / 1024 / 1024).toFixed(2)} MB in ${files.length} files`);
  if (total > MAX_TOTAL_BYTES) problems.push(`total size ${total} exceeds ${MAX_TOTAL_BYTES}`);
  if (problems.length) throw new Error(`verify failed:\n  ${problems.join('\n  ')}`);
  out('verify OK');
}

try {
  if (process.argv.includes('--verify')) await verify();
  else await build();
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.stack : err}\n`);
  process.exit(1);
}
