/**
 * Test-only helper (never imported by the app): installs a jsdom window as the globals the UI modules use.
 *
 * jsdom 27 loads ESM-only dependencies through require(), which Node enables by default from 22.12. On an
 * older Node the import fails with ERR_REQUIRE_ESM and installDom() resolves null, so DOM suites can
 * `describe.skipIf(!win)` instead of breaking the whole run (CI uses a current Node 22).
 */
import { vi } from 'vitest';

export type DomWindow = Window & typeof globalThis;

interface JsdomModule {
  JSDOM: new (html: string, options?: { pretendToBeVisual?: boolean; url?: string }) => { window: DomWindow };
}

/** Globals read by src/ui (instanceof checks, events, timers, styles). */
const CLASSES = [
  'Element',
  'HTMLElement',
  'HTMLButtonElement',
  'HTMLTextAreaElement',
  'Node',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
  'FocusEvent',
] as const;
const FUNCTIONS = ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;

/** A string specifier keeps the bundler and the type checker out of it (jsdom ships no types). */
const JSDOM_MODULE = 'jsdom';

export async function installDom(): Promise<DomWindow | null> {
  let mod: JsdomModule;
  try {
    mod = (await import(/* @vite-ignore */ JSDOM_MODULE)) as JsdomModule;
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_REQUIRE_ESM') return null;
    throw err;
  }
  const { window: win } = new mod.JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://127.0.0.1/',
  });
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', win.document);
  for (const name of CLASSES) vi.stubGlobal(name, win[name]);
  for (const name of FUNCTIONS) vi.stubGlobal(name, (win[name] as (...a: unknown[]) => unknown).bind(win));
  return win;
}

/** What a fake Element.animate() call recorded; the test moves time by editing pending / currentTime. */
export interface FakeAnimation {
  target: Element;
  frames: Keyframe[];
  options: KeyframeAnimationOptions;
  playState: AnimationPlayState;
  pending: boolean;
  currentTime: number | null;
  cancel(): void;
  pause(): void;
  play(): void;
}

/**
 * Minimal Web Animations stand-in (jsdom has none): every animate() call is appended to the returned list,
 * starting pending at currentTime 0 like a real animation created this frame.
 */
export function fakeAnimations(win: DomWindow): FakeAnimation[] {
  const list: FakeAnimation[] = [];
  Object.defineProperty(win.Element.prototype, 'animate', {
    configurable: true,
    value(this: Element, frames: Keyframe[], options: KeyframeAnimationOptions): FakeAnimation {
      const a: FakeAnimation = {
        target: this,
        frames,
        options,
        playState: 'running',
        pending: true,
        currentTime: 0,
        cancel: () => void (a.playState = 'idle'),
        pause: () => void (a.playState = 'paused'),
        play: () => void (a.playState = 'running'),
      };
      list.push(a);
      return a;
    },
  });
  return list;
}

/** Pointer click (detail 1) or keyboard activation (detail 0) on `el`. */
export function click(el: Element, detail = 1): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail }));
}

/** keydown on the focused element (as a browser does), bubbling up to window. Returns the event. */
export function keydown(code: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true, ...init });
  (document.activeElement ?? document.body).dispatchEvent(e);
  return e;
}
