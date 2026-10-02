/** Minimal garage overlay: top bar, car card with stats, track card with CTA, rules/records modals. */
import type { SaveData } from '../shared/types';
import { TUNING } from '../shared/tuning';
import { formatPoints, formatTime, pluralRu } from './format';
import { COIN_HTML, LOGO_HTML, createLayer, isInteractiveTarget, keyHtml, play, qs } from './screens';

export interface GarageUI {
  update(save: SaveData): void;
  destroy(): void;
}

/** Display-only car card values (design spec §6), not physics parameters. */
const CAR_STATS: readonly { label: string; value: number; color: string }[] = [
  { label: 'Скорость', value: 76, color: 'var(--dr-coral)' },
  { label: 'Разгон', value: 85, color: 'var(--dr-text)' },
  { label: 'Управление', value: 77, color: 'var(--dr-gold)' },
  { label: 'Сцепление', value: 64, color: 'var(--dr-green)' },
];

const POP: Keyframe[] = [{ transform: 'scale(1)' }, { transform: 'scale(1.18)' }, { transform: 'scale(1)' }];

type ModalKind = 'rules' | 'records';
const LAP_FORMS = ['круг', 'круга', 'кругов'] as const;

function escapeText(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function statsHtml(): string {
  return CAR_STATS.map(
    (s, i) =>
      `<li class="dr-stat" style="--c:${s.color};--v:${s.value / 100};--d:${0.25 + i * 0.08}s">
        <span class="dr-stat__label">${s.label}</span>
        <span class="dr-stat__val dr-num">${s.value}</span>
        <span class="dr-stat__bar"><i></i></span>
      </li>`,
  ).join('');
}

function rulesHtml(): string {
  const sc = TUNING.score;
  const keys: [string, string][] = [
    [keyHtml('W') + keyHtml('↑'), 'газ'],
    [keyHtml('S') + keyHtml('↓'), 'тормоз, задний ход'],
    [keyHtml('A') + keyHtml('D'), 'руль (или ← →)'],
    [keyHtml('Пробел'), 'ручник, вход в дрифт'],
    [keyHtml('R'), 'вернуться на трассу'],
    [keyHtml('Esc'), 'пауза'],
    [keyHtml('M'), 'звук вкл/выкл'],
  ];
  const grace = String(sc.graceTime).replace('.', ',');
  return `<h2 class="dr-h dr-modal__title">Правила</h2>
    <div class="dr-rules">
      <section><h3>Управление</h3>
        <div class="dr-keys">${keys.map(([k, t]) => `<span>${k}</span><span>${t}</span>`).join('')}</div>
      </section>
      <section><h3>Как набирать очки</h3>
        <ul class="dr-rule-list">
          <li>Войдите в поворот на скорости, держите руль и нажмите <b>пробел</b> — машина уйдёт в занос и будет держать его сама. Руль внутрь — круче дуга, наружу — прямее.</li>
          <li>Очки капают, пока вы в заносе на асфальте и едете вперёд. Больше угол и скорость — быстрее счёт.</li>
          <li>Не прерывайте дрифт: каждые ${sc.multiplierStep} с множитель растёт, до <b>×${sc.multiplierMax}</b>. После заноса есть ${grace} с, чтобы продолжить цепочку, — потом она уходит в зачёт.</li>
          <li>Сильный удар <b>сжигает цепочку</b>. Сбитая банка или стакан — минус ${sc.propPenalty} очков.</li>
          <li>${TUNING.race.laps} ${pluralRu(TUNING.race.laps, LAP_FORMS)} на заезд. Монеты — на трассе и по одной за каждые ${formatPoints(sc.pointsPerCoin)} очков.</li>
        </ul>
      </section>
    </div>`;
}

function recordsHtml(save: SaveData): string {
  const hasRun = save.bestScore > 0 || save.bestLapMs !== null;
  const best = hasRun ? formatPoints(save.bestScore) : '—';
  const lap = save.bestLapMs === null ? '—' : formatTime(save.bestLapMs / 1000);
  return `<h2 class="dr-h dr-modal__title">Рекорды</h2>
    <div class="dr-records">
      <div class="dr-tile"><span class="dr-eyebrow">Лучший счёт</span><b class="dr-num">${best}</b></div>
      <div class="dr-tile"><span class="dr-eyebrow">Лучший круг</span><b class="dr-num">${lap}</b></div>
      <div class="dr-tile"><span class="dr-eyebrow">Монеты</span><b class="dr-num">${COIN_HTML}${formatPoints(save.coins)}</b></div>
    </div>
    <p class="dr-note">${hasRun ? 'Рекорды хранятся в этом браузере.' : 'Заездов пока не было — самое время поставить первый рекорд.'}</p>`;
}

export function createGarageUI(
  root: HTMLElement,
  opts: { save: SaveData; trackName: string; onStart(): void },
): GarageUI {
  const laps = TUNING.race.laps;
  const layer = createLayer(
    root,
    'dr-garage',
    `<header class="dr-panel dr-topbar">
      ${LOGO_HTML}
      <nav class="dr-nav">
        <button type="button" class="dr-nav__item" data-open="rules">Правила</button>
        <button type="button" class="dr-nav__item" aria-current="page" data-open="garage">Гараж</button>
        <button type="button" class="dr-nav__item" data-open="records">Рекорды</button>
      </nav>
      <div class="dr-wallet" title="Монеты">${COIN_HTML}<span class="dr-wallet__n dr-num"></span></div>
    </header>
    <section class="dr-panel dr-car">
      <div class="dr-eyebrow">Ваша машина</div>
      <h1 class="dr-h dr-car__name">Искра</h1>
      <div class="dr-car__class">Дрифт-кар · задний привод</div>
      <ul class="dr-stats">${statsHtml()}</ul>
    </section>
    <section class="dr-panel dr-track">
      <div class="dr-eyebrow">Трасса</div>
      <div class="dr-h dr-track__name">${escapeText(opts.trackName)} <span>· 1</span></div>
      <div class="dr-track__meta">${laps} ${pluralRu(laps, LAP_FORMS)} · дрифт на очки</div>
      <div class="dr-track__best"><span class="dr-eyebrow">Рекорд</span><b class="dr-track__score dr-num"></b></div>
      <button type="button" class="dr-cta">В заезд<span class="dr-cta__arrows" aria-hidden="true"><i>›</i><i>›</i><i>›</i></span></button>
      <div class="dr-cta-hint">или ${keyHtml('Enter')}</div>
    </section>`,
  );

  const walletN = qs(layer, '.dr-wallet__n');
  const wallet = qs(layer, '.dr-wallet .dr-coin');
  const bestScore = qs(layer, '.dr-track__score');
  const cta = qs<HTMLButtonElement>(layer, '.dr-cta');
  const navButtons = Array.from(layer.querySelectorAll<HTMLButtonElement>('.dr-nav__item'));

  let save = opts.save;
  let modal: { kind: ModalKind; el: HTMLElement; body: HTMLElement; opener: HTMLElement | null } | null = null;

  function render(prevCoins: number | null): void {
    walletN.textContent = formatPoints(save.coins);
    bestScore.textContent = save.bestScore > 0 ? formatPoints(save.bestScore) : '—';
    if (prevCoins !== null && save.coins !== prevCoins) play(wallet, POP, { duration: 420, easing: 'ease-out' });
    if (modal?.kind === 'records') modal.body.innerHTML = recordsHtml(save);
  }

  function closeModal(): void {
    if (!modal) return;
    const { el, opener } = modal;
    modal = null;
    el.remove();
    for (const b of navButtons) b.classList.remove('is-open');
    opener?.focus({ preventScroll: true });
  }

  function openModal(kind: ModalKind, opener: HTMLElement | null): void {
    closeModal();
    const el = document.createElement('div');
    el.className = 'dr-modal';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.innerHTML = `<div class="dr-dim" data-close></div>
      <div class="dr-panel dr-modal__card"><button type="button" class="dr-close" aria-label="Закрыть" data-close></button><div class="dr-modal__body"></div></div>`;
    const body = qs(el, '.dr-modal__body');
    body.innerHTML = kind === 'rules' ? rulesHtml() : recordsHtml(save);
    layer.appendChild(el);
    modal = { kind, el, body, opener };
    opener?.classList.add('is-open');
    el.addEventListener('click', (e) => {
      if (e.target instanceof Element && e.target.closest('[data-close]')) closeModal();
    });
    qs(el, '.dr-close').focus({ preventScroll: true });
  }

  function start(): void {
    closeModal();
    cta.blur();
    opts.onStart();
  }

  const onNav = (e: MouseEvent): void => {
    const btn = e.currentTarget as HTMLButtonElement;
    const kind = btn.dataset.open;
    if (kind === 'rules' || kind === 'records') openModal(kind, btn);
    else closeModal();
  };
  for (const b of navButtons) b.addEventListener('click', onNav);
  cta.addEventListener('click', start);

  const onKey = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    if (e.code === 'Escape' && modal) {
      e.preventDefault();
      closeModal();
    } else if ((e.code === 'Enter' || e.code === 'NumpadEnter') && !modal && !isInteractiveTarget(e.target)) {
      e.preventDefault();
      start();
    }
  };
  window.addEventListener('keydown', onKey);

  render(null);

  return {
    update(next: SaveData): void {
      const prevCoins = save.coins;
      save = next;
      render(prevCoins);
    },
    destroy(): void {
      window.removeEventListener('keydown', onKey);
      modal = null;
      layer.remove();
    },
  };
}

