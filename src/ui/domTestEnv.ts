/**
 * Test-only helper (never imported by the app): installs a jsdom window as the globals the UI modules use.
 *
 * jsdom is pinned to 26.x (package.json): 27 loads ESM-only dependencies through require(), which Node only
 * enables by default from 22.12, so on Node 22.9 every DOM suite used to be skipped without a word. A jsdom
 * that cannot load now rejects installDom(), and the suite's top-level await fails the test file loudly.
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

const loadJsdom = (): Promise<unknown> => import(/* @vite-ignore */ JSDOM_MODULE);

/** Installs a fresh jsdom window as the globals. Rejects (never skips) when jsdom cannot be loaded. */
export async function installDom(load: () => Promise<unknown> = loadJsdom): Promise<DomWindow> {
  let mod: JsdomModule;
  try {
    mod = (await load()) as JsdomModule;
  } catch (err) {
    throw new Error(`jsdom failed to load on Node ${process.version}; the DOM suites need it (pinned in package.json)`, {
      cause: err,
    });
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
