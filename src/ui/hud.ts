/**
 * In-race HUD. DOM is written only when a displayed (rounded) value changes; all animations
 * are transform/opacity (CSS or Web Animations); no backdrop-filter. See design spec §6.
 */
import type { GameEvent, StandingRow } from '../shared/types';
import { TUNING } from '../shared/tuning';
import { formatKmh, formatLap, formatPoints, formatTime, MINUS } from './format';
import { COIN_HTML, createLayer, fadeOut, keyHtml, play, playing, qs } from './screens';
import { createStandings } from './standings';

export interface HudView {
  lap: number;
  laps: number;
  time: number;
  bestLap: number | null;
  coins: number;
  speed: number;
  chainPoints: number;
  multiplier: number;
  chainPhase: 'idle' | 'active' | 'grace';
  totalPoints: number;
  wrongWay: boolean;
  /** Player vs ghost bots, best first; null / absent: no bots in this race. */
  standings?: readonly StandingRow[] | null;
}

export interface Hud {
  update(v: HudView): void;
  onEvent(e: GameEvent): void;
  setCountdown(value: number | null): void;
  showHint(visible: boolean): void;
  destroy(): void;
}

// Keyframes are module constants so event handling never rebuilds them.
const POP: Keyframe[] = [{ transform: 'scale(1)' }, { transform: 'scale(1.32)' }, { transform: 'scale(1)' }];
const BUMP: Keyframe[] = [{ transform: 'scale(1)' }, { transform: 'scale(1.1)' }, { transform: 'scale(1)' }];
const SHAKE: Keyframe[] = [
  { transform: 'translateX(0)' },
  { transform: 'translateX(-0.4em)' },
  { transform: 'translateX(0.35em)' },
  { transform: 'translateX(-0.2em)' },
  { transform: 'translateX(0)' },
];
const RISE: Keyframe[] = [
  { opacity: 0, transform: 'translate(-50%, 0.2em) scale(0.85)' },
  { opacity: 1, transform: 'translate(-50%, 0.6em) scale(1.08)', offset: 0.15 },
  { opacity: 1, transform: 'translate(-50%, 0.4em) scale(1)', offset: 0.65 },
  { opacity: 0, transform: 'translate(-50%, -1.6em) scale(0.9)' },
];
const DROP: Keyframe[] = [
  { opacity: 0, transform: 'translate(-50%, 0) scale(1.4)' },
  { opacity: 1, transform: 'translate(-50%, 0.5em) scale(1)', offset: 0.15 },
  { opacity: 1, transform: 'translate(-50%, 0.5em) scale(1)', offset: 0.7 },
  { opacity: 0, transform: 'translate(-50%, 1.6em) scale(0.95)' },
];
const PENALTY: Keyframe[] = [
  { opacity: 0, transform: 'translateY(-0.3em)' },
  { opacity: 1, transform: 'translateY(0)', offset: 0.15 },
  { opacity: 1, transform: 'translateY(0)', offset: 0.7 },
  { opacity: 0, transform: 'translateY(0.6em)' },
];
const COIN_UP: Keyframe[] = [
  { opacity: 0, transform: 'translateY(0)' },
  { opacity: 1, transform: 'translateY(0.3em)', offset: 0.2 },
  { opacity: 0, transform: 'translateY(1.3em)' },
];
/** Played on the digit span: the box keeps its translate(-50%, -50%) centring (a transform here would replace it). */
const COUNT: Keyframe[] = [
  { opacity: 0, transform: 'scale(1.9)' },
  { opacity: 1, transform: 'scale(1)', offset: 0.22 },
  { opacity: 1, transform: 'scale(0.94)', offset: 0.75 },
  { opacity: 0, transform: 'scale(0.82)' },
];
const TOAST: Keyframe[] = [
  { opacity: 0, transform: 'translate(-50%, 0.8em)' },
  { opacity: 1, transform: 'translate(-50%, 0)', offset: 0.12 },
  { opacity: 1, transform: 'translate(-50%, 0)', offset: 0.82 },
  { opacity: 0, transform: 'translate(-50%, -0.6em)' },
];

const HIDE: Keyframe[] = [{ opacity: 0 }, { opacity: 0 }];

const BANK_MS = 1300;
const BURN_MS = 1500;
/** Fade-out of a bank / burn flash that is in the way of a new chain card (the card fades in over 250 ms). */
const CLEAR_MS = 120;

const UTURN_SVG =
  '<svg viewBox="0 0 24 24" width="1.1em" height="1.1em" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>';

const HUD_HTML = `
  <section class="dr-panel dr-hud-lap">
    <div class="dr-hud-lap__row">
      <span class="dr-eyebrow">Круг</span>
      <span class="dr-hud-lap__count dr-num"><b data-ref="lap">1</b><span>/<span data-ref="laps">3</span></span></span>
    </div>
    <div class="dr-hud-time dr-num" data-ref="time">0:00.00</div>
    <div class="dr-hud-best"><span>Лучший круг</span><b class="dr-num" data-ref="best"></b></div>
    <button type="button" class="dr-btn dr-btn--primary dr-hud-pause" tabindex="-1"><span><i class="dr-pause-ico" aria-hidden="true"></i>Пауза</span>${keyHtml('Esc')}</button>
  </section>
  <div class="dr-score">
    <div class="dr-panel dr-score__total">
      <span class="dr-eyebrow">Очки</span><b class="dr-num" data-ref="total">0</b>
      <span class="dr-flash dr-flash--penalty dr-num" data-ref="penalty"></span>
    </div>
    <div class="dr-chain" data-phase="idle" data-mult="1" style="--grace:${TUNING.score.graceTime}s">
      <div class="dr-chain__main"><b class="dr-chain__pts dr-num" data-ref="chain">+0</b><span class="dr-chain__mult" data-ref="mult">×1</span></div>
      <div class="dr-chain__pips">${'<i></i>'.repeat(TUNING.score.multiplierMax)}</div>
      <div class="dr-chain__drain"><i></i></div>
    </div>
    <span class="dr-flash dr-flash--bank dr-num" data-ref="bank"></span>
    <span class="dr-flash dr-flash--burn" data-ref="burn"></span>
  </div>
  <section class="dr-panel dr-hud-coins">${COIN_HTML}<b class="dr-num" data-ref="coins">0</b><span class="dr-coin-plus" data-ref="coinPlus">+1</span></section>
  <section class="dr-panel dr-hud-speed">
    <div class="dr-hud-speed__row"><b class="dr-num" data-ref="speed">0</b><span class="dr-eyebrow">км/ч</span></div>
    <div class="dr-hud-speed__bar"><i data-ref="speedBar"></i></div>
  </section>
  <div class="dr-countdown" aria-live="assertive"><span data-ref="count"></span></div>
  <div class="dr-wrong" role="alert">${UTURN_SVG}Не туда! Разворачивайтесь</div>
  <div class="dr-toast"><div class="dr-toast__title" data-ref="toastTitle"></div><div class="dr-toast__sub" data-ref="toastSub"></div></div>
  <div class="dr-hint" style="display:grid;grid-template-columns:repeat(4,auto);gap:0.5em 1.3em">
    <span>${keyHtml('W')}${keyHtml('A')}${keyHtml('S')}${keyHtml('D')} газ и руль</span>
    <span>${keyHtml('Пробел')} дрифт</span>
    <span>${keyHtml('R')} на трассу</span>
    <span>${keyHtml('Esc')} пауза</span>
    <span class="dr-hint__exits" style="grid-column:1/-1;justify-content:center"><b>В заносе:</b> ${keyHtml('S')} — выход, контрруль или сброс газа — выровняться</span>
  </div>`;

export function createHud(root: HTMLElement, opts: { onPause(): void }): Hud {
  const layer = createLayer(root, 'dr-hud', HUD_HTML);
  const ref = (name: string): HTMLElement => qs(layer, `[data-ref="${name}"]`);
  const el = {
    lap: ref('lap'),
    laps: ref('laps'),
    time: ref('time'),
    best: ref('best'),
    total: ref('total'),
    penalty: ref('penalty'),
    chain: qs(layer, '.dr-chain'),
    chainPts: ref('chain'),
    mult: ref('mult'),
    pips: Array.from(layer.querySelectorAll<HTMLElement>('.dr-chain__pips i')),
    bank: ref('bank'),
    burn: ref('burn'),
    coins: ref('coins'),
    coinIcon: qs(layer, '.dr-hud-coins .dr-coin'),
    coinPlus: ref('coinPlus'),
    speed: ref('speed'),
    speedBar: ref('speedBar'),
    countBox: qs(layer, '.dr-countdown'),
    /** The animated part of the countdown (see COUNT). */
    count: ref('count'),
    wrong: qs(layer, '.dr-wrong'),
    toast: qs(layer, '.dr-toast'),
    toastTitle: ref('toastTitle'),
    toastSub: ref('toastSub'),
    hint: qs(layer, '.dr-hint'),
  };
  // Under the coin counter (styles.css), written only when a row changes.
  const standings = createStandings(layer);

  // Last displayed values (integer keys); -1 / '' force the first write.
  const shown = {
    lap: -1,
    laps: -1,
    timeCs: -1,
    bestCs: -3,
    total: -1,
    chain: -1,
    mult: -1,
    phase: '',
    coins: -1,
    kmh: -1,
    wrong: false,
    countdown: null as number | null,
  };
  let laps: number = TUNING.race.laps;

  const pauseBtn = qs<HTMLButtonElement>(layer, '.dr-hud-pause');
  const keepFocus = (e: MouseEvent): void => e.preventDefault(); // never steal focus from the game
  const onPauseClick = (): void => opts.onPause();
  pauseBtn.addEventListener('mousedown', keepFocus);
  pauseBtn.addEventListener('click', onPauseClick);

  function centis(seconds: number): number {
    return Math.floor(Math.round(Math.max(0, seconds) * 1000) / 10);
  }

  function setWrong(on: boolean): void {
    if (on === shown.wrong) return;
    shown.wrong = on;
    el.wrong.classList.toggle('is-on', on);
  }

  function setMultiplier(m: number): void {
    if (m === shown.mult) return;
    shown.mult = m;
    el.mult.textContent = `×${m}`;
    el.chain.dataset.mult = String(Math.min(m, TUNING.score.multiplierMax));
    for (let i = 0; i < el.pips.length; i++) el.pips[i].classList.toggle('is-on', i < m);
  }

  function toast(title: string, sub: string, best: boolean): void {
    el.toastTitle.textContent = title;
    el.toastSub.textContent = sub;
    el.toastSub.hidden = sub === '';
    if (best) {
      const tag = document.createElement('em');
      tag.textContent = 'Лучший круг!';
      el.toastSub.appendChild(tag);
    }
    play(el.toast, TOAST, { duration: 2400, easing: 'ease-out' });
  }

  function setCountdown(value: number | null): void {
    // Accept raw seconds-left too: show whole numbers only, 0 = GO.
    const v = value === null || !Number.isFinite(value) ? null : Math.max(0, Math.ceil(value));
    if (v === shown.countdown) return;
    const prev = shown.countdown;
    shown.countdown = v;
    if (v === null) {
      // «Старт!» fades out on its own (its keyframes end at opacity 0); cutting it here would hide GO
      // whenever the app clears the countdown on the same step that emits 0.
      if (prev !== 0) play(el.count, HIDE, { duration: 1 });
      return;
    }
    const go = v === 0;
    el.count.textContent = go ? 'Старт!' : String(v);
    el.countBox.toggleAttribute('data-go', go);
    play(el.count, COUNT, { duration: go ? 900 : 1000, easing: 'ease-out' });
  }

  /** True while `a` has not drawn a frame yet: started during this very frame (its events came in one batch). */
  function unseen(a: Animation): boolean {
    return a.pending || !(Number(a.currentTime) > 0);
  }

  /**
   * A new chain card is fading in where the bank / burn flashes play: get them out of its way. Flashes the
   * player has seen fade out quickly. One that started this frame has not been seen: a bank there is dropped
   * (the total still bumps), a burn (a glancing heavy hit the car drifted through) moves below the card.
   */
  function clearFlashesForChain(): void {
    const bank = playing(el.bank);
    if (bank) {
      if (unseen(bank)) bank.cancel();
      else fadeOut(el.bank, CLEAR_MS);
    }
    const burn = playing(el.burn);
    if (burn) {
      if (unseen(burn)) el.burn.classList.add('is-below');
      else fadeOut(el.burn, CLEAR_MS);
    }
  }

  function update(v: HudView): void {
    if (v.lap !== shown.lap) {
      shown.lap = v.lap;
      el.lap.textContent = String(Math.min(v.lap, v.laps));
    }
    if (v.laps !== shown.laps) {
      shown.laps = v.laps;
      laps = v.laps;
      el.laps.textContent = String(v.laps);
    }
    const cs = centis(v.time);
    if (cs !== shown.timeCs) {
      shown.timeCs = cs;
      el.time.textContent = formatTime(v.time);
    }
    const bestCs = v.bestLap === null ? -2 : centis(v.bestLap);
    if (bestCs !== shown.bestCs) {
      shown.bestCs = bestCs;
      el.best.textContent = formatLap(v.bestLap);
    }
    const total = Math.round(v.totalPoints);
    if (total !== shown.total) {
      shown.total = total;
      el.total.textContent = formatPoints(total);
    }
    if (v.chainPhase !== shown.phase) {
      shown.phase = v.chainPhase;
      el.chain.dataset.phase = v.chainPhase;
    }
    // While idle the chain fades out; keep its last numbers instead of flashing "+0".
    if (v.chainPhase !== 'idle') {
      const chain = Math.round(v.chainPoints);
      if (chain !== shown.chain) {
        shown.chain = chain;
        el.chainPts.textContent = `+${formatPoints(chain)}`;
      }
      setMultiplier(v.multiplier);
    }
    if (v.coins !== shown.coins) {
      shown.coins = v.coins;
      el.coins.textContent = String(v.coins);
    }
    const kmh = Math.round(Math.abs(v.speed) * 3.6);
    if (kmh !== shown.kmh) {
      shown.kmh = kmh;
      el.speed.textContent = formatKmh(v.speed);
      const f = Math.min(1, Math.abs(v.speed) / TUNING.car.maxSpeed);
      el.speedBar.style.transform = `scaleX(${f.toFixed(3)})`;
    }
    setWrong(v.wrongWay);
    standings.update(v.standings ?? null);
  }

  function onEvent(e: GameEvent): void {
    switch (e.type) {
      case 'countdown':
        setCountdown(e.value);
        break;
      case 'coin':
        play(el.coinIcon, POP, { duration: 320, easing: 'ease-out' });
        play(el.coinPlus, COIN_UP, { duration: 650, easing: 'ease-out' });
        break;
      case 'multiplier':
        setMultiplier(e.value);
        play(el.mult, POP, { duration: 360, easing: 'ease-out' });
        break;
      case 'chainStart':
        clearFlashesForChain();
        break;
      case 'chainBanked':
        if (e.points <= 0) break;
        el.bank.textContent = `+${formatPoints(e.points)}`;
        play(el.bank, RISE, { duration: BANK_MS, easing: 'ease-out' });
        play(el.total, BUMP, { duration: 380, delay: 450, easing: 'ease-out' });
        break;
      case 'chainBurned':
        el.burn.textContent = e.points > 0 ? `Сгорело ${MINUS}${formatPoints(e.points)}` : 'Сгорело';
        el.burn.classList.remove('is-below');
        play(el.burn, DROP, { duration: BURN_MS, easing: 'ease-out' });
        play(el.chain.firstElementChild ?? el.chain, SHAKE, { duration: 360 });
        break;
      case 'penalty':
        // The session reports the points actually deducted (the total is floored at 0): nothing to show for 0.
        if (!(e.points > 0)) break;
        el.penalty.textContent = `${MINUS}${formatPoints(e.points)}`;
        play(el.penalty, PENALTY, { duration: 1300, easing: 'ease-out' });
        break;
      case 'lap':
        if (e.lap >= laps) break; // the finish toast covers the last lap
        toast(e.lap + 1 === laps ? 'Последний круг' : `Круг ${e.lap + 1}/${laps}`, formatTime(e.lapTime), e.best);
        break;
      case 'wrongWay':
        setWrong(e.active);
        break;
      case 'finish':
        setWrong(false);
        toast('Финиш!', '', false);
        break;
      default:
        break;
    }
  }

  return {
    update,
    onEvent,
    setCountdown,
    showHint(visible: boolean): void {
      el.hint.classList.toggle('is-on', visible);
    },
    destroy(): void {
      pauseBtn.removeEventListener('mousedown', keepFocus);
      pauseBtn.removeEventListener('click', onPauseClick);
      layer.remove();
    },
  };
}
