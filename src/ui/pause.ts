/** Pause menu: resume / restart / garage, quality preset, mute. Esc handling lives in the app (input actions). */
import type { QualityLevel } from '../shared/types';
import { createLayer, keyHtml, qs } from './screens';

export interface PauseMenu {
  show(): void;
  hide(): void;
  readonly visible: boolean;
  /** Re-sync the settings controls (e.g. after M toggled mute during the race). */
  sync(s: { quality?: QualityLevel; muted?: boolean }): void;
  destroy(): void;
}

/** Set on the UI root while paused; styles.css pauses HUD CSS animations under it. */
const PAUSED_CLASS = 'dr-paused';

const QUALITY_LABELS: readonly [QualityLevel, string][] = [
  ['low', 'Низкое'],
  ['medium', 'Среднее'],
  ['high', 'Высокое'],
];

export function createPauseMenu(
  root: HTMLElement,
  h: {
    onResume(): void;
    onRestart(): void;
    onGarage(): void;
    onQuality(q: QualityLevel): void;
    onMute(m: boolean): void;
    quality: QualityLevel;
    muted: boolean;
  },
): PauseMenu {
  const layer = createLayer(
    root,
    'dr-pause',
    `<div class="dr-dim"></div>
    <div class="dr-panel dr-pause__card" role="dialog" aria-modal="true" aria-labelledby="dr-pause-title">
      <h2 class="dr-h dr-pause__title" id="dr-pause-title">Пауза</h2>
      <p class="dr-pause__sub">Заезд остановлен — таймер и очки ждут вас.</p>
      <div class="dr-pause__actions">
        <button type="button" class="dr-btn dr-btn--primary" data-act="resume">Продолжить ${keyHtml('Esc')}</button>
        <button type="button" class="dr-btn" data-act="restart">Заново</button>
        <button type="button" class="dr-btn" data-act="garage">В гараж</button>
      </div>
      <div class="dr-settings">
        <div class="dr-setting"><span>Графика</span>
          <div class="dr-seg" role="group" aria-label="Качество графики">${QUALITY_LABELS.map(
            ([q, label]) => `<button type="button" data-quality="${q}" aria-pressed="false">${label}</button>`,
          ).join('')}</div>
        </div>
        <div class="dr-setting"><span>Звук${keyHtml('M')}</span>
          <button type="button" class="dr-toggle" role="switch" aria-checked="false" aria-label="Звук" data-act="mute"></button>
        </div>
      </div>
    </div>`,
  );
  layer.hidden = true;

  const qualityButtons = Array.from(layer.querySelectorAll<HTMLButtonElement>('[data-quality]'));
  const muteToggle = qs<HTMLButtonElement>(layer, '[data-act="mute"]');
  let quality = h.quality;
  let muted = h.muted;
  let visible = false;
  let frozen: Animation[] = [];

  /**
   * Pause freezes everything (spec §2.4), including UI motion tied to race time such as the chain
   * grace drain bar: CSS animations via PAUSED_CLASS, Web Animations (flashes, toasts, countdown)
   * via pause()/play(). The pause menu's own animations are left alone.
   */
  function freezeAnimations(): void {
    root.classList.add(PAUSED_CLASS);
    if (typeof root.getAnimations !== 'function') return;
    frozen = root.getAnimations({ subtree: true }).filter((a) => {
      const target = a.effect instanceof KeyframeEffect ? a.effect.target : null;
      return a.playState === 'running' && !(target !== null && layer.contains(target));
    });
    for (const a of frozen) a.pause();
  }

  function thawAnimations(): void {
    root.classList.remove(PAUSED_CLASS);
    // Animations cancelled meanwhile (element removed, e.g. HUD destroyed on restart) are skipped.
    for (const a of frozen) if (a.playState === 'paused') a.play();
    frozen = [];
  }

  function renderSettings(): void {
    for (const b of qualityButtons) b.setAttribute('aria-pressed', String(b.dataset.quality === quality));
    muteToggle.setAttribute('aria-checked', String(!muted));
  }

  function hide(): void {
    if (!visible) return;
    visible = false;
    layer.hidden = true;
    thawAnimations();
    // Buttons must not keep focus once racing resumes (Space would "click" them).
    if (document.activeElement instanceof HTMLElement && layer.contains(document.activeElement)) {
      document.activeElement.blur();
    }
  }

  const onClick = (e: MouseEvent): void => {
    if (!(e.target instanceof Element)) return;
    const q = e.target.closest<HTMLElement>('[data-quality]')?.dataset.quality;
    if (q === 'low' || q === 'medium' || q === 'high') {
      if (q !== quality) {
        quality = q;
        renderSettings();
        h.onQuality(q);
      }
      return;
    }
    switch (e.target.closest<HTMLElement>('[data-act]')?.dataset.act) {
      case 'resume':
        hide();
        h.onResume();
        break;
      case 'restart':
        hide();
        h.onRestart();
        break;
      case 'garage':
        hide();
        h.onGarage();
        break;
      case 'mute':
        muted = !muted;
        renderSettings();
        h.onMute(muted);
        break;
      default:
        break;
    }
  };
  layer.addEventListener('click', onClick);
  renderSettings();

  return {
    show(): void {
      if (visible) return;
      visible = true;
      freezeAnimations();
      renderSettings();
      layer.hidden = false;
    },
    hide,
    get visible(): boolean {
      return visible;
    },
    sync(s: { quality?: QualityLevel; muted?: boolean }): void {
      if (s.quality !== undefined) quality = s.quality;
      if (s.muted !== undefined) muted = s.muted;
      renderSettings();
    },
    destroy(): void {
      hide();
      layer.removeEventListener('click', onClick);
      layer.remove();
    },
  };
}
