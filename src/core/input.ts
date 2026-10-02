/**
 * Keyboard input (design spec §2.2). Keys are mapped by `KeyboardEvent.code`, so controls
 * work on any layout (including Russian). Held keys are sampled per physics step; edge
 * events (Space press, Esc/R/M actions) are latched until consumed, and auto-repeat
 * keydowns never produce edges.
 */
import type { ActionFrame, InputFrame } from '../shared/types';

export interface InputController {
  /** Call once per PHYSICS STEP. Returns held state; handbrakePressed is true once per Space press. */
  sample(): InputFrame;
  /** Latched actions since the last call (each true at most once per key press). */
  consumeActions(): ActionFrame;
  /**
   * While racing, game keys preventDefault() and Space/arrows never reach page scrolling or focused buttons.
   * Switching mode drops unconsumed latches (e.g. Esc pressed in the garage must not pause the new race).
   */
  setRacing(on: boolean): void;
  /** Clear held keys and latches (blur, pause; also on resume to drop presses made while paused). */
  reset(): void;
  dispose(): void;
}

type Control = 'throttle' | 'brake' | 'left' | 'right' | 'handbrake' | 'pause' | 'respawn' | 'mute';
type Action = keyof ActionFrame;

/** All game keys, by `KeyboardEvent.code`. */
const KEY_MAP: Readonly<Record<string, Control>> = Object.freeze({
  KeyW: 'throttle',
  ArrowUp: 'throttle',
  KeyS: 'brake',
  ArrowDown: 'brake',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'handbrake',
  Escape: 'pause',
  KeyR: 'respawn',
  KeyM: 'mute',
});

function isAction(control: Control): control is Action {
  return control === 'pause' || control === 'respawn' || control === 'mute';
}

interface KeyInfo {
  code: string;
  control: Control;
  repeat: boolean;
  /** Ctrl/Meta/Alt held: a browser or OS shortcut (e.g. Ctrl+R), not a game key press. */
  shortcut: boolean;
}

/** Reads a key event structurally (works for real KeyboardEvents and synthetic test events). */
function readKey(e: Event): KeyInfo | null {
  if (!('code' in e) || typeof e.code !== 'string') return null;
  const control = Object.hasOwn(KEY_MAP, e.code) ? KEY_MAP[e.code] : undefined;
  if (control === undefined) return null;
  return {
    code: e.code,
    control,
    repeat: 'repeat' in e && e.repeat === true,
    shortcut:
      ('ctrlKey' in e && e.ctrlKey === true) ||
      ('metaKey' in e && e.metaKey === true) ||
      ('altKey' in e && e.altKey === true),
  };
}

function noActions(): ActionFrame {
  return { pause: false, respawn: false, mute: false };
}

/**
 * Listens for keydown/keyup/blur on `target` (normally `window`).
 * 'blur' clears held keys and latches, then calls `onBlur` (the app auto-pauses).
 */
export function createInput(target: EventTarget, onBlur?: () => void): InputController {
  /** Physical keys currently down, by code (A and ArrowLeft are tracked separately). */
  const held = new Set<string>();
  let handbrakeLatch = false;
  let actionLatch = noActions();
  let racing = false;

  const isHeld = (control: Control): boolean => {
    for (const code of held) if (KEY_MAP[code] === control) return true;
    return false;
  };

  const clearLatches = (): void => {
    handbrakeLatch = false;
    actionLatch = noActions();
  };

  const reset = (): void => {
    held.clear();
    clearLatches();
  };

  const onKeyDown = (e: Event): void => {
    const key = readKey(e);
    if (key === null || key.shortcut) return;
    if (racing) e.preventDefault();
    held.add(key.code);
    if (key.repeat) return;
    if (key.control === 'handbrake') handbrakeLatch = true;
    else if (isAction(key.control)) actionLatch = { ...actionLatch, [key.control]: true };
  };

  const onKeyUp = (e: Event): void => {
    const key = readKey(e);
    if (key === null) return;
    // Also on keyup: a focused button activates on Space keyup.
    if (racing) e.preventDefault();
    held.delete(key.code);
  };

  const onWindowBlur = (): void => {
    reset();
    onBlur?.();
  };

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('blur', onWindowBlur);

  return {
    sample(): InputFrame {
      const frame: InputFrame = {
        throttle: isHeld('throttle') ? 1 : 0,
        brake: isHeld('brake') ? 1 : 0,
        steer: (isHeld('left') ? 1 : 0) - (isHeld('right') ? 1 : 0),
        handbrake: isHeld('handbrake'),
        handbrakePressed: handbrakeLatch,
      };
      handbrakeLatch = false;
      return frame;
    },
    consumeActions(): ActionFrame {
      const actions = actionLatch;
      actionLatch = noActions();
      return actions;
    },
    setRacing(on: boolean): void {
      if (on !== racing) clearLatches();
      racing = on;
    },
    reset,
    dispose(): void {
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('blur', onWindowBlur);
      reset();
    },
  };
}
