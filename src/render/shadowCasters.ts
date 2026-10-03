/**
 * Shadow-pass program stability. three's shadow map draws every caster with ONE shared MeshDepthMaterial
 * (WebGLShadowMap getDepthMaterial). Whenever consecutive casters differ in instancing, that material's
 * shader variant flips and three re-resolves its program (getParameters + cache key: garbage every time),
 * several times per frame in the race scene (coins and props are InstancedMesh, everything else is Mesh).
 * Giving the instanced casters their own shared depth material keeps both variants stable.
 */
import * as THREE from 'three';

/** three clones a per-material depth variant for these (alpha-tested maps, displacement, clipping): keep that. */
function needsOwnDepthVariant(m: THREE.Material): boolean {
  const mat = m as THREE.Material & { map?: unknown; alphaMap?: unknown; displacementMap?: unknown; displacementScale?: number };
  return (
    (!!(mat.map || mat.alphaMap) && m.alphaTest > 0) ||
    m.alphaToCoverage ||
    (!!mat.displacementMap && mat.displacementScale !== 0) ||
    (m.clipShadows && (m.clippingPlanes?.length ?? 0) > 0)
  );
}

/**
 * Assigns one shared depth material to every shadow-casting InstancedMesh under `root` (those without a custom
 * one or a per-material variant). Call once after the static scene is built. Returns the depth material.
 */
export function separateInstancedShadowCasters(root: THREE.Object3D): THREE.MeshDepthMaterial {
  const depth = new THREE.MeshDepthMaterial();
  depth.name = 'shadow-depth-instanced';
  root.traverse((o) => {
    if (!(o instanceof THREE.InstancedMesh) || !o.castShadow || o.customDepthMaterial) return;
    const mats: THREE.Material[] = Array.isArray(o.material) ? o.material : [o.material];
    if (mats.some(needsOwnDepthVariant)) return;
    o.customDepthMaterial = depth;
  });
  return depth;
}
