/** Results screen: score (count-up), record badge, stats, laps, coins, retry / garage / share. */
import type { RaceResult } from '../shared/types';
import { formatPoints, formatTime, pluralRu } from './format';
import { buildShareText, copyText } from './share';
import { COIN_HTML, createLayer, isInteractiveTarget, keyHtml, qs } from './screens';

const COUNT_UP_MS = 1100;
/** Keyboard shortcuts arm after this delay so a key still held from the race cannot trigger them. */
const ARM_MS = 700;
const COPIED_MS = 2200;

export function showResults(
  root: HTMLElement,
  r: RaceResult,
  ctx: { newBest: boolean; bestScore: number; shareUrl: string },
  h: { onRetry(): void; onGarage(): void },
): { destroy(): void } {
  const points = Math.max(0, Math.round(r.totalPoints));
  const lapsHtml = r.lapTimes
    .map((t, i) => {
      const best = t === r.bestLap && r.lapTimes.length > 1;
      return `<span class="${best ? 'is-best' : ''}">Круг ${i + 1}<b class="dr-num">${formatTime(t)}</b></span>`;
    })
    .join('');
  const badge = ctx.newBest
    ? '<span class="dr-badge">★ Новый рекорд!</span>'
    : `<span class="dr-badge dr-badge--plain">Рекорд&nbsp;<b class="dr-num">${formatPoints(ctx.bestScore)}</b></span>`;

  const layer = createLayer(
    root,
    'dr-results',
    `<div class="dr-dim"></div>
    <div class="dr-panel dr-results__card" role="dialog" aria-modal="true" aria-labelledby="dr-results-title">
      <div class="dr-results__head"><span class="dr-eyebrow" id="dr-results-title">Финиш · Площадь</span>${badge}</div>
      <div class="dr-results__row">
        <div class="dr-results__score dr-num" data-ref="score">0</div>
        <div class="dr-results__unit">${pluralRu(points, ['очко', 'очка', 'очков'])}</div>
      </div>
      <div class="dr-results__grid">
        <div class="dr-tile"><span class="dr-eyebrow">Лучшая цепочка</span><b class="dr-num">${formatPoints(r.bestChain)}</b></div>
        <div class="dr-tile"><span class="dr-eyebrow">Время</span><b class="dr-num">${formatTime(r.totalTime)}</b></div>
        <div class="dr-tile"><span class="dr-eyebrow">Лучший круг</span><b class="dr-num">${formatTime(r.bestLap)}</b></div>
      </div>
      <div class="dr-laps">${lapsHtml}</div>
      <div class="dr-earn">
        <div class="dr-earn__total">${COIN_HTML}<span class="dr-num">+${formatPoints(r.coinsEarned)}</span></div>
        <div class="dr-earn__parts"><b class="dr-num">${r.coinsPicked}</b> собрано на трассе<br><b class="dr-num">${r.coinsFromDrift}</b> за дрифт</div>
      </div>
      <div class="dr-results__actions">
        <button type="button" class="dr-btn dr-btn--primary" data-act="retry">Ещё раз</button>
        <button type="button" class="dr-btn" data-act="garage">В гараж</button>
        <button type="button" class="dr-btn" data-act="share">Поделиться</button>
      </div>
      <div class="dr-share-out" hidden>Не получилось скопировать — выделите текст и скопируйте вручную:
        <textarea rows="3" readonly></textarea>
      </div>
      <div class="dr-results__foot">${keyHtml('Enter')} — ещё раз</div>
    </div>`,
  );

  const scoreEl = qs(layer, '[data-ref="score"]');
  const shareBtn = qs<HTMLButtonElement>(layer, '[data-act="share"]');
  const shareOut = qs(layer, '.dr-share-out');
  const shareArea = qs<HTMLTextAreaElement>(layer, '.dr-share-out textarea');
  const shareLabel = shareBtn.textContent ?? '';
  let raf = 0;
  let copiedTimer = 0;
  let done = false;
  const armedAt = performance.now() + ARM_MS;

  // Count-up: ease-out from 0 to the final score; the static value is the fallback.
  const startT = performance.now();
  const tick = (now: number): void => {
    const k = Math.min(1, (now - startT) / COUNT_UP_MS);
    const eased = 1 - (1 - k) ** 3;
    scoreEl.textContent = formatPoints(points * eased);
    raf = k < 1 ? requestAnimationFrame(tick) : 0;
  };
  if (points > 0 && typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(tick);
  else scoreEl.textContent = formatPoints(points);

  async function share(): Promise<void> {
    const text = buildShareText(points, ctx.shareUrl);
    const ok = await copyText(text);
    if (done) return;
    if (ok) {
      shareBtn.textContent = 'Скопировано!';
      window.clearTimeout(copiedTimer);
      copiedTimer = window.setTimeout(() => (shareBtn.textContent = shareLabel), COPIED_MS);
    } else {
      shareArea.value = text;
      shareOut.hidden = false;
      shareArea.focus({ preventScroll: true });
      shareArea.select();
    }
  }

  function finish(cb: () => void): void {
    if (done) return;
    destroy();
    cb();
  }

  const onClick = (e: MouseEvent): void => {
    if (!(e.target instanceof Element)) return;
    const btn = e.target.closest<HTMLElement>('[data-act]');
    // A pointer click must not leave focus on the button, or the next Enter would press it again instead of
    // meaning «Ещё раз» (detail === 0: activated from the keyboard, where focus stays put).
    if (btn && e.detail !== 0) btn.blur();
    switch (btn?.dataset.act) {
      case 'retry':
        finish(() => h.onRetry());
        break;
      case 'garage':
        finish(() => h.onGarage());
        break;
      case 'share':
        void share();
        break;
      default:
        break;
    }
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.repeat || performance.now() < armedAt) return;
    if ((e.code === 'Enter' || e.code === 'NumpadEnter') && !isInteractiveTarget(e.target)) {
      e.preventDefault();
      finish(() => h.onRetry());
    }
  };
  layer.addEventListener('click', onClick);
  window.addEventListener('keydown', onKey);

  function destroy(): void {
    if (done) return;
    done = true;
    if (raf) cancelAnimationFrame(raf);
    window.clearTimeout(copiedTimer);
    window.removeEventListener('keydown', onKey);
    layer.removeEventListener('click', onClick);
    layer.remove();
  }

  return { destroy };
}
