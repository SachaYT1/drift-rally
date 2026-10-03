import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RaceResult, SaveData } from '../shared/types';
import type { Board, BoardLoad, LeaderboardPort, NickResult, NickStatus, Placement, Standing } from '../shared/leaderboard';
import { createNickForm } from './nickForm';
import { boardHtml } from './leaderboardView';
import { showResults } from './results';
import { createGarageUI, type GarageUI } from './garage';
import { click, fakeAnimations, installDom, keydown } from './domTestEnv';

const win = await installDom();
afterAll(() => vi.unstubAllGlobals());

const RESULT: RaceResult = {
  totalPoints: 1500,
  bestChain: 900,
  totalTime: 170,
  bestLap: 52,
  lapTimes: [60, 52, 58],
  coinsPicked: 3,
  coinsFromDrift: 1,
  coinsEarned: 4,
};
const SAVE: SaveData = { version: 1, coins: 120, bestScore: 1500, bestLapMs: 52_000, quality: 'medium', muted: false, ghosts: true };

const standing = (nick: string, place = 3, total = 12): Standing => ({ nick, place, total, score: 1500, lapMs: 52000 });
const norm = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();
const flush = async (n = 4): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

function fakePort(over: Partial<LeaderboardPort> = {}) {
  let nick: string | null = null;
  return {
    nick: vi.fn<LeaderboardPort['nick']>(over.nick ?? (() => nick)),
    canJoin: vi.fn<LeaderboardPort['canJoin']>(over.canJoin ?? (() => true)),
    board: vi.fn<LeaderboardPort['board']>(over.board ?? (async (): Promise<BoardLoad> => ({ ok: true, board: { top: [], me: null, total: 0 } }))),
    checkNick: vi.fn<LeaderboardPort['checkNick']>(over.checkNick ?? (async (): Promise<NickStatus> => 'free')),
    setNick: vi.fn<LeaderboardPort['setNick']>(
      over.setNick ??
        (async (raw: string): Promise<NickResult> => {
          nick = raw.trim();
          return { ok: true, standing: standing(nick) };
        }),
    ),
    setOwnNick: (n: string | null) => (nick = n),
  };
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function submit(form: HTMLFormElement): void {
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

describe('nick form (jsdom)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
  });
  afterEach(() => {
    root.remove();
    vi.useRealTimers();
  });

  it('flags a bad format at once and a taken nick after the pause', async () => {
    vi.useFakeTimers();
    const port = fakePort({ checkNick: vi.fn(async (): Promise<NickStatus> => 'taken') });
    const form = createNickForm({ port, submitLabel: 'В таблицу', onDone: () => {}, checkDelayMs: 300 });
    root.appendChild(form.el);
    const input = form.el.querySelector('input')!;
    const msg = form.el.querySelector<HTMLElement>('.dr-nick__msg')!;

    type(input, 'a b');
    expect(msg.textContent).toBe('Только буквы, цифры, _ и -');
    expect(msg.dataset.tone).toBe('bad');

    type(input, 'Ёжик');
    expect(port.checkNick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(port.checkNick).toHaveBeenCalledWith('Ёжик');
    expect(msg.textContent).toBe('Ник занят, выбери другой');
    form.destroy();
  });

  it('ignores an availability answer for text that changed since', async () => {
    vi.useFakeTimers();
    let answer: (s: NickStatus) => void = () => {};
    const port = fakePort({ checkNick: vi.fn(() => new Promise<NickStatus>((r) => (answer = r))) });
    const form = createNickForm({ port, submitLabel: 'OK', onDone: () => {}, checkDelayMs: 10 });
    const input = form.el.querySelector('input')!;
    const msg = form.el.querySelector<HTMLElement>('.dr-nick__msg')!;
    type(input, 'Ёжик');
    await vi.advanceTimersByTimeAsync(10);
    type(input, 'x');
    answer('taken');
    await flush();
    expect(msg.textContent).toBe('Нужно от 2 до 16 символов');
    form.destroy();
  });

  it('submits, shows a taken nick from the server, then succeeds', async () => {
    const onDone = vi.fn();
    const port = fakePort();
    port.setNick.mockResolvedValueOnce({ ok: false, error: 'nick_taken' });
    const form = createNickForm({ port, submitLabel: 'В таблицу', onDone });
    root.appendChild(form.el);
    const input = form.el.querySelector('input')!;
    const msg = form.el.querySelector<HTMLElement>('.dr-nick__msg')!;

    input.focus();
    input.value = 'Ёжик';
    submit(form.el);
    // Read-only while sending, focus stays in the field (a disabled one would drop it to the page).
    expect(input.readOnly).toBe(true);
    expect(form.el.getAttribute('aria-busy')).toBe('true');
    expect(document.activeElement).toBe(input);
    await flush();
    expect(msg.textContent).toBe('Ник занят, выбери другой');
    expect(input.readOnly).toBe(false);
    expect(onDone).not.toHaveBeenCalled();

    input.value = 'Ёжик2';
    submit(form.el);
    await flush();
    expect(onDone).toHaveBeenCalledWith(standing('Ёжик2'));
    form.destroy();
  });

  it('does not send an invalid nick', () => {
    const port = fakePort();
    const form = createNickForm({ port, submitLabel: 'OK', onDone: () => {} });
    form.el.querySelector('input')!.value = 'x';
    submit(form.el);
    expect(port.setNick).not.toHaveBeenCalled();
    expect(form.el.querySelector('.dr-nick__msg')!.textContent).toBe('Нужно от 2 до 16 символов');
    form.destroy();
  });
});

describe('friends table markup', () => {
  const board: Board = {
    top: [
      { place: 1, nick: 'Петя', score: 3000, lapMs: 50000 },
      { place: 2, nick: '<b>x</b>', score: 2000, lapMs: null },
    ],
    me: { place: 37, nick: 'Ёжик', score: 100, lapMs: 70000 },
    total: 40,
  };

  it('escapes nicks, highlights the player and appends their row below the top', () => {
    const el = document.createElement('div');
    el.innerHTML = boardHtml(board, 'ёжик');
    const rows = [...el.querySelectorAll('tbody tr')];
    expect(rows.map((r) => norm(r.textContent))).toEqual(['1 Петя 3 000 0:50.00', '2 <b>x</b> 2 000 —', '…', '37 Ёжик 100 1:10.00']);
    expect(rows[3].classList.contains('is-me')).toBe(true);
    expect(el.querySelector('tbody b')).toBeNull();
    expect(norm(el.querySelector('.dr-note')!.textContent)).toBe('Игроков в таблице: 40');
  });

  it('highlights the player inside the top without a second row', () => {
    const el = document.createElement('div');
    el.innerHTML = boardHtml({ ...board, me: board.top[0] }, 'Петя');
    expect(el.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(el.querySelector('tr.is-me')!.textContent).toContain('Петя');
  });

  it('invites to be first on an empty table', () => {
    const el = document.createElement('div');
    el.innerHTML = boardHtml({ top: [], me: null, total: 0 }, null);
    expect(el.textContent).toContain('Пока никого');
  });
});

describe('results screen friends slot (jsdom)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    fakeAnimations(win);
    root = document.createElement('div');
    document.body.appendChild(root);
  });
  afterEach(() => root.remove());

  const open = (placement: Promise<Placement>, port = fakePort(), onRetry = vi.fn()) =>
    showResults(
      root,
      RESULT,
      { newBest: true, bestScore: 1500, shareUrl: 'https://example.com/', leaderboard: { placement, port } },
      { onRetry, onGarage: () => {} },
    );

  it('shows the place once the finish was sent', async () => {
    let resolve: (p: Placement) => void = () => {};
    const screen = open(new Promise((r) => (resolve = r)));
    const slot = root.querySelector('[data-ref="lb"]')!;
    expect(norm(slot.textContent)).toBe('Место в таблице: отправляем…');
    resolve({ kind: 'placed', place: 3, total: 12 });
    await flush();
    expect(norm(slot.textContent)).toBe('Место в таблице: #3 из 12');
    screen.destroy();
  });

  it('says the result waits for the next launch when the table is unreachable', async () => {
    const screen = open(Promise.resolve({ kind: 'offline' }));
    await flush();
    expect(norm(root.querySelector('[data-ref="lb"]')!.textContent)).toContain('уйдёт при следующем запуске');
    screen.destroy();
  });

  it('offers the nick field without a nick; joining shows the place', async () => {
    const port = fakePort();
    const onRetry = vi.fn();
    const screen = open(Promise.resolve({ kind: 'noNick' }), port, onRetry);
    await flush();
    const slot = root.querySelector('[data-ref="lb"]')!;
    expect(norm(slot.textContent)).toContain('Попади в таблицу друзей: введи ник');
    const input = slot.querySelector('input')!;
    input.focus();
    // Typing never triggers the screen's shortcuts: Enter in the field submits the form, not «Ещё раз».
    keydown('Enter');
    expect(onRetry).not.toHaveBeenCalled();
    input.value = 'Ёжик';
    submit(slot.querySelector('form')!);
    await flush();
    expect(port.setNick).toHaveBeenCalledWith('Ёжик');
    expect(norm(slot.textContent)).toBe('Место в таблице: #3 из 12');
    screen.destroy();
  });

  it('a second Enter while the nick is being sent does not restart the race', async () => {
    let answer: (r: NickResult) => void = () => {};
    const port = fakePort({ setNick: vi.fn(() => new Promise<NickResult>((r) => (answer = r))) });
    const onRetry = vi.fn();
    vi.spyOn(performance, 'now').mockReturnValue(1e9); // past the screen's arming delay
    const screen = open(Promise.resolve({ kind: 'noNick' }), port, onRetry);
    await flush();
    const slot = root.querySelector('[data-ref="lb"]')!;
    const input = slot.querySelector('input')!;
    input.focus();
    input.value = 'Ёжик';
    submit(slot.querySelector('form')!);
    keydown('Enter');
    expect(onRetry).not.toHaveBeenCalled();
    answer({ ok: true, standing: standing('Ёжик') });
    await flush();
    expect(norm(slot.textContent)).toBe('Место в таблице: #3 из 12');
    screen.destroy();
    vi.restoreAllMocks();
  });

  it('has no slot without a leaderboard', () => {
    const screen = showResults(root, RESULT, { newBest: false, bestScore: 1, shareUrl: '' }, { onRetry: () => {}, onGarage: () => {} });
    expect(root.querySelector('[data-ref="lb"]')).toBeNull();
    screen.destroy();
  });
});

describe('garage records with the friends table (jsdom)', () => {
  let root: HTMLElement;
  let ui: GarageUI;
  beforeEach(() => {
    fakeAnimations(win);
    root = document.createElement('div');
    document.body.appendChild(root);
  });
  afterEach(() => {
    ui.destroy();
    root.remove();
  });

  const mount = (port: ReturnType<typeof fakePort>, onMute = vi.fn()) => {
    ui = createGarageUI(root, { save: SAVE, trackName: 'Площадь', onStart: () => {}, onMute, leaderboard: port });
    click(root.querySelector('[data-open="records"]')!);
    return root.querySelector<HTMLElement>('.dr-friends')!;
  };

  it('loads the table and shows the player nick with «Сменить ник»', async () => {
    const port = fakePort({
      board: vi.fn(async (): Promise<BoardLoad> => ({
        ok: true,
        board: { top: [{ place: 1, nick: 'Ёжик', score: 1500, lapMs: 52000 }], me: null, total: 1 },
      })),
    });
    port.setOwnNick('Ёжик');
    const friends = mount(port);
    expect(friends.textContent).toContain('Загружаем таблицу');
    await flush();
    expect(norm(friends.querySelector('.dr-friends__me')!.textContent)).toBe('Ты в таблице как Ёжик Сменить ник');
    expect(friends.querySelector('tr.is-me')).not.toBeNull();
  });

  it('changes the nick and reloads the table; typing M in the field does not toggle sound', async () => {
    const port = fakePort();
    port.setOwnNick('Ёжик');
    const onMute = vi.fn();
    const friends = mount(port, onMute);
    await flush();
    click(friends.querySelector('[data-act="rename"]')!);
    const input = friends.querySelector('input')!;
    expect(input.value).toBe('Ёжик');
    expect(document.activeElement).toBe(input);
    keydown('KeyM');
    expect(onMute).not.toHaveBeenCalled();
    input.value = 'Ёж';
    submit(friends.querySelector('form')!);
    await flush(8);
    expect(port.setNick).toHaveBeenCalledWith('Ёж');
    expect(port.board).toHaveBeenCalledTimes(2);
    expect(norm(friends.querySelector('.dr-friends__me')!.textContent)).toBe('Ты в таблице как Ёж Сменить ник');
  });

  it('keeps a half-typed nick when the save changes', async () => {
    const port = fakePort();
    const friends = mount(port);
    await flush();
    const input = friends.querySelector('input')!;
    input.value = 'Ёж';
    ui.update({ ...SAVE, coins: 200 });
    expect(root.querySelector('.dr-friends input')).toBe(input);
    expect(input.value).toBe('Ёж');
  });

  it('asks for a finished race first, and says when the table is unavailable', async () => {
    const port = fakePort({ canJoin: vi.fn(() => false), board: vi.fn(async (): Promise<BoardLoad> => ({ ok: false })) });
    const friends = mount(port);
    await flush();
    expect(friends.querySelector('input')).toBeNull();
    expect(friends.textContent).toContain('Финишируй заезд');
    expect(friends.textContent).toContain('Таблица недоступна');
    click(friends.querySelector('[data-act="reload"]')!);
    expect(port.board).toHaveBeenCalledTimes(2);
  });
});
