import { describe, expect, it, vi } from 'vitest';
import { prewarmAudioOutput } from './prewarm';

describe('prewarmAudioOutput', () => {
  it('starts a device enumeration once, without waiting for it', () => {
    const enumerateDevices = vi.fn(() => new Promise<unknown>(() => {}));
    prewarmAudioOutput({ mediaDevices: { enumerateDevices } });
    expect(enumerateDevices).toHaveBeenCalledTimes(1);
  });

  it('handles a rejected enumeration and survives a throwing one (audio is optional)', async () => {
    let handled = false;
    const rejected = Promise.reject(new Error('NotAllowedError'));
    const watched = Object.assign(rejected, {
      catch: (cb: (e: unknown) => unknown) => {
        handled = true;
        return Promise.prototype.catch.call(rejected, cb);
      },
    });
    prewarmAudioOutput({ mediaDevices: { enumerateDevices: () => watched } });
    expect(handled).toBe(true);
    await Promise.resolve();
    const boom = (): Promise<unknown> => {
      throw new Error('boom');
    };
    expect(() => prewarmAudioOutput({ mediaDevices: { enumerateDevices: boom } })).not.toThrow();
  });

  it('is a no-op without navigator.mediaDevices (insecure origin, node)', () => {
    expect(() => prewarmAudioOutput({})).not.toThrow();
    expect(() => prewarmAudioOutput(undefined)).not.toThrow();
    expect(() => prewarmAudioOutput({ mediaDevices: {} })).not.toThrow();
  });
});
