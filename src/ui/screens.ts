/**
 * Full-screen states (loading, fatal) plus the tiny DOM helpers shared by every UI module.
 * Importing any UI module pulls in styles.css (and the @fontsource faces it imports).
 */
import './styles.css';
import { clamp } from '../shared/math';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Append a full-size overlay layer with static markup. Dynamic text must go through textContent. */
export function createLayer(root: HTMLElement, className: string, html: string): HTMLDivElement {
  const layer = document.createElement('div');
  layer.className = `dr-layer ${className}`;
  layer.innerHTML = html;
  root.appendChild(layer);
  return layer;
}

/** querySelector that fails loudly: a missing element is a markup bug, not a runtime condition. */
export function qs<T extends HTMLElement = HTMLElement>(parent: ParentNode, selector: string): T {
  const found = parent.querySelector<T>(selector);
  if (!found) throw new Error(`UI element not found: ${selector}`);
  return found;
}

/** Play a one-shot Web Animation, cancelling the previous one on the same element. */
const running = new WeakMap<Element, Animation>();
export function play(el: Element, frames: Keyframe[], options: KeyframeAnimationOptions): void {
  if (typeof el.animate !== 'function') return;
  running.get(el)?.cancel();
  running.set(el, el.animate(frames, options));
}

/** The one-shot animation play() last started on `el`, while it is still in effect (running or paused). */
export function playing(el: Element): Animation | undefined {
  const a = running.get(el);
  return a !== undefined && (a.playState === 'running' || a.playState === 'paused') ? a : undefined;
}

/** Fade `el` out from wherever its one-shot animation has got to, over `ms` (no-op when none is in effect). */
export function fadeOut(el: Element, ms: number): void {
  if (!playing(el)) return;
  const cs = getComputedStyle(el);
  const transform = cs.transform || 'none';
  play(el, [{ opacity: cs.opacity || 1, transform }, { opacity: 0, transform }], { duration: ms, easing: 'ease-out' });
}

export const LOGO_HTML = '<span class="dr-logo"><i class="dr-logo__mark"></i>Drift<b>Rally</b></span>';
export const COIN_HTML = '<i class="dr-coin" aria-hidden="true"></i>';

/** Keycap markup; `label` must be static text. */
export function keyHtml(label: string): string {
  return `<kbd class="dr-key">${label}</kbd>`;
}

/** True when an element (or an ancestor) is an interactive control that handles Enter/Space itself. */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('button, a, input, textarea, select, [role="button"]') !== null;
}

/** True when typing goes into this element: letter shortcuts (M) must leave the keystroke to the field. */
export function isTextField(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('input, textarea, select, [contenteditable]') !== null;
}

/** Escape text for innerHTML markup (player nicks, track names). */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const FADE_MS = 360;

/** Remove the static placeholder index.html paints before the bundle runs (logo + indeterminate bar). */
function removeBootScreen(root: HTMLElement): void {
  root.querySelector(':scope > .dr-boot')?.remove();
}

export function showLoading(root: HTMLElement): { setProgress(f: number): void; hide(): void } {
  removeBootScreen(root);
  const layer = createLayer(
    root,
    'dr-screen dr-loading',
    `<div class="dr-screen__inner" role="status" aria-live="polite">
      ${LOGO_HTML}
      <div class="dr-loading__bar"><i></i></div>
      <div class="dr-loading__row"><span>Прогреваем шины…</span><b class="dr-loading__pct dr-num">0%</b></div>
    </div>
    <p class="dr-screen__tip">Совет: ${keyHtml('Пробел')} в повороте на скорости — и машина уходит в занос. Не прерывайте дрифт, чтобы рос множитель.</p>`,
  );
  const fill = qs(layer, '.dr-loading__bar i');
  const pct = qs(layer, '.dr-loading__pct');
  let shownPct = -1;
  let hidden = false;
  return {
    setProgress(f: number): void {
      const v = clamp(Number.isFinite(f) ? f : 0, 0, 1);
      const p = Math.round(v * 100);
      if (p === shownPct || hidden) return;
      shownPct = p;
      fill.style.transform = `scaleX(${v})`;
      pct.textContent = `${p}%`;
    },
    hide(): void {
      if (hidden) return;
      hidden = true;
      layer.classList.add('is-leaving');
      window.setTimeout(() => layer.remove(), FADE_MS);
    },
  };
}

// ---------------------------------------------------------------------------
// Fatal screens
// ---------------------------------------------------------------------------

type FatalKind = 'noWebGL' | 'contextLost' | 'mobile';

const KEYBOARD_SVG =
  '<svg viewBox="0 0 24 24" width="1.8em" height="1.8em" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M8 13h.01M12 13h.01M16 13h.01M7 16h10"/></svg>';

const FATAL: Record<FatalKind, { icon: string; title: string; text: string; extra: string }> = {
  noWebGL: {
    icon: '3D',
    title: 'Не удалось запустить 3D-графику',
    text: 'Браузер не дал доступ к WebGL. Откройте игру в свежем Chrome, Firefox, Edge или Safari и проверьте, что в настройках включено аппаратное ускорение.',
    extra: '',
  },
  contextLost: {
    icon: '!',
    title: 'Графика сбросилась',
    text: 'Видеокарта потеряла контекст WebGL — так бывает после сна ноутбука или обновления драйвера. Перезагрузите страницу: монеты и рекорды сохранены.',
    extra: '<button type="button" class="dr-btn dr-btn--primary" data-reload>Перезагрузить</button>',
  },
  mobile: {
    icon: KEYBOARD_SVG,
    title: 'Игра для компьютера с клавиатурой',
    text: 'Drift Rally управляется клавишами: газ, руль и дрифт на пробеле. Откройте ссылку на ноутбуке или ПК.',
    extra: `<div class="dr-fatal__keys">${['W', 'A', 'S', 'D'].map(keyHtml).join('')}&nbsp;${keyHtml('Пробел')}</div>`,
  },
};

/** Cover everything with an error/notice screen (topmost layer). Idempotent per root. */
export function showFatal(root: HTMLElement, kind: FatalKind): void {
  removeBootScreen(root);
  root.querySelector(':scope > .dr-fatal')?.remove();
  const f = FATAL[kind];
  const layer = createLayer(
    root,
    'dr-screen dr-fatal',
    `${LOGO_HTML}
    <div class="dr-screen__inner" role="alert">
      <div class="dr-fatal__icon" aria-hidden="true">${f.icon}</div>
      <h1 class="dr-h dr-fatal__title">${f.title}</h1>
      <p class="dr-fatal__text">${f.text}</p>
      ${f.extra}
    </div>`,
  );
  layer.dataset.kind = kind;
  layer.querySelector('[data-reload]')?.addEventListener('click', () => window.location.reload());
}

// ---------------------------------------------------------------------------
// Fonts and device checks
// ---------------------------------------------------------------------------

const FONT_SPECS = ['700 1em Unbounded', '500 1em Manrope', '700 1em Manrope', '800 1em Manrope'];
const FONT_SAMPLE = 'ДРИФТ 0123';
const FONT_TIMEOUT_MS = 5000;
const FONT_RETRY_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve once the UI faces are loaded, or after FONT_TIMEOUT_MS at the latest: the game must never
 * hang on fonts. The @font-face rules arrive with styles.css, which may still be in flight in
 * production builds, so an empty match is retried. A stalled font request is cut off by racing the
 * whole load against a timer (the deadline alone is only checked between attempts).
 */
export async function fontsReady(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return;
  const fonts = document.fonts;
  const deadline = Date.now() + FONT_TIMEOUT_MS;
  const missing: string[] = [];
  const loadOne = async (spec: string): Promise<void> => {
    while (Date.now() < deadline) {
      const faces = await fonts.load(spec, FONT_SAMPLE);
      if (faces.length > 0) return;
      await sleep(FONT_RETRY_MS);
    }
    missing.push(spec);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), FONT_TIMEOUT_MS);
  });
  try {
    // Promise.race keeps a handler on the load promise, so a late rejection is not unhandled.
    const loaded = Promise.all(FONT_SPECS.map(loadOne)).then(() => 'loaded' as const);
    const outcome = await Promise.race([loaded, timeout]);
    if (outcome === 'timeout') {
      console.warn(`Fonts still loading after ${FONT_TIMEOUT_MS} ms, continuing with fallback fonts`);
    } else if (missing.length > 0) {
      console.warn(`Fonts not available, using fallback: ${missing.join(', ')}`);
    }
  } catch (err) {
    console.warn('Font loading failed, using fallback fonts', err);
  } finally {
    clearTimeout(timer);
  }
}

/** Coarse pointer without any fine pointer, or a small touch-only screen. */
export function isProbablyMobile(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  const coarseOnly = window.matchMedia('(pointer: coarse)').matches && !window.matchMedia('(any-pointer: fine)').matches;
  const touch = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
  const smallScreen = Math.min(window.screen.width, window.screen.height) < 600;
  return coarseOnly || (touch && smallScreen);
}
