/** The car knocked out of control (heavy hit, bomb blast). Pure. */
import type { CarState } from '../shared/types';
import type { Tuning } from '../shared/tuning';

/**
 * Recovery mode for drift.recoverTime. Leaving a drift resets the same fields as a normal drift exit
 * (car.ts exitDrift): the drift clock restarts and lateral grip blends back in (no jolt).
 */
export function enterRecover(s: CarState, t: Tuning): CarState {
  return {
    ...s,
    mode: 'recover',
    modeTimer: t.drift.recoverTime,
    driftDir: 0,
    ...(s.mode === 'drift' ? { driftTime: 0, gripBlend: 0 } : {}),
  };
}
