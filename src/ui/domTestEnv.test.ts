import { afterAll, describe, expect, it, vi } from 'vitest';
import { installDom } from './domTestEnv';

afterAll(() => vi.unstubAllGlobals());

describe('installDom (DOM suites never skip silently)', () => {
  it('fails loudly, naming jsdom and the Node version, when jsdom cannot be loaded', async () => {
    // What jsdom 27 throws on Node < 22.12 (no require(esm)): it used to resolve null and skip the suites.
    const requireEsm = Object.assign(new Error('require() of ES Module'), { code: 'ERR_REQUIRE_ESM' });
    const failing = installDom(() => Promise.reject(requireEsm));
    await expect(failing).rejects.toThrow(/jsdom/);
    await expect(failing).rejects.toThrow(process.version);
    await expect(failing).rejects.toMatchObject({ cause: requireEsm });
  });

  it('loads the pinned jsdom on this Node and installs its window as the globals', async () => {
    const win = await installDom();
    expect(win).toBeTruthy();
    expect(globalThis.document).toBe(win.document);
    expect(document.createElement('button')).toBeInstanceOf(HTMLButtonElement);
  });
});
