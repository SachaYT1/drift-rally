/**
 * Player-vs-bots standings (plan/2026-10-04-ghost-bots-design.md §2.2): the HUD block under the coin counter and
 * the row markup the results screen reuses. A row is rewritten only when its shown values change.
 */
import type { StandingRow } from '../shared/types';
import { formatPoints } from './format';
import { escapeHtml } from './screens';

export interface Standings {
  /** Rows best first; null hides the block (ghosts off). */
  update(rows: readonly StandingRow[] | null): void;
  destroy(): void;
}

function colorOf(r: StandingRow): string {
  return r.color === null ? '' : `#${r.color.toString(16).padStart(6, '0')}`;
}

function classOf(r: StandingRow): string {
  return `dr-standings__row${r.id === 'player' ? ' is-player' : ''}${r.finished ? ' is-done' : ''}`;
}

function innerHtml(r: StandingRow, place: number): string {
  return (
    `<span class="dr-standings__place dr-num">${place}</span><i class="dr-standings__dot" aria-hidden="true"></i>` +
    `<span class="dr-standings__name">${escapeHtml(r.name)}</span>` +
    `<b class="dr-standings__pts dr-num">${formatPoints(r.points)}</b>` +
    (r.finished
      ? '<span class="dr-standings__done" role="img" aria-label="финишировал">✓</span>'
      : '<span class="dr-standings__done" aria-hidden="true"></span>')
  );
}

/** What a row shows; a row is rewritten only when it changes. */
interface Shown {
  id: StandingRow['id'] | '';
  points: number;
  finished: boolean;
}

/** `<li>` rows for a static list (results screen). */
export function standingsListHtml(rows: readonly StandingRow[]): string {
  return rows
    .map((r, i) => {
      const c = colorOf(r);
      return `<li class="${classOf(r)}"${c ? ` style="--c:${c}"` : ''}>${innerHtml(r, i + 1)}</li>`;
    })
    .join('');
}

export function createStandings(parent: HTMLElement): Standings {
  const box = document.createElement('section');
  box.className = 'dr-panel dr-standings';
  box.hidden = true;
  box.setAttribute('aria-label', 'Места');
  const list = document.createElement('ol');
  list.className = 'dr-standings__list';
  box.appendChild(list);
  parent.appendChild(box);
  /** Per row; id '' forces the first write. */
  const shown: Shown[] = [];

  return {
    update(rows) {
      const hidden = rows === null;
      if (box.hidden !== hidden) box.hidden = hidden;
      if (rows === null) return;
      while (list.children.length > rows.length) list.lastElementChild?.remove();
      while (list.children.length < rows.length) list.appendChild(document.createElement('li'));
      // Rows dropped and added back are new, empty items: forget what the old ones showed.
      if (shown.length > rows.length) shown.length = rows.length;
      while (shown.length < rows.length) shown.push({ id: '', points: 0, finished: false });
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const s = shown[i];
        if (s.id === r.id && s.points === r.points && s.finished === r.finished) continue;
        s.id = r.id;
        s.points = r.points;
        s.finished = r.finished;
        const li = list.children[i] as HTMLElement;
        li.className = classOf(r);
        li.style.setProperty('--c', colorOf(r));
        li.innerHTML = innerHtml(r, i + 1);
      }
    },
    destroy() {
      box.remove();
    },
  };
}
