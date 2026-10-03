import { describe, expect, it, vi } from 'vitest';
import { createInput } from './input';

function key(target: EventTarget, type: 'keydown' | 'keyup', code: string, repeat = false) {
  const e = new Event(type, { cancelable: true });
  Object.assign(e, { code, repeat });
  target.dispatchEvent(e);
  return e;
}

describe('input', () => {
  it('maps WASD by code (layout independent)', () => {
    const t = new EventTarget(); const inp = createInput(t);
    key(t, 'keydown', 'KeyW'); key(t, 'keydown', 'KeyA');
    expect(inp.sample()).toMatchObject({ throttle: 1, steer: 1 });
    key(t, 'keydown', 'KeyD');
    expect(inp.sample().steer).toBe(0);
    key(t, 'keyup', 'KeyA');
    expect(inp.sample().steer).toBe(-1);
  });
  it('reports a Space press once, while the hold persists', () => {
    const t = new EventTarget(); const inp = createInput(t);
    key(t, 'keydown', 'Space');
    expect(inp.sample()).toMatchObject({ handbrake: true, handbrakePressed: true });
    key(t, 'keydown', 'Space', true);
    expect(inp.sample()).toMatchObject({ handbrake: true, handbrakePressed: false });
  });
  it('keeps an unconsumed press until the next sample', () => {
    const t = new EventTarget(); const inp = createInput(t);
    key(t, 'keydown', 'Space'); key(t, 'keyup', 'Space');
    expect(inp.sample().handbrakePressed).toBe(true);
    expect(inp.sample().handbrakePressed).toBe(false);
  });
  it('latches actions once and ignores auto-repeat', () => {
    const t = new EventTarget(); const inp = createInput(t);
    key(t, 'keydown', 'Escape'); key(t, 'keydown', 'Escape', true);
    expect(inp.consumeActions().pause).toBe(true);
    expect(inp.consumeActions().pause).toBe(false);
    key(t, 'keydown', 'KeyR');
    expect(inp.consumeActions().respawn).toBe(true);
  });
  it('clears keys on blur and notifies', () => {
    const t = new EventTarget(); const onBlur = vi.fn(); const inp = createInput(t, onBlur);
    key(t, 'keydown', 'KeyW');
    t.dispatchEvent(new Event('blur'));
    expect(inp.sample().throttle).toBe(0);
    expect(onBlur).toHaveBeenCalledOnce();
  });
  it('prevents default for game keys only while racing', () => {
    const t = new EventTarget(); const inp = createInput(t);
    expect(key(t, 'keydown', 'Space').defaultPrevented).toBe(false);
    inp.setRacing(true);
    expect(key(t, 'keydown', 'Space').defaultPrevented).toBe(true);
    expect(key(t, 'keydown', 'KeyQ').defaultPrevented).toBe(false);
  });
});

describe('input edge cases', () => {
  function press(target: EventTarget, type: 'keydown' | 'keyup', code: string, extra: Record<string, unknown> = {}) {
    const e = new Event(type, { cancelable: true });
    Object.assign(e, { code, repeat: false, ...extra });
    target.dispatchEvent(e);
    return e;
  }

  it('maps arrows and S like WASD', () => {
    const t = new EventTarget(); const inp = createInput(t);
    press(t, 'keydown', 'ArrowUp'); press(t, 'keydown', 'ArrowDown'); press(t, 'keydown', 'ArrowRight');
    expect(inp.sample()).toEqual({ throttle: 1, brake: 1, steer: -1, handbrake: false, handbrakePressed: false });
    press(t, 'keyup', 'ArrowDown'); press(t, 'keydown', 'KeyS');
    expect(inp.sample().brake).toBe(1);
  });
  it('tracks keys bound to the same control independently', () => {
    const t = new EventTarget(); const inp = createInput(t);
    press(t, 'keydown', 'KeyA'); press(t, 'keydown', 'ArrowLeft'); press(t, 'keyup', 'KeyA');
    expect(inp.sample().steer).toBe(1);
    press(t, 'keyup', 'ArrowLeft');
    expect(inp.sample().steer).toBe(0);
  });
  it('ignores and never blocks browser shortcuts (Ctrl/Meta/Alt) while racing', () => {
    const t = new EventTarget(); const inp = createInput(t);
    inp.setRacing(true);
    for (const mod of ['ctrlKey', 'metaKey', 'altKey']) {
      expect(press(t, 'keydown', 'KeyR', { [mod]: true }).defaultPrevented).toBe(false);
    }
    expect(inp.consumeActions().respawn).toBe(false);
    expect(inp.sample().throttle).toBe(0);
  });
  it('prevents default on keyup and auto-repeat while racing, and stops when racing ends', () => {
    const t = new EventTarget(); const inp = createInput(t);
    inp.setRacing(true);
    expect(press(t, 'keydown', 'ArrowDown', { repeat: true }).defaultPrevented).toBe(true);
    expect(press(t, 'keyup', 'Space').defaultPrevented).toBe(true);
    inp.setRacing(false);
    expect(press(t, 'keydown', 'ArrowDown').defaultPrevented).toBe(false);
    expect(press(t, 'keyup', 'Space').defaultPrevented).toBe(false);
  });
  it('latches each action independently and returns fresh frames', () => {
    const t = new EventTarget(); const inp = createInput(t);
    press(t, 'keydown', 'KeyM'); press(t, 'keydown', 'KeyR');
    const a = inp.consumeActions();
    expect(a).toEqual({ pause: false, respawn: true, mute: true });
    expect(inp.consumeActions()).toEqual({ pause: false, respawn: false, mute: false });
    expect(a.mute).toBe(true);
  });
  it('entering or leaving race mode drops stale latches but keeps held keys', () => {
    const t = new EventTarget(); const inp = createInput(t);
    press(t, 'keydown', 'Escape'); press(t, 'keydown', 'KeyM'); press(t, 'keydown', 'Space'); press(t, 'keydown', 'KeyW');
    inp.setRacing(true);
    expect(inp.consumeActions()).toEqual({ pause: false, respawn: false, mute: false });
    expect(inp.sample()).toMatchObject({ throttle: 1, handbrake: true, handbrakePressed: false });
    press(t, 'keydown', 'KeyR');
    inp.setRacing(true); // no transition: latch survives
    expect(inp.consumeActions().respawn).toBe(true);
    press(t, 'keydown', 'KeyM');
    inp.setRacing(false);
    expect(inp.consumeActions().mute).toBe(false);
  });
  it('reset clears held keys and unconsumed latches', () => {
    const t = new EventTarget(); const inp = createInput(t);
    press(t, 'keydown', 'KeyW'); press(t, 'keydown', 'Space'); press(t, 'keydown', 'Escape');
    inp.reset();
    expect(inp.sample()).toEqual({ throttle: 0, brake: 0, steer: 0, handbrake: false, handbrakePressed: false });
    expect(inp.consumeActions().pause).toBe(false);
  });
  it('blur also drops unconsumed latches', () => {
    const t = new EventTarget(); const inp = createInput(t);
    press(t, 'keydown', 'Space'); press(t, 'keydown', 'KeyM');
    t.dispatchEvent(new Event('blur'));
    expect(inp.sample().handbrakePressed).toBe(false);
    expect(inp.consumeActions().mute).toBe(false);
  });
  it('a key still held after reset is picked up again by its auto-repeat', () => {
    const t = new EventTarget(); const inp = createInput(t);
    press(t, 'keydown', 'KeyW'); press(t, 'keydown', 'Space');
    inp.reset();
    press(t, 'keydown', 'KeyW', { repeat: true }); press(t, 'keydown', 'Space', { repeat: true });
    expect(inp.sample()).toMatchObject({ throttle: 1, handbrake: true, handbrakePressed: false });
  });
  it('dispose detaches all listeners and clears held keys', () => {
    const t = new EventTarget(); const onBlur = vi.fn(); const inp = createInput(t, onBlur);
    press(t, 'keydown', 'KeyW');
    inp.setRacing(true);
    inp.dispose();
    expect(inp.sample().throttle).toBe(0);
    expect(press(t, 'keydown', 'Space').defaultPrevented).toBe(false);
    t.dispatchEvent(new Event('blur'));
    expect(inp.sample()).toMatchObject({ handbrake: false, handbrakePressed: false });
    expect(onBlur).not.toHaveBeenCalled();
  });
});
