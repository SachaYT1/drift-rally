/**
 * Static race world (plan Task 11): plaza paving over def.ground, a pale surround to the horizon, the
 * wooden deck strip along the south edge (raised, the spectator stands on it), decor from track.decor
 * (Kenney assets or procedural builders), heavy obstacles from track.heavyPlacements (procedural bench,
 * bicycle, sneaker) and a backdrop of office buildings closing the west and south horizons.
 *
 * - Asset decor is merged per sector by materialBatchKey (worldDecor.ts); buildings and tall decor do
 *   not cast shadows (design spec §5) and get a soft contact blob instead.
 * - Leaf and building atlases are recoloured (recolor.ts) toward the reference's fresh green / pastel look.
 * - Occluder-tagged decor and obstacles stay separate objects; World.occluders lists their fade units
 *   for createOcclusionFader().
 * Everything is static: matrixAutoUpdate false, matrices baked once here; nothing to update per frame.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { AssetLibrary } from '../core/assets';
import type { Track } from '../track/build';
import { VISUAL_HEIGHT, type DecorDef, type VisualId } from '../track/trackDef';
import { applyPose } from './bridge';
import { CATALOG } from './catalog';
import { createBench, createBicycle, createPlanterTree, createSneaker, createStartArch, findOccluderGroups } from './procedural';
import { BlobBatcher, StaticBatcher, restyleObject } from './worldDecor';
import { createPlankTexture, createTileTexture } from './groundTextures';
import { buildingPixel, createRecolorer, foliagePixel } from './recolor';

export interface World {
  group: THREE.Group;
  /** Fade units for createOcclusionFader (bench seat + backrest, start arch, planter canopy). */
  occluders: THREE.Object3D[];
}

// ---- Look constants ----
const PLAZA_TILE_REPEAT = 24;
const SURROUND_SIZE = 6000;
const SURROUND_Y = -0.05;
/** Ground subdivision cell sizes, m. */
const PLAZA_CELL = 40;
const SURROUND_CELL = 200;
const COLORS = {
  plaza: 0xe9eae6,
  plazaGrout: 0xd2d2ce,
  surround: 0xdad7df,
  deckPlanks: [0xd9b48a, 0xcfa77c, 0xe2bf95, 0xd4ad83],
  deckSeam: 0x9c7552,
};
/** Deck strip (world z range and top height), south of the start straight. */
export const DECK = { z0: 178, z1: 256, height: 1.2 } as const;
const DECK_PLANK_REPEAT = 16;
/** Front/back faces of the deck are darkened through vertex colours. */
const DECK_SIDE_SHADE = 0.62;
/** Decor taller than this (scaled, m) does not cast shadows (design spec §5: no tall-decor shadows). */
const SHADOW_HEIGHT_LIMIT = 30;
/** Contact blob radius as a share of the decor's footprint size. */
const BLOB_SHARE = 0.42;
/** Start arch posts stand this far outside the barriers, m. */
const ARCH_MARGIN = 1;
const BUILDINGS = new Set<VisualId>(['officeTower', 'officeBlock']);
const FOLIAGE = new Set<VisualId>(['tree', 'bush']);

/** Extra office buildings outside def.ground's decor rows (world coordinates), facing the plaza. */
const BACKDROP: { visual: VisualId; x: number; z: number; yaw: number }[] = [
  // West edge, facing east (gap around z 20 keeps the corner tree free).
  { visual: 'officeTower', x: -470, z: -230, yaw: Math.PI / 2 },
  { visual: 'officeBlock', x: -470, z: -90, yaw: Math.PI / 2 },
  { visual: 'officeBlock', x: -470, z: 130, yaw: Math.PI / 2 },
  { visual: 'officeTower', x: -470, z: 280, yaw: Math.PI / 2 },
  // South edge beyond the deck, facing north.
  { visual: 'officeBlock', x: -330, z: 390, yaw: Math.PI },
  { visual: 'officeTower', x: -180, z: 400, yaw: Math.PI },
  { visual: 'officeBlock', x: -30, z: 390, yaw: Math.PI },
  { visual: 'officeTower', x: 120, z: 400, yaw: Math.PI },
  { visual: 'officeBlock', x: 270, z: 390, yaw: Math.PI },
  { visual: 'officeTower', x: 430, z: 400, yaw: Math.PI },
];

/** Ground height under decor: the deck spans the full plaza width. */
function groundHeightAt(z: number): number {
  return z >= DECK.z0 && z <= DECK.z1 ? DECK.height : 0;
}

/** Deterministic variant pick from a position. */
function variantAt(x: number, z: number): number {
  return Math.abs(Math.round(x * 7 + z * 13));
}

function staticMesh(name: string, geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

/**
 * Horizontal rectangle at height y with world-space UVs (1 unit = `repeat` m), split into cells of about
 * `cell` m. Huge single triangles get clipped by the near plane and their interpolated depth drifts by
 * more than the 2-4 cm between ground layers, so big planes are always subdivided.
 */
function groundRect(x0: number, z0: number, x1: number, z1: number, y: number, repeat: number, cell: number): THREE.BufferGeometry {
  const nx = Math.max(1, Math.ceil((x1 - x0) / cell));
  const nz = Math.max(1, Math.ceil((z1 - z0) / cell));
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const x = x0 + ((x1 - x0) * i) / nx;
      const z = z0 + ((z1 - z0) * j) / nz;
      pos.push(x, y, z);
      nor.push(0, 1, 0);
      uv.push(x / repeat, z / repeat);
    }
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      const b = a + 1;
      const c = a + nx + 1;
      const d = c + 1;
      // Counter-clockwise seen from above (+Y): a(x0,z0) d(x1,z1) b(x1,z0) and a c(x0,z1) d.
      index.push(a, d, b, a, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  return g;
}

function plazaGround(track: Track): THREE.Mesh {
  const { minX, minZ, maxX, maxZ } = track.ground;
  const tex = createTileTexture({ size: 256, tiles: 4, base: COLORS.plaza, grout: COLORS.plazaGrout, groutPx: 3, variation: 0.018, speckle: 0.012, seed: 3 });
  const material = new THREE.MeshLambertMaterial({ map: tex });
  material.name = 'world-plaza';
  return staticMesh('world-plaza', groundRect(minX, minZ, maxX, maxZ, 0, PLAZA_TILE_REPEAT, PLAZA_CELL), material);
}

/** Pale ground to the horizon: a frame AROUND the plaza (never under it), slightly lower. */
function surround(track: Track): THREE.Mesh {
  const h = SURROUND_SIZE / 2;
  const { minX, minZ, maxX, maxZ } = track.ground;
  const pieces = [
    groundRect(-h, -h, h, minZ, SURROUND_Y, 1, SURROUND_CELL),
    groundRect(-h, maxZ, h, h, SURROUND_Y, 1, SURROUND_CELL),
    groundRect(-h, minZ, minX, maxZ, SURROUND_Y, 1, SURROUND_CELL),
    groundRect(maxX, minZ, h, maxZ, SURROUND_Y, 1, SURROUND_CELL),
  ];
  const merged = mergeGeometries(pieces, false);
  if (!merged) throw new Error('world: cannot build the surround');
  const material = new THREE.MeshLambertMaterial({ color: COLORS.surround });
  material.name = 'world-surround';
  const mesh = staticMesh('world-surround', merged, material);
  mesh.receiveShadow = false;
  return mesh;
}

/** Raised wooden deck: textured top plus darker front (north) and back faces, one draw call. */
function deck(track: Track): THREE.Mesh {
  const x0 = track.ground.minX;
  const x1 = track.ground.maxX;
  const { z0, z1, height: h } = DECK;
  const r = DECK_PLANK_REPEAT;
  const s = DECK_SIDE_SHADE;
  // Top (4 verts), front face at z0 facing -Z (4), back face at z1 facing +Z (4).
  const pos = [x0, h, z0, x1, h, z0, x1, h, z1, x0, h, z1, x0, 0, z0, x1, 0, z0, x1, h, z0, x0, h, z0, x0, 0, z1, x1, 0, z1, x1, h, z1, x0, h, z1];
  const nor = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
  const uv = [x0 / r, z0 / r, x1 / r, z0 / r, x1 / r, z1 / r, x0 / r, z1 / r];
  for (let k = 0; k < 2; k++) uv.push(x0 / r, 0, x1 / r, 0, x1 / r, h / r, x0 / r, h / r);
  const col = [...Array(12).fill(1), ...Array(24).fill(s)];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex([0, 2, 1, 0, 3, 2, 4, 6, 5, 4, 7, 6, 8, 9, 10, 8, 10, 11]);
  const tex = createPlankTexture(128, 8, COLORS.deckPlanks, COLORS.deckSeam, 5);
  const material = new THREE.MeshLambertMaterial({ map: tex, vertexColors: true });
  material.name = 'world-deck';
  const mesh = staticMesh('world-deck', g, material);
  mesh.castShadow = true;
  return mesh;
}

/** Procedural builder for visuals without model files. */
function createProcedural(visual: VisualId, track: Track): THREE.Group | null {
  switch (visual) {
    case 'bench':
      return createBench();
    case 'bicycle':
      return createBicycle();
    case 'sneaker':
      return createSneaker();
    case 'planterTree':
      return createPlanterTree();
    case 'startArch':
      return createStartArch(2 * (track.barrier + ARCH_MARGIN));
    default:
      return null;
  }
}

/** Fade units of an occluder object: its tagged groups, or the whole object. */
function occluderUnits(root: THREE.Object3D): THREE.Object3D[] {
  const groups = findOccluderGroups(root);
  return groups.length > 0 ? groups : [root];
}

function freeze(root: THREE.Object3D): void {
  root.traverse((o) => {
    o.matrixAutoUpdate = false;
    o.updateMatrix();
  });
  root.updateMatrixWorld(true);
}

export function createWorld(track: Track, assets: AssetLibrary): World {
  const group = new THREE.Group();
  group.name = 'world';
  const occluders: THREE.Object3D[] = [];
  const statics = new StaticBatcher();
  const blobs = new BlobBatcher();
  const foliageMap = createRecolorer(foliagePixel);
  const buildingMap = createRecolorer(buildingPixel);

  group.add(surround(track), plazaGround(track), deck(track));

  const placeAsset = (visual: VisualId, x: number, z: number, yaw: number, scale: number): void => {
    const obj = assets.create(visual, variantAt(x, z));
    if (!obj) return;
    if (BUILDINGS.has(visual)) restyleObject(obj, 'building', { map: buildingMap });
    if (FOLIAGE.has(visual)) restyleObject(obj, 'foliage', { map: foliageMap });
    applyPose(obj, x, z, yaw, groundHeightAt(z));
    obj.scale.setScalar(scale);
    const height = VISUAL_HEIGHT[visual] * scale;
    const cast = !BUILDINGS.has(visual) && height <= SHADOW_HEIGHT_LIMIT;
    statics.add(obj, cast);
    if (!cast && !BUILDINGS.has(visual)) {
      const size = CATALOG[visual].sizes?.[variantAt(x, z) % (CATALOG[visual].sizes?.length ?? 1)];
      const footprint = size ? Math.max(size[0], size[2]) : height * 0.4;
      blobs.add(x, z, footprint * BLOB_SHARE * scale, groundHeightAt(z));
    }
  };

  const placeDecor = (d: { def: DecorDef; x: number; z: number }): void => {
    const scale = d.def.scale ?? 1;
    const proc = CATALOG[d.def.visual].files === null ? createProcedural(d.def.visual, track) : null;
    if (!proc) {
      if (d.def.occluder) {
        // Occluder-tagged asset decor stays its own object so it can fade.
        const obj = assets.create(d.def.visual, variantAt(d.x, d.z));
        if (!obj) return;
        applyPose(obj, d.x, d.z, d.def.yaw, groundHeightAt(d.z));
        obj.scale.setScalar(scale);
        freeze(obj);
        group.add(obj);
        occluders.push(obj);
        return;
      }
      placeAsset(d.def.visual, d.x, d.z, d.def.yaw, scale);
      return;
    }
    applyPose(proc, d.x, d.z, d.def.yaw, groundHeightAt(d.z));
    proc.scale.setScalar(scale);
    freeze(proc);
    group.add(proc);
    if (d.def.occluder) occluders.push(...occluderUnits(proc));
  };

  for (const d of track.decor) placeDecor(d);
  for (const b of BACKDROP) placeAsset(b.visual, b.x, b.z, b.yaw, 1);

  for (const { def, pose } of track.heavyPlacements) {
    const obj = createProcedural(def.visual, track) ?? assets.create(def.visual);
    if (!obj) {
      console.warn(`world: no visual for heavy obstacle ${def.id} (${def.visual})`);
      continue;
    }
    obj.name = `heavy:${def.id}`;
    applyPose(obj, pose.x, pose.z, pose.heading);
    freeze(obj);
    group.add(obj);
    if (def.occluder) occluders.push(...occluderUnits(obj));
  }

  for (const mesh of statics.build()) group.add(mesh);
  const blobMesh = blobs.build();
  if (blobMesh) group.add(blobMesh);

  freeze(group);
  return { group, occluders };
}
