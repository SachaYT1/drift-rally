import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { showFatal, showLoading } from './screens';
import { installDom } from './domTestEnv';

const INDEX_HTML = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

describe('index.html boot placeholder', () => {
  it('ships a static logo + loading bar inside #ui, styled inline (no bundle needed)', () => {
    const ui = INDEX_HTML.match(/<div id="ui">([\s\S]*?)<\/div>\s*<noscript>/)?.[1] ?? '';
    expect(ui).toContain('class="dr-boot"');
    expect(ui).toMatch(/DRIFT[\s\S]*RALLY/);
    expect(ui).toContain('dr-boot__bar');
    const inlineCss = INDEX_HTML.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
    expect(inlineCss).toContain('.dr-boot');
    expect(inlineCss).toMatch(/@keyframes\s+dr-boot/);
  });

  it('hides the placeholder when scripts are off, so the noscript notice shows', () => {
    expect(INDEX_HTML).toMatch(/<noscript>\s*<style>[^<]*\.dr-boot[^<]*display:\s*none/);
  });
});

await installDom();
afterAll(() => vi.unstubAllGlobals());

describe('boot placeholder hand-over (jsdom)', () => {
  function rootWithPlaceholder(): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = '<div class="dr-boot"><b>DRIFT RALLY</b></div>';
    document.body.appendChild(root);
    return root;
  }

  it('showLoading() replaces it', () => {
    const root = rootWithPlaceholder();
    const loading = showLoading(root);
    expect(root.querySelector('.dr-boot')).toBeNull();
    expect(root.querySelector('.dr-loading')).not.toBeNull();
    loading.hide();
    root.remove();
  });

  it('showFatal() replaces it too', () => {
    const root = rootWithPlaceholder();
    showFatal(root, 'noWebGL');
    expect(root.querySelector('.dr-boot')).toBeNull();
    expect(root.querySelector('.dr-fatal')).not.toBeNull();
    root.remove();
  });
});
