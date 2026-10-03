/**
 * Renderer and race lighting (design spec §5 "Rendering rules", plan Task 11).
 *
 * - One WebGLRenderer for the app: NeutralToneMapping, sRGB output, PCFShadowMap (PCFSoft is removed in
 *   r186), pixel ratio and shadows from the quality preset.
 * - Race scene: clear colour = fog colour (soft lavender), Fog(300, 1200) inside camera.far 1500.
 *   No scene.environment (it would add IBL diffuse to every Lambert surface; the car paint gets its
 *   own envMap).
 * - Lights fixed for the whole session: one HemisphereLight + one DirectionalLight. The sun's shadow box
 *   (~170 m, 2048 map) follows the camera look-at point, snapped to whole shadow texels in light space
 *   so shadow edges do not shimmer while driving; the light sits SUN_DISTANCE back along its direction.
 */
import * as THREE from 'three';
import type { QualityLevel } from '../shared/types';
import { pixelRatioFor, shadowsFor } from '../core/quality';

export interface RaceEnvironment {
  scene: THREE.Scene;
  /** Re-centre the shadow box on the camera look-at point (texel-snapped). Does not allocate. */
  updateShadows(focusX: number, focusZ: number): void;
  /** Applies pixel ratio + shadow toggle to the renderer and the sun. */
  setQuality(q: QualityLevel): void;
  /** The shadow-casting sun (read-only use: tests, debug GUI). */
  readonly sun: THREE.DirectionalLight;
}

// ---- Look constants (visual only, not gameplay tuning) ----
export const SKY_COLOR = 0xdcd9e6;
export const FOG_NEAR = 300;
export const FOG_FAR = 1200;
const HEMI_SKY = 0xf3f5f9;
const HEMI_GROUND = 0xc2beb8;
const HEMI_INTENSITY = 1.75;
const SUN_COLOR = 0xfff9f0;
const SUN_INTENSITY = 1.9;
/** Unit vector pointing from the scene TOWARD the sun (south-west, high). */
const SUN_DIR = new THREE.Vector3(-0.42, 0.82, 0.39).normalize();
const SUN_DISTANCE = 400;
export const SHADOW_BOX = 170;
export const SHADOW_MAP_SIZE = 2048;
const SHADOW_NEAR = 150;
const SHADOW_FAR = 650;
const SHADOW_BIAS = -0.0004;
const SHADOW_NORMAL_BIAS = 0.06;

/**
 * Creates the app's single renderer. Throws when WebGL is unavailable (three throws on context
 * creation failure); the caller shows the no-WebGL screen.
 */
export function createRenderer(canvas: HTMLCanvasElement, quality: QualityLevel): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', stencil: false });
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setClearColor(SKY_COLOR, 1);
  applyRendererQuality(renderer, quality);
  return renderer;
}

/** Pixel ratio cap and shadow-map toggle of a quality preset. */
export function applyRendererQuality(renderer: THREE.WebGLRenderer, quality: QualityLevel): void {
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
  renderer.setPixelRatio(pixelRatioFor(quality, dpr));
  renderer.shadowMap.enabled = shadowsFor(quality);
}

/**
 * Light-space basis of a directional light looking along -SUN_DIR, exactly as Matrix4.lookAt builds the
 * shadow camera (z = eye - target, x = up x z, y = z x x with up = +Y).
 */
function lightBasis(): { right: THREE.Vector3; up: THREE.Vector3 } {
  const z = SUN_DIR.clone();
  const right = new THREE.Vector3(0, 1, 0).cross(z).normalize();
  const up = z.clone().cross(right).normalize();
  return { right, up };
}

export function createRaceEnvironment(renderer: THREE.WebGLRenderer, quality: QualityLevel): RaceEnvironment {
  const scene = new THREE.Scene();
  scene.name = 'race';
  scene.background = new THREE.Color(SKY_COLOR);
  scene.fog = new THREE.Fog(SKY_COLOR, FOG_NEAR, FOG_FAR);

  const hemi = new THREE.HemisphereLight(HEMI_SKY, HEMI_GROUND, HEMI_INTENSITY);
  hemi.name = 'hemi';
  hemi.position.set(0, 1, 0);
  hemi.matrixAutoUpdate = false;
  hemi.updateMatrix();

  const sun = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
  sun.name = 'sun';
  const half = SHADOW_BOX / 2;
  const cam = sun.shadow.camera;
  cam.left = -half;
  cam.right = half;
  cam.top = half;
  cam.bottom = -half;
  cam.near = SHADOW_NEAR;
  cam.far = SHADOW_FAR;
  cam.updateProjectionMatrix();
  sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  sun.shadow.bias = SHADOW_BIAS;
  sun.shadow.normalBias = SHADOW_NORMAL_BIAS;
  scene.add(hemi, sun, sun.target);

  const { right, up } = lightBasis();
  const texel = SHADOW_BOX / SHADOW_MAP_SIZE;

  function updateShadows(focusX: number, focusZ: number): void {
    if (!Number.isFinite(focusX) || !Number.isFinite(focusZ)) return;
    // Snap the focus to whole texels along the light's right/up axes; moving along the light
    // direction does not change which texel a point falls in.
    const r = focusX * right.x + focusZ * right.z;
    const u = focusX * up.x + focusZ * up.z;
    const dr = Math.round(r / texel) * texel - r;
    const du = Math.round(u / texel) * texel - u;
    const fx = focusX + right.x * dr + up.x * du;
    const fy = right.y * dr + up.y * du;
    const fz = focusZ + right.z * dr + up.z * du;
    sun.target.position.set(fx, fy, fz);
    sun.position.set(fx + SUN_DIR.x * SUN_DISTANCE, fy + SUN_DIR.y * SUN_DISTANCE, fz + SUN_DIR.z * SUN_DISTANCE);
    sun.target.updateMatrixWorld();
    sun.updateMatrixWorld();
  }

  function setQuality(q: QualityLevel): void {
    applyRendererQuality(renderer, q);
    sun.castShadow = shadowsFor(q);
  }

  setQuality(quality);
  updateShadows(0, 0);
  return { scene, updateShadows, setQuality, sun };
}
