/** Display formatting for the Russian UI. Pure, no DOM. */

/** Narrow no-break space (U+202F): Russian thousands separator that never wraps. */
export const THIN_SPACE = '\u202F';
/** Typographic minus (U+2212). */
export const MINUS = '\u2212';

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Race clock: 61.234 → "1:01.23". Truncates to centiseconds (never shows a time not yet reached). */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00.00';
  // Round to whole milliseconds first so float noise (61.23 * 100 = 6122.999…) cannot drop a centisecond.
  const cs = Math.floor(Math.round(seconds * 1000) / 10);
  const minutes = Math.floor(cs / 6000);
  const secs = Math.floor(cs / 100) % 60;
  return `${minutes}:${pad2(secs)}.${pad2(cs % 100)}`;
}

/** 48210 → "48 210" (U+202F groups); rounds to an integer; negatives use U+2212. */
export function formatPoints(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const v = Math.round(n);
  const digits = String(Math.abs(v));
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += THIN_SPACE;
    out += digits[i];
  }
  return v < 0 ? MINUS + out : out;
}

/** m/s → integer km/h string (magnitude). */
export function formatKmh(ms: number): string {
  if (!Number.isFinite(ms)) return '0';
  return String(Math.round(Math.abs(ms) * 3.6));
}

/** Russian plural: forms = [one, few, many], e.g. ['очко', 'очка', 'очков']. */
export function pluralRu(n: number, forms: readonly [string, string, string]): string {
  const abs = Math.abs(Math.trunc(n));
  const mod100 = abs % 100;
  const mod10 = abs % 10;
  if (mod100 >= 11 && mod100 <= 14) return forms[2];
  if (mod10 === 1) return forms[0];
  if (mod10 >= 2 && mod10 <= 4) return forms[1];
  return forms[2];
}

/** Optional lap time: null → dash placeholder. */
export function formatLap(seconds: number | null): string {
  return seconds === null ? '\u2013:\u2013\u2013.\u2013\u2013' : formatTime(seconds);
}
