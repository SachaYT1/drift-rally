/** The procedural body of every car in the line-up (src/shared/cars.ts). */
import type { CarId } from '../shared/cars';
import type { CarBody } from './carParts';
import { ISKRA } from './bodies/iskra';
import { QUADRO } from './bodies/quadro';
import { RONIN } from './bodies/ronin';
import { SCARAB } from './bodies/scarab';

export const CAR_BODIES: Readonly<Record<CarId, CarBody>> = { iskra: ISKRA, quadro: QUADRO, ronin: RONIN, scarab: SCARAB };
