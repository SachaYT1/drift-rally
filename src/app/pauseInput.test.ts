import { describe, expect, it } from 'vitest';
import { createInput } from '../core/input';
import { inputOnPause, inputOnResume } from './pauseInput';

function key(target: EventTarget, type: 'keydown' | 'keyup', code: string): Event {
  const e = new Event(type, { cancelable: true });
  Object.assign(e, { code, repeat: false });
  target.dispatchEvent(e);
  return e;
}

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
    expect(key(t, 'keydown', 'Space').defaultPrevented).toBe(false);
    key(t, 'keyup', 'Space');
    inputOnResume(input);
    expect(key(t, 'keydown', 'Space').defaultPrevented).toBe(true);
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
