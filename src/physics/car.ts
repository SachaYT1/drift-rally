/** Assisted arcade drift car model. Pure: no three.js imports. See design spec §2.3. */
import type { CarState, InputFrame, SurfaceKind } from '../shared/types';
import { TUNING, type Tuning } from '../shared/tuning';

export function createCarState(_x: number, _z: number, _heading: number): CarState {
  throw new Error('not implemented');
}

/** Advance the car by one fixed step. Returns a NEW state; never mutates `state`. */
export function stepCar(
  _state: CarState,
  _input: InputFrame,
  _surface: SurfaceKind,
  _dt: number,
  _t: Tuning = TUNING,
): CarState {
  throw new Error('not implemented');
}

/** True when the car is in drift mode, fast enough and sliding at >= score.minSlip. */
export function isDrifting(_state: CarState, _t: Tuning = TUNING): boolean {
  throw new Error('not implemented');
}

/** Car collision capsule in world space. */
export function carCapsule(
  _state: CarState,
  _t: Tuning = TUNING,
): { ax: number; az: number; bx: number; bz: number; r: number } {
  throw new Error('not implemented');
}
