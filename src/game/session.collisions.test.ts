/** Session collision events: one hit/scrape per step, heavy hits always reported, scrapes cooled down per collider. */
import { describe, expect, it } from 'vitest';
import { createSession } from './session';
import { makeCircleTrack } from './testTracks';
import { DT, FULL_THROTTLE, runFor } from './testSession';
import { TUNING } from '../shared/tuning';
import { NEUTRAL_INPUT, type Collider, type GameEvent } from '../shared/types';

/** Circle track with circle obstacles `ahead` m straight ahead of the spawn, at the given side offsets. */
function wallAhead(ahead: number, offsets: number[], r: number) {
  const spawn = makeCircleTrack().spawnPose;
  const fx = Math.sin(spawn.heading);
  const fz = Math.cos(spawn.heading);
  const walls: Collider[] = offsets.map((o, k) => ({
    kind: 'circle',
    id: `post-${k}`,
    x: spawn.x + fx * ahead + fz * o,
    z: spawn.z + fz * ahead - fx * o,
    r,
  }));
  return createSession(makeCircleTrack(100, { walls }));
}

describe('session: collisions', () => {
  it('a heavy hit emits one hit and starts grace; scrapes respect the per-collider cooldown', () => {
    const sess = wallAhead(35, [0], 2);
    runFor(sess, TUNING.race.countdown + 0.05, () => NEUTRAL_INPUT);
    const contacts: { t: number; e: GameEvent }[] = [];
    for (let i = 0; i < 6 / DT; i++) {
      for (const e of sess.step(FULL_THROTTLE, { respawn: false }, DT)) {
        if (e.type === 'hit' || e.type === 'scrape') contacts.push({ t: sess.state().time, e });
      }
      if (contacts.length === 1 && contacts[0].t === sess.state().time) {
        const st = sess.state();
        expect(st.hitCooldowns['post-0']).toBe(TUNING.collision.cooldown);
        expect(st.progress.graceTimer).toBeGreaterThan(TUNING.progress.graceTime - 2 * DT);
        expect(st.car.mode).toBe('recover');
      }
    }
    const first = contacts[0].e;
    expect(first.type).toBe('hit');
    expect(first.type === 'hit' && first.impactSpeed).toBeGreaterThanOrEqual(TUNING.collision.heavyImpact);
    // Every contact event restarts the post's cooldown; a scrape only once it has run out. Heavy hits
    // ignore it (see the next test), so the spacing is checked for scrapes only.
    const scrapeGaps = contacts.flatMap((c, k) => (k > 0 && c.e.type === 'scrape' ? [c.t - contacts[k - 1].t] : []));
    expect(scrapeGaps.length).toBeGreaterThan(0);
    for (const gap of scrapeGaps) expect(gap).toBeGreaterThanOrEqual(TUNING.collision.cooldown - 1e-9);
  });

  it('a crash into two colliders at once reports a single event and cools both down', () => {
    const sess = wallAhead(35, [-1.2, 1.2], 1);
    runFor(sess, TUNING.race.countdown + 0.05, () => NEUTRAL_INPUT);
    for (let i = 0; i < 6 / DT; i++) {
      const ev = sess.step(FULL_THROTTLE, { respawn: false }, DT).filter((e) => e.type === 'hit' || e.type === 'scrape');
      if (ev.length === 0) continue;
      expect(ev).toHaveLength(1);
      expect(ev[0].type).toBe('hit');
      expect(Object.keys(sess.state().hitCooldowns).sort()).toEqual(['post-0', 'post-1']);
      return;
    }
    throw new Error('the car never reached the posts');
  });

  it('a heavy hit always emits a hit, even on a collider that is still cooling down', () => {
    // A long cooldown makes the second ram land inside it; scrapes stay throttled, heavy hits do not.
    const tuning = { ...TUNING, collision: { ...TUNING.collision, cooldown: 10 } };
    const spawn = makeCircleTrack().spawnPose;
    const post: Collider = {
      kind: 'circle',
      id: 'post',
      x: spawn.x + Math.sin(spawn.heading) * 35,
      z: spawn.z + Math.cos(spawn.heading) * 35,
      r: 2,
    };
    const sess = createSession(makeCircleTrack(100, { walls: [post] }), { tuning });
    runFor(sess, TUNING.race.countdown + 0.05, () => NEUTRAL_INPUT);
    // Ram the post, reverse away, ram it again.
    let firstHitAt = -1;
    const hits: { cooling: number; graceRestarted: boolean }[] = [];
    let heavySteps = 0;
    for (let i = 0; i < 12 / DT && hits.length < 2; i++) {
      const prev = sess.state();
      const backing = firstHitAt >= 0 && prev.time - firstHitAt < 2.5;
      const ev = sess.step(backing ? { ...NEUTRAL_INPUT, brake: 1 } : FULL_THROTTLE, { respawn: false }, DT);
      const st = sess.state();
      const graceRestarted = st.progress.graceTimer > prev.progress.graceTimer;
      if (graceRestarted) heavySteps++;
      if (!ev.some((e) => e.type === 'hit')) continue;
      if (firstHitAt < 0) firstHitAt = st.time;
      hits.push({ cooling: prev.hitCooldowns.post ?? 0, graceRestarted });
      expect(st.hitCooldowns.post).toBe(tuning.collision.cooldown);
    }
    expect(hits).toHaveLength(2);
    expect(hits[1].cooling).toBeGreaterThan(1);
    expect(hits.every((h) => h.graceRestarted)).toBe(true);
    // Every heavy contact (grace restart) came with its hit event.
    expect(heavySteps).toBe(2);
  });
});
