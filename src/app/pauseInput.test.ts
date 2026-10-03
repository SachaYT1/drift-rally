import { describe, expect, it } from 'vitest';
import { createInput } from '../core/input';
import { inputOnPause, inputOnResume } from './pauseInput';

/** `focused`: the element the key event targets (a stand-in for a focused control); default the listener. */
function key(target: EventTarget, type: 'keydown' | 'keyup', code: string, focused?: object): Event {
  const e = new Event(type, { cancelable: true });
  Object.assign(e, { code, repeat: false });
  if (focused) Object.defineProperty(e, 'target', { value: focused });
  target.dispatchEvent(e);
  return e;
}

/** A focused pause-menu button (matches any control selector). */
const MENU_BUTTON = { closest: () => ({}) };

function racingInput() {
  const t = new EventTarget();
  const input = createInput(t);
  input.setRacing(true);
  return { t, input };
}

describe('pause input', () => {
  it('keeps W held through an Esc pause and resume (no auto-repeat needed to keep driving)', () => {
    const { t, input } = racingInput();
    key(t, 'keydown', 'KeyW');
    key(t, 'keydown', 'Escape');
    inputOnPause(input, 'player');
    key(t, 'keydown', 'Escape');
    inputOnResume(input);
    expect(input.sample().throttle).toBe(1);
    expect(input.consumeActions()).toEqual({ pause: false, respawn: false, mute: false });
  });

  it('stops blocking menu keys while paused and blocks game keys again after resume', () => {
    const { t, input } = racingInput();
    inputOnPause(input, 'player');
    expect(key(t, 'keydown', 'Space', MENU_BUTTON).defaultPrevented).toBe(false);
    expect(key(t, 'keyup', 'Space', MENU_BUTTON).defaultPrevented).toBe(false);
    expect(key(t, 'keydown', 'KeyW').defaultPrevented).toBe(false);
    inputOnResume(input);
    expect(key(t, 'keydown', 'Space', MENU_BUTTON).defaultPrevented).toBe(true);
    expect(key(t, 'keydown', 'KeyW').defaultPrevented).toBe(true);
  });

  it('drops presses made while paused (R would respawn, Space would kick a drift on the first step)', () => {
    const { t, input } = racingInput();
    inputOnPause(input, 'player');
    key(t, 'keydown', 'KeyR');
    key(t, 'keydown', 'Space');
    key(t, 'keyup', 'Space');
    inputOnResume(input);
    expect(input.consumeActions().respawn).toBe(false);
    expect(input.sample().handbrakePressed).toBe(false);
  });

  it('a key released while paused stops acting after resume', () => {
    const { t, input } = racingInput();
    key(t, 'keydown', 'KeyW');
    inputOnPause(input, 'player');
    key(t, 'keyup', 'KeyW');
    inputOnResume(input);
    expect(input.sample().throttle).toBe(0);
  });

  it('drops held keys when the window loses focus (their keyups may never arrive)', () => {
    const { t, input } = racingInput();
    key(t, 'keydown', 'KeyW');
    key(t, 'keydown', 'KeyA');
    inputOnPause(input, 'focusLost');
    inputOnResume(input);
    expect(input.sample()).toMatchObject({ throttle: 0, steer: 0 });
  });
});
