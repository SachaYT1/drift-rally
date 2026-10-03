import { describe, expect, it } from 'vitest';
import { SMALL_BUFFER, bufferSize } from './context';

describe('bufferSize', () => {
  it('uses the canvas size outside small test mode', () => {
    expect(bufferSize(1920, 1080, false)).toEqual({ width: 1920, height: 1080 });
  });

  it('fits the small test buffer while keeping the aspect ratio', () => {
    expect(bufferSize(1280, 720, true)).toEqual({ width: SMALL_BUFFER.width, height: SMALL_BUFFER.height });
    const tall = bufferSize(800, 900, true);
    expect(tall.height).toBe(SMALL_BUFFER.height);
    expect(tall.width / tall.height).toBeCloseTo(800 / 900, 2);
  });

  it('never upscales a canvas smaller than the bound', () => {
    expect(bufferSize(320, 200, true)).toEqual({ width: 320, height: 200 });
  });
});
