/**
 * DEV-only tuning panel (lil-gui) and frame stats, bound live to TUNING (car / drift / camera). Loaded with a
 * dynamic import from main.ts under import.meta.env.DEV, so neither lil-gui nor stats ship in the build.
 */
import { TUNING } from '../shared/tuning';
import type { App } from './context';

type NumberRecord = Record<string, number>;

/** Slider range and step for a tuning value: 0 .. 3x (sign-aware), step ~1/100 of the magnitude. */
function rangeFor(v: number): { min: number; max: number; step: number } {
  const mag = Math.abs(v) || 1;
  const step = 10 ** Math.floor(Math.log10(mag) - 2);
  return v < 0 ? { min: v * 3, max: 0, step } : { min: 0, max: mag * 3, step };
}

export async function installDebugGui(app: App): Promise<void> {
  const [{ GUI }, { default: Stats }] = await Promise.all([
    import('three/addons/libs/lil-gui.module.min.js'),
    import('three/addons/libs/stats.module.js'),
  ]);

  const gui = new GUI({ title: 'Tuning (DEV)', width: 300 });
  const folders: [string, NumberRecord][] = [
    ['car', TUNING.car],
    ['drift', TUNING.drift],
    ['camera', TUNING.camera],
  ];
  for (const [name, values] of folders) {
    const folder = gui.addFolder(name);
    for (const [key, value] of Object.entries(values)) {
      if (!Number.isFinite(value)) continue;
      const r = rangeFor(value);
      folder.add(values, key, r.min, r.max, r.step);
    }
    folder.close();
  }
  const settings = { quality: app.quality };
  gui
    .add(settings, 'quality', ['low', 'medium', 'high'])
    .onChange((q: string) => {
      if (q === 'low' || q === 'medium' || q === 'high') app.setQuality(q);
    });
  gui.close();

  const stats = new Stats();
  stats.dom.style.cssText = 'position:fixed;left:0;bottom:0;z-index:10000;opacity:0.85;cursor:pointer';
  document.body.appendChild(stats.dom);
  app.onFrame(() => stats.update());
}
