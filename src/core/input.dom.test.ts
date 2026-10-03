/**
 * Input against real DOM targets (jsdom): focused controls keep the Space / arrow behaviour they need, every
 * other target has page scrolling blocked (it would scroll an embedding page, e.g. an itch.io iframe host).
 *
 * installDom() rejects when jsdom cannot be loaded, so this file fails loudly instead of being skipped.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { installDom } from '../ui/domTestEnv';
import { createInput } from './input';

const win = await installDom();
afterAll(() => vi.unstubAllGlobals());

describe('input on DOM targets', () => {
  function keydown(target: EventTarget, code: string): boolean {
    const e = new win.KeyboardEvent('keydown', { code, bubbles: true, cancelable: true });
    target.dispatchEvent(e);
    return e.defaultPrevented;
  }

  function mount(html: string) {
    const doc = win.document;
    doc.body.innerHTML = html;
    const inp = createInput(win);
    return { inp, body: doc.body, q: (sel: string) => doc.querySelector(sel)! };
  }

  it('blocks Space and arrows on the body, the canvas and plain text in every screen', () => {
    const { inp, body, q } = mount('<canvas id="game" tabindex="-1"></canvas><div id="ui"><p>text</p></div>');
    for (const racing of [false, true]) {
      inp.setRacing(racing);
      for (const target of [body, q('#game'), q('p')]) {
        for (const code of ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
          expect(keydown(target, code), `${code} racing=${racing}`).toBe(true);
        }
      }
    }
    inp.dispose();
  });

  it('outside a race: buttons keep Space (activation), form fields and the share textarea keep both', () => {
    const { inp, q } = mount(`<div id="ui">
      <button class="dr-cta"><span class="label">В ЗАЕЗД</span></button>
      <button role="switch" data-act="mute"></button>
      <div role="button" tabindex="0">menu</div>
      <input type="text">
      <div class="dr-share-out"><textarea rows="3" readonly></textarea></div>
    </div>`);
    for (const sel of ['.label', '[data-act="mute"]', '[role="button"]']) {
      expect(keydown(q(sel), 'Space'), sel).toBe(false);
      // No arrow behaviour on a button: the arrow would only scroll the page.
      expect(keydown(q(sel), 'ArrowDown'), sel).toBe(true);
    }
    for (const sel of ['input', 'textarea']) {
      expect(keydown(q(sel), 'Space'), sel).toBe(false);
      expect(keydown(q(sel), 'ArrowLeft'), sel).toBe(false);
    }
    // While racing the game owns every game key: nothing may activate or scroll.
    inp.setRacing(true);
    for (const sel of ['.label', 'textarea']) expect(keydown(q(sel), 'Space'), sel).toBe(true);
    inp.dispose();
  });
});
