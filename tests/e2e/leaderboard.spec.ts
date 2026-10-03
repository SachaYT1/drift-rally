/**
 * Friends leaderboard against a mocked Supabase REST API (plan/2026-10-03-leaderboard-design.md): join from the
 * results screen, see the place, browse and rename in «Рекорды», and keep a finish made offline for the next
 * launch. Every request to the project is answered by page.route, so the real table is never touched.
 */
import { expect, test, type Page, type Route } from '@playwright/test';

const API = 'https://brezucvcujjioibrmerd.supabase.co/rest/v1/';
const IDENTITY_KEY = 'driftRally.leaderboard.v1';
const KEY = 'e'.repeat(64);

interface Player {
  nick: string;
  key: string;
  score: number;
  lapMs: number | null;
  races: number;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'apikey, content-type, prefer',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Range',
};

/** An in-memory stand-in for the leaderboard RPC and view; `offline` makes every request fail. */
class FakeTable {
  players: Player[] = [];
  submits: Record<string, unknown>[] = [];
  offline = false;

  constructor(seed: Player[]) {
    this.players = seed.map((p) => ({ ...p }));
  }

  ranked(): { place: number; nick: string; best_score: number; best_lap_ms: number | null }[] {
    const sorted = [...this.players].sort((a, b) => b.score - a.score || (a.lapMs ?? Infinity) - (b.lapMs ?? Infinity));
    return sorted.map((p) => ({
      place: 1 + sorted.filter((q) => q.score > p.score || (q.score === p.score && (q.lapMs ?? Infinity) < (p.lapMs ?? Infinity))).length,
      nick: p.nick,
      best_score: p.score,
      best_lap_ms: p.lapMs,
    }));
  }

  standing(p: Player) {
    const row = this.ranked().find((r) => r.nick === p.nick)!;
    return { ...row, total: this.players.length };
  }

  taken(nick: string, key: string): boolean {
    return this.players.some((p) => p.nick.toLowerCase() === nick.toLowerCase() && p.key !== key);
  }

  async handle(route: Route): Promise<void> {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (this.offline) return route.abort('internetdisconnected');
    const url = new URL(req.url());
    const path = url.pathname.replace('/rest/v1/', '');
    const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      route.fulfill({ status, headers: { ...CORS, ...headers }, contentType: 'application/json', body: JSON.stringify(body) });
    const refuse = (message: string) => reply(400, { code: 'P0001', message, details: null, hint: null });

    if (path === 'leaderboard_ranked') {
      const nick = url.searchParams.get('nick');
      const rows = nick ? this.ranked().filter((r) => `eq.${r.nick}` === nick) : this.ranked().slice(0, 20);
      return reply(200, rows, { 'Content-Range': rows.length ? `0-${rows.length - 1}/${this.players.length}` : `*/${this.players.length}` });
    }
    const body = req.postDataJSON() as Record<string, never>;
    if (path === 'rpc/nick_available') return reply(200, !this.taken(body.p_nick, ''));
    if (path === 'rpc/submit_result') {
      this.submits.push(body);
      if (this.taken(body.p_nick, body.p_key)) return refuse('nick_taken');
      let p = this.players.find((x) => x.key === body.p_key);
      if (!p) {
        p = { nick: body.p_nick, key: body.p_key, score: 0, lapMs: null, races: 0 };
        this.players.push(p);
      }
      p.nick = body.p_nick;
      p.score = Math.max(p.score, body.p_score);
      p.lapMs = p.lapMs === null ? body.p_lap_ms : Math.min(p.lapMs, body.p_lap_ms ?? Infinity);
      p.races += body.p_races;
      return reply(200, this.standing(p));
    }
    if (path === 'rpc/rename_player') {
      const p = this.players.find((x) => x.key === body.p_key);
      if (!p) return refuse('unknown_player');
      if (this.taken(body.p_nick, body.p_key)) return refuse('nick_taken');
      p.nick = body.p_nick;
      return reply(200, this.standing(p));
    }
    return reply(404, { message: 'not found' });
  }
}

async function openGame(page: Page, table: FakeTable): Promise<void> {
  await page.route(`${API}**`, (route) => table.handle(route));
  await page.goto('./?test');
  await expect(page.locator('.dr-cta')).toBeVisible({ timeout: 120_000 });
}

async function finishRace(page: Page): Promise<void> {
  await page.evaluate(() => window.__game!.startRace());
  await page.evaluate(() => window.__game!.finish());
  await expect(page.locator('.dr-results')).toBeVisible();
}

const SEED: Player[] = [{ nick: 'Петя', key: 'p'.repeat(64), score: 999, lapMs: 99_000, races: 3 }];

test('join from the results screen, then browse and rename in «Рекорды»', async ({ page }) => {
  const table = new FakeTable(SEED);
  await openGame(page, table);
  await finishRace(page);

  const slot = page.locator('.dr-results [data-ref="lb"]');
  await expect(slot).toContainText('Попади в таблицу друзей');
  const input = slot.locator('input');

  await test.step('a taken nick shows while typing', async () => {
    await input.fill('пЕтЯ');
    await expect(slot.locator('.dr-nick__msg')).toHaveText('Ник занят, выбери другой');
  });

  await test.step('joining shows the place', async () => {
    await input.fill('Ёжик');
    await input.press('Enter');
    await expect(slot).toContainText(/Место в таблице: #\d+ из 2/);
    // Enter in the field submitted the nick; it did not restart the race.
    await expect(page.locator('.dr-results')).toBeVisible();
    const identity = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)!), IDENTITY_KEY);
    expect(identity).toMatchObject({ nick: 'Ёжик', pendingRaces: 0 });
    expect(identity.key).toMatch(/^[0-9a-f]{64}$/);
    expect(table.submits.at(-1)).toMatchObject({ p_nick: 'Ёжик', p_key: identity.key, p_races: 1 });
  });

  await test.step('the garage table highlights the player', async () => {
    await page.locator('.dr-results [data-act="garage"]').click();
    await page.locator('[data-open="records"]').click();
    const friends = page.locator('.dr-friends');
    await expect(friends.locator('tbody tr')).toHaveCount(2);
    await expect(friends.locator('tr.is-me')).toContainText('Ёжик');
    await expect(friends.locator('.dr-friends__me')).toContainText('Ты в таблице как Ёжик');
  });

  await test.step('renaming onto a taken nick is refused, a free one sticks', async () => {
    const friends = page.locator('.dr-friends');
    await friends.locator('[data-act="rename"]').click();
    const field = friends.locator('input');
    await field.fill('Петя');
    await field.press('Enter');
    await expect(friends.locator('.dr-nick__msg')).toHaveText('Ник занят, выбери другой');
    await field.fill('Ёж');
    await field.press('Enter');
    await expect(friends.locator('.dr-friends__me')).toContainText('Ты в таблице как Ёж');
    await expect(friends.locator('tr.is-me')).toContainText('Ёж');
  });
});

test('a finish made offline is sent on the next launch', async ({ page }) => {
  const table = new FakeTable([...SEED, { nick: 'Ёжик', key: KEY, score: 10, lapMs: 300_000, races: 1 }]);
  await page.addInitScript(
    ([k, v]) => {
      // Only before the first load: the reload must see what the game stored.
      if (!sessionStorage.getItem('seeded')) {
        localStorage.setItem(k, v);
        sessionStorage.setItem('seeded', '1');
      }
    },
    [IDENTITY_KEY, JSON.stringify({ key: KEY, nick: 'Ёжик', pendingRaces: 0 })] as const,
  );
  table.offline = true;
  await openGame(page, table);
  await finishRace(page);

  await expect(page.locator('.dr-results [data-ref="lb"]')).toContainText('уйдёт при следующем запуске');
  expect(await page.evaluate((k) => JSON.parse(localStorage.getItem(k)!).pendingRaces, IDENTITY_KEY)).toBe(1);

  table.offline = false;
  await page.reload();
  await expect(page.locator('.dr-cta')).toBeVisible({ timeout: 120_000 });
  await expect.poll(() => table.submits.length).toBe(1);
  expect(table.submits[0]).toMatchObject({ p_key: KEY, p_nick: 'Ёжик', p_races: 1 });
  await expect.poll(() => page.evaluate((k) => JSON.parse(localStorage.getItem(k)!).pendingRaces, IDENTITY_KEY)).toBe(0);
});
