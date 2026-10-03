/**
 * Friends table inside the garage records modal: top rows with the player's row highlighted (appended below
 * the top when they rank lower), the player's nick with «Сменить ник», or the field to join.
 */
import { sameNick, type Board, type BoardRow, type LeaderboardPort } from '../shared/leaderboard';
import { formatPoints, formatTime } from './format';
import { createNickForm, type NickForm } from './nickForm';
import { escapeHtml, qs } from './screens';

export interface FriendsView {
  destroy(): void;
}

function rowHtml(r: BoardRow, me: boolean): string {
  const lap = r.lapMs === null ? '—' : formatTime(r.lapMs / 1000);
  return `<tr class="${me ? 'is-me' : ''}"${me ? ' aria-current="true"' : ''}>
      <td class="dr-board__place dr-num">${r.place}</td>
      <td class="dr-board__nick">${escapeHtml(r.nick)}</td>
      <td class="dr-num">${formatPoints(r.score)}</td>
      <td class="dr-num">${lap}</td>
    </tr>`;
}

/** The table markup for a loaded board; `nick`: the player's nick (highlighted), null when not on it. */
export function boardHtml(board: Board, nick: string | null): string {
  if (board.top.length === 0) return '<p class="dr-note">Пока никого. Финишируй заезд и впиши ник — будешь первым.</p>';
  const isMe = (r: BoardRow): boolean => nick !== null && sameNick(r.nick, nick);
  const rows = board.top.map((r) => rowHtml(r, isMe(r))).join('');
  const below = board.me !== null && !board.top.some(isMe) ? `<tr class="dr-board__gap"><td colspan="4">…</td></tr>${rowHtml(board.me, true)}` : '';
  return `<table class="dr-board">
      <thead><tr><th scope="col">#</th><th scope="col">Ник</th><th scope="col">Очки</th><th scope="col">Лучший круг</th></tr></thead>
      <tbody>${rows}${below}</tbody>
    </table>
    <p class="dr-note">Игроков в таблице: <b class="dr-num">${board.total}</b></p>`;
}

/** Mount the friends section into `el` (emptied first) and load the table. */
export function mountFriends(el: HTMLElement, port: LeaderboardPort): FriendsView {
  el.innerHTML = `<div class="dr-friends__head">
      <h3 class="dr-friends__title">Таблица друзей</h3>
      <div class="dr-friends__me" data-ref="me"></div>
    </div>
    <div class="dr-friends__body" data-ref="body" aria-live="polite"></div>`;
  const meEl = qs(el, '[data-ref="me"]');
  const bodyEl = qs(el, '[data-ref="body"]');
  let form: NickForm | null = null;
  let destroyed = false;
  /** Bumped per load: a slow answer must not overwrite a newer one. */
  let loadSeq = 0;

  function dropForm(): void {
    form?.destroy();
    form = null;
  }

  function showForm(initial: string | undefined): void {
    dropForm();
    meEl.innerHTML = initial === undefined ? '<p class="dr-friends__text">Впиши ник, чтобы попасть в таблицу.</p>' : '';
    form = createNickForm({
      port,
      submitLabel: initial === undefined ? 'В таблицу' : 'Сохранить',
      initial,
      onCancel: initial === undefined ? undefined : () => renderMe(true),
      onDone: () => {
        renderMe(true);
        void load();
      },
    });
    meEl.appendChild(form.el);
    if (initial !== undefined) form.focus();
  }

  /** `refocus`: the form had focus; hand it to «Сменить ник» instead of dropping it to the page. */
  function renderMe(refocus = false): void {
    dropForm();
    const nick = port.nick();
    if (nick !== null) {
      meEl.innerHTML = `<p class="dr-friends__text">Ты в таблице как <b class="dr-friends__nick"></b>
        <button type="button" class="dr-link" data-act="rename">Сменить ник</button></p>`;
      qs(meEl, '.dr-friends__nick').textContent = nick;
      if (refocus) qs(meEl, '[data-act="rename"]').focus({ preventScroll: true });
    } else if (port.canJoin()) {
      showForm(undefined);
    } else {
      meEl.innerHTML = '<p class="dr-friends__text">Финишируй заезд — и сможешь вписать ник в таблицу.</p>';
    }
  }

  async function load(): Promise<void> {
    const at = ++loadSeq;
    bodyEl.innerHTML = '<p class="dr-note">Загружаем таблицу…</p>';
    const r = await port.board();
    if (destroyed || at !== loadSeq) return;
    if (r.ok) {
      bodyEl.innerHTML = boardHtml(r.board, port.nick());
    } else {
      bodyEl.innerHTML = `<p class="dr-note">Таблица недоступна. Попробуй позже.
        <button type="button" class="dr-link" data-act="reload">Обновить</button></p>`;
    }
  }

  const onClick = (e: MouseEvent): void => {
    if (!(e.target instanceof Element)) return;
    const act = e.target.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'rename') showForm(port.nick() ?? undefined);
    else if (act === 'reload') void load();
  };
  el.addEventListener('click', onClick);

  renderMe();
  void load();

  return {
    destroy() {
      destroyed = true;
      dropForm();
      el.removeEventListener('click', onClick);
    },
  };
}
