/** Minimal garage overlay: top bar, car card with stats, track card with CTA, rules/records modals. */
import type { SaveData } from '../shared/types';
import type { LeaderboardPort } from '../shared/leaderboard';
import { TUNING } from '../shared/tuning';
import { formatPoints, formatTime, pluralRu } from './format';
import { mountFriends, type FriendsView } from './leaderboardView';
import { COIN_HTML, LOGO_HTML, createLayer, escapeHtml, isInteractiveTarget, isTextField, keyHtml, play, qs } from './screens';
import { APP_VERSION } from '../shared/version';

export interface GarageUI {
  /** New save: coins pop in the wallet, records, the sound toggle and the ghost switch follow it. */
  update(save: SaveData): void;
  destroy(): void;
}

/** Ghost (bots switch); dimmed while off (styles.css keys off aria-checked). */
const GHOST_SVG =
  '<svg viewBox="0 0 24 24" width="1.25em" height="1.25em" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M5 20.5V11a7 7 0 0 1 14 0v9.5l-2.33-1.75-2.34 1.75L12 18.75l-2.33 1.75-2.34-1.75z"/><circle cx="9.5" cy="11" r="1.1" fill="currentColor" stroke="none"/><circle cx="14.5" cy="11" r="1.1" fill="currentColor" stroke="none"/></svg>';

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
/** Title of the open modal (one at a time), referenced by its aria-labelledby. */
const MODAL_TITLE_ID = 'dr-modal-title';
const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Speaker; the waves show while sound is on, the cross while muted (styles.css keys off aria-checked). */
const SOUND_SVG =
  '<svg viewBox="0 0 24 24" width="1.25em" height="1.25em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><g class="dr-sound__on"><path d="M15.5 9.2a4 4 0 0 1 0 5.6"/><path d="M18.2 6.6a7.6 7.6 0 0 1 0 10.8"/></g><g class="dr-sound__off"><path d="m15.5 9.5 5 5m0-5-5 5"/></g></svg>';

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

/** Seconds for the Russian copy: 0.3 → "0,3", 1.5 → "1,5"; at most two decimals, so float noise never shows. */
function decimalRu(x: number): string {
  return String(Math.round(x * 100) / 100).replace('.', ',');
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
  const grace = decimalRu(sc.graceTime);
  return `<h2 class="dr-h dr-modal__title" id="${MODAL_TITLE_ID}">Правила</h2>
    <div class="dr-rules">
      <section><h3>Управление</h3>
        <div class="dr-keys">${keys.map(([k, t]) => `<span>${k}</span><span>${t}</span>`).join('')}</div>
        <ul class="dr-keys-note">
          <li class="dr-eyebrow">В заносе</li>
          <li>${keyHtml('W')} держит занос, отпустите газ — выход</li>
          <li>${keyHtml('Пробел')} — войти в занос или подкрутить коротким нажатием; долго держать — машина теряет скорость</li>
          <li>${keyHtml('A')}${keyHtml('D')} внутрь — круче, наружу — прямее</li>
          <li>Полный контрруль — машина выпрямится и поймает занос</li>
          <li>${keyHtml('S')} тормоз и выход из заноса</li>
          <li>${keyHtml('Пробел')} + обратный руль — перекладка</li>
        </ul>
      </section>
      <section><h3>Как набирать очки</h3>
        <ul class="dr-rule-list">
          <li>Войдите в поворот на скорости, держите руль и нажмите <b>пробел</b> — машина уйдёт в занос и будет держать его сама.</li>
          <li>Очки капают, пока вы в заносе на асфальте и едете вперёд. Больше угол и скорость — быстрее счёт.</li>
          <li>Не прерывайте дрифт: каждые ${sc.multiplierStep} с множитель растёт, до <b>×${sc.multiplierMax}</b>. После заноса есть ${grace} с, чтобы продолжить цепочку, — потом она уходит в зачёт.</li>
          <li>Сильный удар, взрыв бомбы или возврат на трассу (${keyHtml('R')}) <b>сжигают цепочку</b>. Сбитая банка или стакан — минус ${sc.propPenalty} очков.</li>
          <li>${TUNING.race.laps} ${pluralRu(TUNING.race.laps, LAP_FORMS)} на заезд. Монеты — на трассе и по одной за каждые ${formatPoints(sc.pointsPerCoin)} очков.</li>
        </ul>
      </section>
    </div>`;
}

/** The records modal: personal records, then the friends table (filled by mountFriends) when there is one. */
function recordsHtml(save: SaveData, friends: boolean): string {
  return `<h2 class="dr-h dr-modal__title" id="${MODAL_TITLE_ID}">Рекорды</h2>
    <div data-ref="personal">${personalHtml(save)}</div>
    ${friends ? '<section class="dr-friends" data-ref="friends"></section>' : ''}`;
}

function personalHtml(save: SaveData): string {
  const hasRun = save.bestScore > 0 || save.bestLapMs !== null;
  const best = hasRun ? formatPoints(save.bestScore) : '—';
  const lap = save.bestLapMs === null ? '—' : formatTime(save.bestLapMs / 1000);
  return `<div class="dr-records">
      <div class="dr-tile"><span class="dr-eyebrow">Лучший счёт</span><b class="dr-num">${best}</b></div>
      <div class="dr-tile"><span class="dr-eyebrow">Лучший круг</span><b class="dr-num">${lap}</b></div>
      <div class="dr-tile"><span class="dr-eyebrow">Монеты</span><b class="dr-num">${COIN_HTML}${formatPoints(save.coins)}</b></div>
    </div>
    <p class="dr-note">${hasRun ? 'Рекорды хранятся в этом браузере.' : 'Заездов пока не было — самое время поставить первый рекорд.'}</p>`;
}

export function createGarageUI(
  root: HTMLElement,
  opts: {
    save: SaveData;
    trackName: string;
    onStart(): void;
    /** The sound toggle or M flipped mute (the UI already shows the new state). */
    onMute(muted: boolean): void;
    /** The «Призраки» switch flipped the ghost bots (the UI already shows the new state). */
    onGhosts(on: boolean): void;
    /** Friends table in «Рекорды»; null / omitted: personal records only. */
    leaderboard?: LeaderboardPort | null;
  },
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
      <div class="dr-topbar__end">
        <button type="button" class="dr-ghosts" role="switch" aria-checked="true" title="Боты-призраки в заезде">${GHOST_SVG}<span>Призраки</span></button>
        <button type="button" class="dr-sound" role="switch" aria-checked="true" aria-label="Звук" title="Звук (M)">${SOUND_SVG}${keyHtml('M')}</button>
        <div class="dr-wallet" title="Монеты">${COIN_HTML}<span class="dr-wallet__n dr-num"></span></div>
      </div>
    </header>
    <div class="dr-version" aria-label="Версия игры">v${escapeHtml(APP_VERSION)}</div>
    <section class="dr-panel dr-car">
      <div class="dr-eyebrow">Ваша машина</div>
      <h1 class="dr-h dr-car__name">Искра</h1>
      <div class="dr-car__class">Дрифт-кар · задний привод</div>
      <ul class="dr-stats">${statsHtml()}</ul>
    </section>
    <section class="dr-panel dr-track">
      <div class="dr-eyebrow">Трасса</div>
      <div class="dr-h dr-track__name">${escapeHtml(opts.trackName)} <span>· 1</span></div>
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
  const soundBtn = qs<HTMLButtonElement>(layer, '.dr-sound');
  const ghostsBtn = qs<HTMLButtonElement>(layer, '.dr-ghosts');
  const navButtons = Array.from(layer.querySelectorAll<HTMLButtonElement>('.dr-nav__item'));
  /** Everything behind a modal: inert while one is open, so neither Tab nor a screen reader reaches it. */
  const background = Array.from(layer.children).filter((c): c is HTMLElement => c instanceof HTMLElement);

  let save = opts.save;
  let muted = save.muted;
  let ghosts = save.ghosts;
  let started = false;
  /** `refocus`: the modal was opened from the keyboard, so focus goes back to its opener on close. */
  let modal: { kind: ModalKind; el: HTMLElement; body: HTMLElement; opener: HTMLElement; refocus: boolean } | null = null;
  /** The friends table of the open records modal. */
  let friends: FriendsView | null = null;

  function renderSound(): void {
    soundBtn.setAttribute('aria-checked', String(!muted));
  }

  function renderGhosts(): void {
    ghostsBtn.setAttribute('aria-checked', String(ghosts));
  }

  function toggleMute(): void {
    muted = !muted;
    renderSound();
    opts.onMute(muted);
  }

  function render(prevCoins: number | null): void {
    muted = save.muted;
    renderSound();
    ghosts = save.ghosts;
    renderGhosts();
    walletN.textContent = formatPoints(save.coins);
    bestScore.textContent = save.bestScore > 0 ? formatPoints(save.bestScore) : '—';
    if (prevCoins !== null && save.coins !== prevCoins) play(wallet, POP, { duration: 420, easing: 'ease-out' });
    // Only the personal tiles: the friends table may hold a nick being typed.
    if (modal?.kind === 'records') qs(modal.body, '[data-ref="personal"]').innerHTML = personalHtml(save);
  }

  /** Drop focus from any garage control so a page-level Enter reaches the start handler. */
  function blurInside(): void {
    const active = document.activeElement;
    if (active instanceof HTMLElement && layer.contains(active)) active.blur();
  }

  function closeModal(): void {
    if (!modal) return;
    const { el, opener, refocus } = modal;
    modal = null;
    friends?.destroy();
    friends = null;
    el.remove();
    for (const b of background) b.removeAttribute('inert');
    for (const b of navButtons) b.classList.remove('is-open');
    // Only keyboard users get focus back on the nav button: for a mouse user a focused nav button
    // would swallow the next Enter (re-opening the modal) instead of starting the race.
    if (refocus) opener.focus({ preventScroll: true });
    else blurInside();
  }

  function openModal(kind: ModalKind, opener: HTMLElement, refocus: boolean): void {
    closeModal();
    const el = document.createElement('div');
    el.className = 'dr-modal';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', MODAL_TITLE_ID);
    el.innerHTML = `<div class="dr-dim" data-close></div>
      <div class="dr-panel dr-modal__card"><button type="button" class="dr-close" aria-label="Закрыть" data-close></button><div class="dr-modal__body"></div></div>`;
    const body = qs(el, '.dr-modal__body');
    const board = kind === 'records' ? (opts.leaderboard ?? null) : null;
    body.innerHTML = kind === 'rules' ? rulesHtml() : recordsHtml(save, board !== null);
    if (board) friends = mountFriends(qs(body, '[data-ref="friends"]'), board);
    for (const b of background) b.setAttribute('inert', '');
    layer.appendChild(el);
    modal = { kind, el, body, opener, refocus };
    opener.classList.add('is-open');
    el.addEventListener('click', (e) => {
      if (e.target instanceof Element && e.target.closest('[data-close]')) closeModal();
    });
    qs(el, '.dr-close').focus({ preventScroll: true });
  }

  /** Tab / Shift+Tab cycle through the open modal's controls only (the inert background also hides it from assistive tech). */
  function trapTab(e: KeyboardEvent, dialog: HTMLElement): void {
    const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
    e.preventDefault();
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = at < 0 ? 0 : (at + (e.shiftKey ? -1 : 1) + items.length) % items.length;
    items[next].focus({ preventScroll: true });
  }

  /** One-shot: a double click or two quick Enters must not start two races before destroy(). */
  function start(): void {
    closeModal();
    blurInside(); // also on repeats: a second click re-focuses the CTA on mousedown
    if (started) return;
    started = true;
    opts.onStart();
  }

  const onNav = (e: MouseEvent): void => {
    const btn = e.currentTarget as HTMLButtonElement;
    const kind = btn.dataset.open;
    // detail === 0: activated from the keyboard (Enter/Space), not by a pointer click.
    const fromKeyboard = e.detail === 0;
    if (!fromKeyboard) btn.blur();
    if (kind === 'rules' || kind === 'records') openModal(kind, btn, fromKeyboard);
    else closeModal();
  };
  for (const b of navButtons) b.addEventListener('click', onNav);
  cta.addEventListener('click', start);
  const onSound = (e: MouseEvent): void => {
    // A pointer click must not leave focus here, or the next Enter would toggle sound instead of starting.
    if (e.detail !== 0) soundBtn.blur();
    toggleMute();
  };
  soundBtn.addEventListener('click', onSound);
  const onGhostsClick = (e: MouseEvent): void => {
    // Like the sound toggle: a focused switch would take the next Enter instead of the start.
    if (e.detail !== 0) ghostsBtn.blur();
    ghosts = !ghosts;
    renderGhosts();
    opts.onGhosts(ghosts);
  };
  ghostsBtn.addEventListener('click', onGhostsClick);

  const onKey = (e: KeyboardEvent): void => {
    if (e.code === 'Tab' && modal) {
      trapTab(e, modal.el);
      return;
    }
    if (e.repeat) return;
    if (e.code === 'KeyM' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTextField(e.target)) {
      toggleMute();
    } else if (e.code === 'Escape' && modal) {
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
      friends?.destroy();
      friends = null;
      modal = null;
      layer.remove();
    },
  };
}

