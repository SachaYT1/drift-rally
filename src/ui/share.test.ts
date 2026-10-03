import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildShareText, copyText } from './share';

const URL_ = 'https://example.com/drift-rally/';

describe('buildShareText', () => {
  it('contains the grouped points and the url', () => {
    const text = buildShareText(48210, URL_);
    expect(text).toBe(
      'Я набрал 48\u202F210 очков в Drift Rally на трассе «Площадь»! Побей мой рекорд: ' + URL_,
    );
  });
  it('uses the correct plural form', () => {
    expect(buildShareText(1, URL_)).toContain('Я набрал 1 очко ');
    expect(buildShareText(2, URL_)).toContain('Я набрал 2 очка ');
    expect(buildShareText(0, URL_)).toContain('Я набрал 0 очков ');
  });
});

describe('copyText', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the async clipboard when available', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await expect(copyText('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('resolves false (never throws) when nothing can copy', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: () => Promise.reject(new Error('denied')) },
    });
    await expect(copyText('hello')).resolves.toBe(false);
  });

  it('resolves false without navigator and document', async () => {
    vi.stubGlobal('navigator', undefined);
    await expect(copyText('hello')).resolves.toBe(false);
  });
});
