import { describe, expect, it } from 'vitest';
import type { SaveData } from '../shared/types';
import { DEFAULT_SAVE } from '../core/save';
import { buyCar, purchaseCar, selectCar } from './carShop';

const SAVE: SaveData = { ...DEFAULT_SAVE, coins: 1000 };

describe('buyCar', () => {
  it('pays the price, owns the car and selects it', () => {
    expect(buyCar(SAVE, 'ronin')).toEqual({
      ok: true,
      save: { ...SAVE, coins: 100, ownedCars: ['iskra', 'ronin'], selectedCar: 'ronin' },
    });
  });

  it('keeps the owned list in line-up order', () => {
    const out = buyCar({ ...SAVE, coins: 5000, ownedCars: ['iskra', 'scarab'] }, 'quadro');
    expect(out.ok && out.save.ownedCars).toEqual(['iskra', 'quadro', 'scarab']);
  });

  it('refuses a car the player cannot afford, down to the last coin', () => {
    expect(buyCar({ ...SAVE, coins: 299 }, 'quadro')).toEqual({ ok: false, reason: 'coins' });
    expect(buyCar({ ...SAVE, coins: 300 }, 'quadro')).toMatchObject({ ok: true, save: { coins: 0 } });
  });

  it('refuses a car already owned', () => {
    expect(buyCar(SAVE, 'iskra')).toEqual({ ok: false, reason: 'owned' });
    expect(buyCar({ ...SAVE, ownedCars: ['iskra', 'quadro'] }, 'quadro')).toEqual({ ok: false, reason: 'owned' });
  });

  it('never mutates the input', () => {
    const save = Object.freeze({ ...SAVE, ownedCars: Object.freeze(['iskra'] as const) });
    expect(() => buyCar(save, 'quadro')).not.toThrow();
    expect(save.ownedCars).toEqual(['iskra']);
  });
});

describe('selectCar', () => {
  it('selects an owned car', () => {
    expect(selectCar({ ...SAVE, ownedCars: ['iskra', 'ronin'] }, 'ronin').selectedCar).toBe('ronin');
  });

  it('ignores a car that is not owned', () => {
    expect(selectCar(SAVE, 'ronin')).toEqual(SAVE);
  });
});

describe('purchaseCar', () => {
  it('buys against the save as stored now (another tab may have spent the coins)', () => {
    let stored: SaveData = { ...SAVE, coins: 350 };
    const store = {
      updateSave(change: (s: SaveData) => SaveData): SaveData {
        stored = change(stored);
        return stored;
      },
    };
    expect(purchaseCar(store, 'ronin')).toEqual({ ok: false, reason: 'coins' });
    expect(stored.coins).toBe(350);
    expect(purchaseCar(store, 'quadro').ok).toBe(true);
    expect(stored).toMatchObject({ coins: 50, ownedCars: ['iskra', 'quadro'], selectedCar: 'quadro' });
  });
});
