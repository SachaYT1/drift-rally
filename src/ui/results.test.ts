import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RaceResult } from '../shared/types';
import { showResults } from './results';
import { click, fakeAnimations, installDom, keydown } from './domTestEnv';

const win = await installDom();
afterAll(() => vi.unstubAllGlobals());

const RESULT: RaceResult = {
  totalPoints: 4820,
  bestChain: 1900,
  totalTime: 184.2,
  bestLap: 60.1,
  lapTimes: [62.3, 60.1, 61.8],
  coinsPicked: 7,
  coinsFromDrift: 4,
  coinsEarned: 11,
};

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('results screen (jsdom)', () => {
  let root: HTMLElement;
  let now = 0;

  beforeEach(() => {
    fakeAnimations(win);
    root = document.createElement('div');
    document.body.appendChild(root);
    now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(() => Promise.resolve()) } });
  });

  afterEach(() => {
    root.remove();
    vi.restoreAllMocks();
  });

  it('Enter still means «Ещё раз» after «Поделиться» was clicked with the mouse', async () => {
    const onRetry = vi.fn();
    const screen = showResults(
      root,
      RESULT,
      { newBest: false, bestScore: 5000, shareUrl: 'https://example.com/' },
      { onRetry, onGarage: () => {} },
    );
    const share = root.querySelector<HTMLButtonElement>('[data-act="share"]')!;
    now += 2000; // past the arming delay
    share.focus(); // mousedown focuses the button before its click
    click(share);
    await tick();
    expect(share.textContent).toBe('Скопировано!');
    expect(document.activeElement).not.toBe(share);
    keydown('Enter', { key: 'Enter' });
    expect(onRetry).toHaveBeenCalledTimes(1);
    screen.destroy();
  });

  it('shows «Ты против ботов» with the player\'s place when the race had bots', () => {
    const screen = showResults(
      root,
      RESULT,
      {
        newBest: false,
        bestScore: 5000,
        shareUrl: 'https://example.com/',
        versus: [
          { id: 'master', name: 'Мастер', color: 0xb070ff, points: 91000, finished: true },
          { id: 'player', name: 'Ты', color: null, points: 4820, finished: true },
          { id: 'pro', name: 'Профи', color: 0x4c8dff, points: 4000, finished: false },
        ],
      },
      { onRetry: () => {}, onGarage: () => {} },
    );
    const block = root.querySelector<HTMLElement>('.dr-versus');
    expect(block).not.toBeNull();
    const text = (block!.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain('Ты против ботов');
    expect(text).toContain('Место: 2 из 3');
    expect(block!.querySelectorAll('li')).toHaveLength(3);
    expect(block!.querySelector('li.is-player .dr-standings__place')?.textContent).toBe('2');
    // Under the stat tiles, above the coins.
    const grid = root.querySelector('.dr-results__grid')!;
    const earn = root.querySelector('.dr-earn')!;
    expect(grid.compareDocumentPosition(block!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(block!.compareDocumentPosition(earn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    screen.destroy();
  });

  it('has no versus block without bots', () => {
    const screen = showResults(
      root,
      RESULT,
      { newBest: false, bestScore: 5000, shareUrl: 'https://example.com/', versus: null },
      { onRetry: () => {}, onGarage: () => {} },
    );
    expect(root.querySelector('.dr-versus')).toBeNull();
    screen.destroy();
  });
});
