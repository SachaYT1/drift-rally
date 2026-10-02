/** «Поделиться»: share text and clipboard copy with a legacy fallback. */
import { formatPoints, pluralRu } from './format';

const POINT_FORMS = ['очко', 'очка', 'очков'] as const;

/** «Я набрал 48 210 очков в Drift Rally на трассе «Площадь»! Побей мой рекорд: <url>» */
export function buildShareText(points: number, url: string): string {
  const n = Math.max(0, Math.round(points));
  return `Я набрал ${formatPoints(n)} ${pluralRu(n, POINT_FORMS)} в Drift Rally на трассе «Площадь»! Побей мой рекорд: ${url}`;
}

/** Copy via the async Clipboard API, falling back to execCommand on a hidden textarea. Never throws. */
export async function copyText(text: string): Promise<boolean> {
  const clipboard = typeof navigator !== 'undefined' ? navigator?.clipboard : undefined;
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or insecure context: try the legacy path below.
    }
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.appendChild(area);
  try {
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    previous?.focus({ preventScroll: true });
  }
}
