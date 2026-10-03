/**
 * What pausing and resuming a race does to the keyboard input. Switching race mode off and on drops the
 * latched presses (an Esc or R pressed in the pause menu must not pause again or respawn on the first step),
 * but keys the player is still holding survive a pause they asked for: W held through Esc / Esc keeps driving.
 * When the window loses focus (blur, hidden tab) keyups may never arrive, so held keys are dropped too.
 */
import type { InputController } from '../core/input';

/** `player`: Esc or the HUD pause button. `focusLost`: window blur or a hidden tab. */
export type PauseCause = 'player' | 'focusLost';

type PauseInput = Pick<InputController, 'setRacing' | 'reset'>;

/** Menu mode while paused: game keys stop blocking Space/Enter, latches are dropped. */
export function inputOnPause(input: PauseInput, cause: PauseCause): void {
  input.setRacing(false);
  if (cause === 'focusLost') input.reset();
}

/** Back to racing: presses made while paused are dropped, keys still held keep acting. */
export function inputOnResume(input: PauseInput): void {
  input.setRacing(false);
  input.setRacing(true);
}
