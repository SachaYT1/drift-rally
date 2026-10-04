/**
 * Garage car card pieces (plan/2026-10-04-sport-cars.md): stat bars, what the CTA does for the browsed car, the
 * buy dialog and stepping through the line-up. Pure: strings and values only.
 */
import { CAR_IDS, CARS, type CarId, type CarSpec, type CarStats } from '../shared/cars';
import { formatPoints, pluralRu } from './format';
import { COIN_HTML, escapeHtml } from './screens';

const STAT_ROWS: readonly { key: keyof CarStats; label: string; color: string }[] = [
  { key: 'speed', label: 'Скорость', color: 'var(--dr-coral)' },
  { key: 'accel', label: 'Разгон', color: 'var(--dr-text)' },
  { key: 'handling', label: 'Управление', color: 'var(--dr-gold)' },
  { key: 'angle', label: 'Занос', color: 'var(--dr-green)' },
];

/** The card's stat bars for `spec` (display values, design spec §6). */
export function statsHtml(spec: CarSpec): string {
  return STAT_ROWS.map((s, i) => {
    const value = spec.stats[s.key];
    return `<li class="dr-stat" style="--c:${s.color};--v:${value / 100};--d:${0.25 + i * 0.08}s">
        <span class="dr-stat__label">${s.label}</span>
        <span class="dr-stat__val dr-num">${value}</span>
        <span class="dr-stat__bar"><i></i></span>
      </li>`;
  }).join('');
}

/** What the CTA does for the browsed car: race it, or buy it (`short`: coins missing, 0 = affordable). */
export type CtaState = { kind: 'race' } | { kind: 'buy'; price: number; short: number };

export function ctaState(id: CarId, owned: readonly CarId[], coins: number): CtaState {
  if (owned.includes(id)) return { kind: 'race' };
  const price = CARS[id].price;
  return { kind: 'buy', price, short: Math.max(0, price - coins) };
}

/** «Машина 2/4». */
export function carCountLabel(id: CarId): string {
  return `Машина ${CAR_IDS.indexOf(id) + 1}/${CAR_IDS.length}`;
}

/** The car `step` places away in the line-up, wrapping around. */
export function stepCar(id: CarId, step: number): CarId {
  const n = CAR_IDS.length;
  return CAR_IDS[(((CAR_IDS.indexOf(id) + step) % n) + n) % n];
}

/** «не хватает 1 монеты / 2 монет / 5 монет». */
const COIN_FORMS = ['монеты', 'монет', 'монет'] as const;

/** «Не хватает ● N монет». */
export function missingCoinsHtml(short: number): string {
  return `Не хватает ${COIN_HTML}<b class="dr-num">${formatPoints(short)}</b> ${pluralRu(short, COIN_FORMS)}`;
}

/** The buy dialog's line for a wallet of `coins`: the price and what is left, or how much is missing. */
export function buyTextHtml(spec: CarSpec, coins: number): string {
  const price = `Цена ${COIN_HTML}<b class="dr-num">${formatPoints(spec.price)}</b>.`;
  if (coins < spec.price) return `${price} ${missingCoinsHtml(spec.price - coins)}.`;
  return `${price} После покупки останется ${COIN_HTML}<b class="dr-num">${formatPoints(coins - spec.price)}</b>.`;
}

/**
 * Body of the buy confirmation dialog; its title carries `titleId` (the dialog's aria-labelledby). The garage
 * refreshes the line and the confirm button while the dialog is open (another tab may spend the coins).
 */
export function buyDialogHtml(spec: CarSpec, coins: number, titleId: string): string {
  return `<h2 class="dr-h dr-modal__title" id="${titleId}">Купить «${escapeHtml(spec.name)}»?</h2>
    <p class="dr-buy__text">${buyTextHtml(spec, coins)}</p>
    <div class="dr-buy__actions">
      <button type="button" class="dr-btn" data-close data-ref="cancel">Отмена</button>
      <button type="button" class="dr-btn dr-btn--primary" data-confirm-buy${coins < spec.price ? ' disabled' : ''}>Купить</button>
    </div>`;
}
