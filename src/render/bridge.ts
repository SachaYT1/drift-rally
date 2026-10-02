/**
 * The single physics <-> three.js pose bridge (design spec §5).
 *
 * Simulation: heading h has forward (sin h, cos h) and left (cos h, -sin h) in (x, z); +yaw turns LEFT.
 * Three.js: models are built facing +Z (local +X is then the model's LEFT side), so the yaw angle about
 * +Y equals the heading: `object.rotation.y = h`.
 */
import type * as THREE from 'three';

/**
 * Place `obj` at the ground-plane pose (x, z, heading). `y` defaults to 0 (models have their origin at
 * ground level). Pitch and roll are cleared: apply visual tilt to children, never to the posed root.
 */
export function applyPose(obj: THREE.Object3D, x: number, z: number, heading: number, y = 0): void {
  obj.position.set(x, y, z);
  obj.rotation.set(0, heading, 0);
}
