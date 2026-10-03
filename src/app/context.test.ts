import { describe, expect, it, vi } from 'vitest';
import { SMALL_BUFFER, bufferSize, pixelRatioOf, testFlagsFrom, watchPixelRatio } from './context';

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

describe('testFlagsFrom', () => {
  const flags = (q: string) => testFlagsFrom(new URLSearchParams(q));

  it('applies the documented render contract with plain ?test (quality low, small buffer)', () => {
    expect(flags('?test')).toEqual({ test: { enabled: true, small: true }, quality: 'low' });
    expect(flags('?test&small')).toEqual({ test: { enabled: true, small: true }, quality: 'low' });
    expect(flags('?test&quality=bogus')).toEqual({ test: { enabled: true, small: true }, quality: 'low' });
  });

  it('opts out with &full (saved / auto quality) or &quality=<level> (forced, full-size buffer)', () => {
    expect(flags('?test&full')).toEqual({ test: { enabled: true, small: false }, quality: null });
    expect(flags('?test&quality=medium')).toEqual({ test: { enabled: true, small: false }, quality: 'medium' });
    expect(flags('?test&full&quality=high')).toEqual({ test: { enabled: true, small: false }, quality: 'high' });
  });

  it('ignores every test parameter outside test mode', () => {
    expect(flags('')).toEqual({ test: { enabled: false, small: false }, quality: null });
    expect(flags('?quality=low&small')).toEqual({ test: { enabled: false, small: false }, quality: null });
  });
});

describe('pixelRatioOf', () => {
  it('caps devicePixelRatio by quality and pins 1 under the test render contract', () => {
    expect(pixelRatioOf('medium', 2, false)).toBe(1.25);
    expect(pixelRatioOf('high', 1, false)).toBe(1);
    expect(pixelRatioOf('high', 2, true)).toBe(1);
  });
});

describe('watchPixelRatio', () => {
  /** A window whose `(resolution: Ndppx)` queries fire 'change' when the test moves it to another DPR. */
  function fakeWindow(dpr: number) {
    const queries: { media: string; listeners: Set<() => void> }[] = [];
    const win = {
      devicePixelRatio: dpr,
      matchMedia(media: string) {
        const q = { media, listeners: new Set<() => void>() };
        queries.push(q);
        return {
          media,
          addEventListener: (_: string, cb: () => void) => q.listeners.add(cb),
          removeEventListener: (_: string, cb: () => void) => q.listeners.delete(cb),
        } as unknown as MediaQueryList;
      },
      moveTo(next: number) {
        const old = `(resolution: ${win.devicePixelRatio}dppx)`;
        win.devicePixelRatio = next;
        for (const q of queries.filter((x) => x.media === old)) for (const cb of [...q.listeners]) cb();
      },
    };
    return { win, queries };
  }

  it('reports every devicePixelRatio change and re-arms for the new ratio', () => {
    const { win, queries } = fakeWindow(2);
    const onChange = vi.fn();
    const stop = watchPixelRatio(win, onChange);
    expect(queries.map((q) => q.media)).toEqual(['(resolution: 2dppx)']);
    win.moveTo(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(queries.at(-1)?.media).toBe('(resolution: 1dppx)');
    win.moveTo(1.5);
    expect(onChange).toHaveBeenCalledTimes(2);
    stop();
    win.moveTo(2);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(queries.every((q) => q.listeners.size === 0)).toBe(true);
  });
});
