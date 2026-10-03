import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StandingRow } from '../shared/types';
import { createStandings, standingsListHtml, type Standings } from './standings';
import { installDom } from './domTestEnv';

await installDom();
afterAll(() => vi.unstubAllGlobals());

const row = (id: StandingRow['id'], points: number, finished = false): StandingRow => ({
  id,
  name: id === 'player' ? 'Ты' : id === 'rookie' ? 'Новичок' : id === 'pro' ? 'Профи' : 'Мастер',
  color: id === 'player' ? null : id === 'rookie' ? 0x3fd6a0 : id === 'pro' ? 0x4c8dff : 0xb070ff,
  points,
  finished,
});

const norm = (s: string | null): string => (s ?? '').replace(/\s+/g, ' ').trim();

describe('HUD standings (jsdom)', () => {
  let root: HTMLElement;
  let st: Standings;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
    st = createStandings(root);
  });

  afterEach(() => {
    st.destroy();
    root.remove();
  });

  const items = (): HTMLElement[] => Array.from(root.querySelectorAll<HTMLElement>('.dr-standings li'));

  it('is hidden until it gets rows, and hides again for null', () => {
    const box = root.querySelector<HTMLElement>('.dr-standings')!;
    expect(box.hidden).toBe(true);
    st.update([row('player', 10)]);
    expect(box.hidden).toBe(false);
    st.update(null);
    expect(box.hidden).toBe(true);
  });

  it('lists the rows in order with places, names, points, colour dots and the player highlighted', () => {
    st.update([row('master', 12400), row('player', 9800), row('pro', 5000, true), row('rookie', 0)]);
    const li = items();
    expect(li).toHaveLength(4);
    expect(li.map((e) => e.querySelector('.dr-standings__place')?.textContent)).toEqual(['1', '2', '3', '4']);
    expect(li.map((e) => e.querySelector('.dr-standings__name')?.textContent)).toEqual(['Мастер', 'Ты', 'Профи', 'Новичок']);
    expect(norm(li[0].querySelector('.dr-standings__pts')?.textContent ?? '')).toMatch(/^12\s400$/);
    expect(li[1].classList.contains('is-player')).toBe(true);
    expect(li[0].classList.contains('is-player')).toBe(false);
    expect(li[2].classList.contains('is-done')).toBe(true);
    expect(li[3].classList.contains('is-done')).toBe(false);
    expect(li[0].style.getPropertyValue('--c')).toBe('#b070ff');
  });

  it('rewrites only the rows whose shown values changed', () => {
    const pts = (): (Element | null)[] => items().map((e) => e.querySelector('.dr-standings__pts'));
    st.update([row('master', 100), row('player', 50)]);
    const [a, b] = pts();
    st.update([row('master', 100), row('player', 50)]);
    expect(pts()).toEqual([a, b]);
    st.update([row('master', 100), row('player', 60)]);
    const after = pts();
    expect(after[0]).toBe(a);
    expect(after[1]).not.toBe(b);
    expect(norm(after[1]?.textContent ?? '')).toBe('60');
  });

  it('follows a change in the number of rows', () => {
    st.update([row('player', 1), row('rookie', 0)]);
    expect(items()).toHaveLength(2);
    st.update([row('player', 1), row('rookie', 0), row('pro', 0)]);
    expect(items()).toHaveLength(3);
    st.update([row('player', 1)]);
    expect(items()).toHaveLength(1);
  });
});

describe('standingsListHtml', () => {
  it('renders the same rows for the results screen', () => {
    const host = document.createElement('ol');
    host.innerHTML = standingsListHtml([row('player', 3000, true), row('rookie', 2500, true)]);
    const li = Array.from(host.querySelectorAll('li'));
    expect(li).toHaveLength(2);
    expect(li[0].classList.contains('is-player')).toBe(true);
    expect(norm(li[1].textContent)).toContain('Новичок');
  });
});
