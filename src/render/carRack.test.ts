import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createCarRack } from './carRack';

describe('car rack', () => {
  it('shows one car at a time and builds each model once', () => {
    const parent = new THREE.Group();
    const prepare = vi.fn();
    const rack = createCarRack(parent, prepare);
    expect(rack.currentId).toBe('iskra');
    expect(prepare).toHaveBeenCalledTimes(1);
    const iskra = rack.current;

    const ronin = rack.show('ronin');
    expect(rack.current).toBe(ronin);
    expect(ronin.root.visible).toBe(true);
    expect(iskra.root.visible).toBe(false);
    expect(prepare).toHaveBeenCalledTimes(2);

    expect(rack.show('iskra')).toBe(iskra);
    expect(rack.show('ronin')).toBe(ronin);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(parent.children.filter((c) => c.visible)).toHaveLength(1);
  });

  it('starts on the given car', () => {
    expect(createCarRack(new THREE.Group(), () => {}, 'scarab').currentId).toBe('scarab');
  });
});
