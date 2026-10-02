import { describe, expect, it } from 'vitest';
import { detectQuality, isQualityLevel, pixelRatioFor, shadowsFor } from './quality';

describe('quality', () => {
  it('detects software renderers', () => {
    expect(detectQuality('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))')).toBe('low');
    expect(detectQuality('llvmpipe (LLVM 15.0.7, 256 bits)')).toBe('low');
    expect(detectQuality('ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)')).toBe('medium');
    expect(detectQuality(null)).toBe('medium');
  });
  it('caps pixel ratio per level', () => {
    expect(pixelRatioFor('low', 2)).toBe(1);
    expect(pixelRatioFor('medium', 2)).toBe(1.25);
    expect(pixelRatioFor('high', 2)).toBe(1.5);
    expect(pixelRatioFor('high', 1)).toBe(1);
  });
  it('disables shadows on low', () => {
    expect(shadowsFor('low')).toBe(false);
    expect(shadowsFor('medium')).toBe(true);
  });
});

describe('quality edge cases', () => {
  it('detects other software renderer strings', () => {
    expect(detectQuality('Microsoft Basic Render Driver')).toBe('low');
    expect(detectQuality('Google SwiftShader')).toBe('low');
    expect(detectQuality('Mesa Software Rasterizer')).toBe('low');
    expect(detectQuality('NVIDIA GeForce RTX 3060/PCIe/SSE2')).toBe('medium');
  });
  it('keeps shadows on high', () => expect(shadowsFor('high')).toBe(true));
  it('passes a low devicePixelRatio through and treats an invalid one as 1', () => {
    expect(pixelRatioFor('high', 0.5)).toBe(0.5);
    for (const dpr of [Number.NaN, 0, -2, Number.POSITIVE_INFINITY]) expect(pixelRatioFor('high', dpr)).toBe(1);
  });
  it('recognises quality levels without prototype keys', () => {
    expect(['low', 'medium', 'high'].every(isQualityLevel)).toBe(true);
    for (const v of ['ultra', 'toString', null, 1, undefined]) expect(isQualityLevel(v)).toBe(false);
  });
});
