/**
 * Nick field shared by the results screen (join the friends table) and the garage records (join / change the
 * nick). Checks the nick while typing (format at once, availability after a pause) and submits it.
 */
import { NICK_MAX, validateNick, type LeaderboardPort, type Standing } from '../shared/leaderboard';
import { qs } from './screens';

/** Pause after the last keystroke before asking the table whether the nick is free, ms. */
const CHECK_DELAY_MS = 400;

const HINT = '2–16 символов: буквы, цифры, _ и -';

const ERRORS: Record<string, string> = {
  length: 'Нужно от 2 до 16 символов',
  chars: 'Только буквы, цифры, _ и -',
  nick_taken: 'Ник занят, выбери другой',
  invalid: HINT,
  unavailable: 'Таблица недоступна — попробуй позже',
  rejected: 'Таблица не приняла результат',
  no_result: 'Сначала финишируй заезд',
};

type Tone = 'hint' | 'good' | 'bad';

export interface NickForm {
  readonly el: HTMLFormElement;
  focus(): void;
  destroy(): void;
}

export interface NickFormOptions {
  port: Pick<LeaderboardPort, 'checkNick' | 'setNick'>;
  submitLabel: string;
  /** Prefilled nick (changing it). */
  initial?: string;
  /** Shows «Отмена» when set. */
  onCancel?(): void;
  /** The table accepted the nick. */
  onDone(standing: Standing): void;
  checkDelayMs?: number;
}

let formCount = 0;

export function createNickForm(opts: NickFormOptions): NickForm {
  const msgId = `dr-nick-msg-${++formCount}`;
  const el = document.createElement('form');
  el.className = 'dr-nick';
  el.noValidate = true;
  el.innerHTML = `<div class="dr-nick__row">
      <input class="dr-nick__input" type="text" name="nick" maxlength="${NICK_MAX}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Ник" aria-label="Ник" aria-describedby="${msgId}">
      <button type="submit" class="dr-btn dr-btn--primary dr-nick__submit"></button>
      ${opts.onCancel ? '<button type="button" class="dr-btn" data-act="cancel">Отмена</button>' : ''}
    </div>
    <p class="dr-nick__msg" id="${msgId}" role="status" aria-live="polite"></p>`;
  const input = qs<HTMLInputElement>(el, 'input');
  const submit = qs<HTMLButtonElement>(el, '.dr-nick__submit');
  const msg = qs(el, '.dr-nick__msg');
  submit.textContent = opts.submitLabel;
  input.value = opts.initial ?? '';

  const delay = opts.checkDelayMs ?? CHECK_DELAY_MS;
  let timer = 0;
  /** Bumped by every keystroke and submit: answers to older questions are dropped. */
  let seq = 0;
  let busy = false;
  let destroyed = false;

  function say(text: string, tone: Tone): void {
    msg.textContent = text;
    msg.dataset.tone = tone;
  }

  function setBusy(on: boolean): void {
    busy = on;
    input.disabled = on;
    submit.disabled = on;
  }

  async function check(value: string, at: number): Promise<void> {
    const status = await opts.port.checkNick(value);
    if (destroyed || busy || at !== seq) return;
    if (status === 'taken') say(ERRORS.nick_taken, 'bad');
    else if (status === 'free') say('Ник свободен', 'good');
    else say(HINT, 'hint');
  }

  function onInput(): void {
    window.clearTimeout(timer);
    const at = ++seq;
    const value = input.value;
    if (value.trim() === '') {
      say(HINT, 'hint');
      return;
    }
    const v = validateNick(value);
    if (!v.ok) {
      say(ERRORS[v.reason], 'bad');
      return;
    }
    // Unchanged prefilled nick: nothing to check.
    if (opts.initial !== undefined && v.nick === opts.initial) {
      say(HINT, 'hint');
      return;
    }
    timer = window.setTimeout(() => void check(v.nick, at), delay);
  }

  async function onSubmit(e: Event): Promise<void> {
    e.preventDefault();
    if (busy) return;
    window.clearTimeout(timer);
    const at = ++seq;
    const v = validateNick(input.value);
    if (!v.ok) {
      say(ERRORS[v.reason], 'bad');
      input.focus({ preventScroll: true });
      return;
    }
    setBusy(true);
    say('Отправляем…', 'hint');
    const r = await opts.port.setNick(v.nick);
    if (destroyed || at !== seq) return;
    setBusy(false);
    if (r.ok) {
      opts.onDone(r.standing);
      return;
    }
    say(ERRORS[r.error] ?? HINT, 'bad');
    input.focus({ preventScroll: true });
  }

  const onClick = (e: MouseEvent): void => {
    if (e.target instanceof Element && e.target.closest('[data-act="cancel"]')) opts.onCancel?.();
  };
  const onSubmitEvent = (e: Event): void => void onSubmit(e);

  input.addEventListener('input', onInput);
  el.addEventListener('submit', onSubmitEvent);
  el.addEventListener('click', onClick);
  say(HINT, 'hint');

  return {
    el,
    focus() {
      input.focus({ preventScroll: true });
      input.select();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      window.clearTimeout(timer);
      input.removeEventListener('input', onInput);
      el.removeEventListener('submit', onSubmitEvent);
      el.removeEventListener('click', onClick);
      el.remove();
    },
  };
}
