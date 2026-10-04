/**
 * Buying and choosing cars (plan/2026-10-04-sport-cars.md). buyCar and selectCar are pure: they return a new
 * SaveData and never mutate the input. purchaseCar applies a purchase to the save as stored NOW (App.updateSave),
 * so two tabs cannot spend the same coins twice and a purchase is never lost to another tab's write.
 */
import { CAR_IDS, CARS, type CarId } from '../shared/cars';
import type { SaveData } from '../shared/types';
import type { SaveStore } from './saveResult';

export type BuyOutcome = { ok: true; save: SaveData } | { ok: false; reason: 'owned' | 'coins' };

/** Pay the car's price and own it; the bought car becomes the selected one. */
export function buyCar(save: Readonly<SaveData>, id: CarId): BuyOutcome {
  if (save.ownedCars.includes(id)) return { ok: false, reason: 'owned' };
  const price = CARS[id].price;
  if (save.coins < price) return { ok: false, reason: 'coins' };
  return {
    ok: true,
    save: {
      ...save,
      coins: save.coins - price,
      ownedCars: CAR_IDS.filter((c) => c === id || save.ownedCars.includes(c)),
      selectedCar: id,
    },
  };
}

/** The save with `id` as the car of the next race; unchanged when the car is not owned. */
export function selectCar(save: Readonly<SaveData>, id: CarId): SaveData {
  return save.ownedCars.includes(id) ? { ...save, selectedCar: id } : { ...save };
}

/** buyCar on the save as stored now; a refused purchase leaves the stored save as it was. */
export function purchaseCar(store: SaveStore, id: CarId): BuyOutcome {
  const applied: { outcome: BuyOutcome } = { outcome: { ok: false, reason: 'coins' } };
  store.updateSave((current) => {
    applied.outcome = buyCar(current, id);
    return applied.outcome.ok ? applied.outcome.save : current;
  });
  return applied.outcome;
}
