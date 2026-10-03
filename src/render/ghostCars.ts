/**
 * Ghost cars of the bots (plan/2026-10-04-ghost-bots-design.md §4.1): translucent «Искра» models in the bot
 * colours with a floating «name · points» label. No shadows, effects or env map.
 *
 * Translucency without the x-ray look (wheels and seats showing through the body): every mesh draws twice.
 * A depth-only pass (DEPTH_ORDER) writes the ghost's nearest surface into the depth buffer, then the colour
 * pass (COLOUR_ORDER, depthFunc LessEqual, no depth write) blends only that surface. Both passes are
 * transparent objects ordered after the world's transparents (occluders -10, skid marks -2, smoke -1), so the
 * opaque world is complete behind a ghost. Labels draw last, through everything, within LABEL_MAX_DISTANCE.
 */
import * as THREE from 'three';
import type { CarState } from '../shared/types';
import { clamp } from '../shared/math';
import { formatPoints } from '../ui/format';
import { applyPose } from './bridge';
import { createCarModel, type CarModel } from './carModel';

/** Ghost opacity away from the player's car. */
export const GHOST_OPACITY = 0.45;
/**
 * Distance to the player's car, m: a ghost within GHOST_FADE_NEAR overlaps it (start grid) and is not drawn, so
 * it never tints the player's car or piles labels on it; it fades in up to GHOST_OPACITY at GHOST_FADE_FAR.
 */
export const GHOST_FADE_NEAR = 4;
export const GHOST_FADE_FAR = 14;
/** Labels farther than this from the camera are hidden, m. */
export const LABEL_MAX_DISTANCE = 250;

const DEPTH_ORDER = 10;
const COLOUR_ORDER = 11;
const LABEL_ORDER = 12;
/** Below this opacity a ghost is not drawn at all. */
const MIN_VISIBLE_OPACITY = 0.01;
/** Label: height above the ground (m), on-screen height (sizeAttenuation off: fraction of a unit at 1 m). */
const LABEL_Y = 2.7;
const LABEL_HEIGHT = 0.06;
/** Label canvas, px (4:1); text redraws at most this often, s. */
const LABEL_W = 512;
const LABEL_H = 128;
const LABEL_REDRAW = 0.25;

/** One ghost in one render. */
export interface GhostView {
  car: CarState;
  /** Points shown on the label. */
  points: number;
  /** Final opacity of the body (ghostOpacity()). */
  opacity: number;
  visible: boolean;
}

export interface GhostLayer {
  readonly group: THREE.Group;
  /** Build one ghost per entry (colour, label name); replaces the previous roster. */
  setRoster(defs: readonly { name: string; color: number }[]): void;
  /**
   * One render: pose, wheels and body motion, opacity, label. `views[i]` drives ghost i; ghosts without a view
   * are hidden. `snap`: teleport (race start), settle the models. `cameraPos` limits the label range.
   */
  update(views: readonly GhostView[], snap: boolean, dt: number, cameraPos: THREE.Vector3): void;
  hide(): void;
}

/** Body opacity for a ghost `distance` m from the player's car, times `fade` (1 = fully in, 0 = gone). */
export function ghostOpacity(distance: number, fade: number): number {
  const k = Number.isFinite(distance) ? clamp((distance - GHOST_FADE_NEAR) / (GHOST_FADE_FAR - GHOST_FADE_NEAR), 0, 1) : 1;
  return GHOST_OPACITY * k * k * (3 - 2 * k) * clamp(fade, 0, 1);
}

interface Label {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  ctx: CanvasRenderingContext2D | null;
  texture: THREE.CanvasTexture | null;
  name: string;
  color: string;
  /** Points text on the canvas, and seconds since it was drawn. */
  shown: string;
  sinceDraw: number;
}

interface Ghost {
  root: THREE.Group;
  model: CarModel;
  /** Colour-pass materials (opacity follows the view). */
  colourMats: THREE.Material[];
  label: Label;
  opacity: number;
}

function createLabel(name: string, color: number): Label {
  // No 2D canvas outside a browser (unit tests): the label keeps an empty sprite.
  const canvas = typeof document === 'undefined' ? null : document.createElement('canvas');
  const ctx = canvas?.getContext('2d') ?? null;
  let texture: THREE.CanvasTexture | null = null;
  if (canvas && ctx) {
    canvas.width = LABEL_W;
    canvas.height = LABEL_H;
    texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
  }
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false });
  const sprite = new THREE.Sprite(material);
  sprite.name = 'ghost-label';
  sprite.renderOrder = LABEL_ORDER;
  sprite.position.y = LABEL_Y;
  sprite.scale.set((LABEL_HEIGHT * LABEL_W) / LABEL_H, LABEL_HEIGHT, 1);
  sprite.center.set(0.5, 0);
  return { sprite, material, ctx, texture, name, color: `#${new THREE.Color(color).getHexString()}`, shown: '', sinceDraw: Infinity };
}

/** Rounded dark pill, colour dot + name in the bot colour, points in white. */
function drawLabel(l: Label, points: string): void {
  const { ctx } = l;
  if (!ctx || !l.texture) return;
  ctx.clearRect(0, 0, LABEL_W, LABEL_H);
  ctx.font = '800 48px Manrope, sans-serif';
  const name = `${l.name} `;
  const pad = 30;
  const dot = 26;
  const nameW = ctx.measureText(name).width;
  const pointsW = ctx.measureText(points).width;
  const w = Math.min(LABEL_W, pad * 2 + dot + 16 + nameW + pointsW);
  const x0 = (LABEL_W - w) / 2;
  const h = 84;
  const y0 = LABEL_H - h - 4;
  ctx.fillStyle = 'rgba(20, 18, 24, 0.72)';
  ctx.beginPath();
  ctx.roundRect(x0, y0, w, h, h / 2);
  ctx.fill();
  const cy = y0 + h / 2;
  ctx.fillStyle = l.color;
  ctx.beginPath();
  ctx.arc(x0 + pad + dot / 2, cy, dot / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.textBaseline = 'middle';
  ctx.fillText(name, x0 + pad + dot + 16, cy + 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(points, x0 + pad + dot + 16 + nameW, cy + 2);
  l.texture.needsUpdate = true;
}

/** Turn a car model into a ghost: shadowless, cloned translucent colour materials, a depth-only twin per mesh. */
function ghostify(model: CarModel, depthMat: THREE.Material): THREE.Material[] {
  const clones = new Map<THREE.Material, THREE.Material>();
  const meshes: THREE.Mesh[] = [];
  model.root.traverse((o) => {
    if (o instanceof THREE.Mesh) meshes.push(o);
  });
  for (const mesh of meshes) {
    const src = mesh.material as THREE.Material;
    let mat = clones.get(src);
    if (!mat) {
      mat = src.clone();
      mat.transparent = true;
      mat.depthWrite = false;
      mat.depthFunc = THREE.LessEqualDepth;
      clones.set(src, mat);
      src.dispose();
    }
    mesh.material = mat;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = COLOUR_ORDER;
    // A child keeps the mesh's transform (car meshes sit at identity inside their animated groups).
    const depth = new THREE.Mesh(mesh.geometry, depthMat);
    depth.name = 'ghost-depth';
    depth.renderOrder = DEPTH_ORDER;
    depth.castShadow = false;
    mesh.add(depth);
  }
  return [...clones.values()];
}

function setOpacity(g: Ghost, opacity: number): void {
  if (opacity === g.opacity) return;
  g.opacity = opacity;
  for (const m of g.colourMats) m.opacity = opacity;
  // The label stays readable away from the player and fades with the body next to it.
  g.label.material.opacity = clamp(opacity / GHOST_OPACITY, 0, 1);
}

export function createGhostLayer(): GhostLayer {
  const group = new THREE.Group();
  group.name = 'ghosts';
  const depthMat = new THREE.MeshBasicMaterial({ colorWrite: false, transparent: true, depthWrite: true });
  let ghosts: Ghost[] = [];

  function dispose(g: Ghost): void {
    g.root.traverse((o) => {
      if (o instanceof THREE.Mesh && o.material !== depthMat) o.geometry.dispose();
    });
    for (const m of g.colourMats) m.dispose();
    g.label.texture?.dispose();
    g.label.material.dispose();
  }

  return {
    group,
    setRoster(defs) {
      for (const g of ghosts) {
        group.remove(g.root);
        dispose(g);
      }
      ghosts = defs.map((d) => {
        const model = createCarModel(d.color);
        const colourMats = ghostify(model, depthMat);
        const root = new THREE.Group();
        root.name = `ghost-${d.name}`;
        root.visible = false;
        root.add(model.root);
        const label = createLabel(d.name, d.color);
        root.add(label.sprite);
        group.add(root);
        const g: Ghost = { root, model, colourMats, label, opacity: -1 };
        setOpacity(g, GHOST_OPACITY);
        return g;
      });
    },
    update(views, snap, dt, cameraPos) {
      for (let i = 0; i < ghosts.length; i++) {
        const g = ghosts[i];
        const v = views[i];
        if (!v || !v.visible || !(v.opacity >= MIN_VISIBLE_OPACITY)) {
          g.root.visible = false;
          continue;
        }
        const c = v.car;
        const wasHidden = !g.root.visible;
        g.root.visible = true;
        applyPose(g.root, c.x, c.z, c.heading);
        // A ghost that reappears (race start) settles like a teleported car.
        if (snap || wasHidden) g.model.reset();
        g.model.update(c, snap || wasHidden ? 0 : dt);
        setOpacity(g, v.opacity);

        const l = g.label;
        const dx = c.x - cameraPos.x;
        const dz = c.z - cameraPos.z;
        l.sprite.visible = dx * dx + dz * dz <= LABEL_MAX_DISTANCE * LABEL_MAX_DISTANCE;
        l.sinceDraw += dt;
        const text = formatPoints(v.points);
        if (text !== l.shown && l.sinceDraw >= LABEL_REDRAW) {
          l.shown = text;
          l.sinceDraw = 0;
          drawLabel(l, text);
        }
      }
    },
    hide() {
      // Cheap enough for every frame with the ghosts off; a ghost settles when it reappears (update()).
      for (const g of ghosts) g.root.visible = false;
    },
  };
}
