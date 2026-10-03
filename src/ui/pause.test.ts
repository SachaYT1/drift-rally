import { afterAll, describe, expect, it, vi } from 'vitest';
import { createPauseMenu } from './pause';
import { installDom } from './domTestEnv';

const win = await installDom();
afterAll(() => vi.unstubAllGlobals());

describe.skipIf(!win)('pause menu (jsdom)', () => {
  it('labels the preset «Качество графики» so the neuter options agree with it', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const menu = createPauseMenu(root, {
      onResume: () => {},
      onRestart: () => {},
      onGarage: () => {},
      onQuality: () => {},
      onMute: () => {},
      quality: 'medium',
      muted: false,
    });
    const seg = root.querySelector('.dr-seg')!;
    const label = seg.closest('.dr-setting')!.firstElementChild!;
    expect(label.textContent).toBe('Качество графики');
    expect(Array.from(seg.querySelectorAll('button'), (b) => b.textContent)).toEqual(['Низкое', 'Среднее', 'Высокое']);
    menu.destroy();
    root.remove();
  });
});
