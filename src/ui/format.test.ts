import { describe, expect, it } from 'vitest';
import { formatKmh, formatPoints, formatTime, pluralRu } from './format';

const NNBSP = '\u202F';

describe('formatTime', () => {
  it('formats minutes, seconds and centiseconds', () => {
    expect(formatTime(61.234)).toBe('1:01.23');
    expect(formatTime(0)).toBe('0:00.00');
    expect(formatTime(9.5)).toBe('0:09.50');
    expect(formatTime(185.07)).toBe('3:05.07');
  });
  it('truncates instead of rounding up to the next second', () => {
    expect(formatTime(59.999)).toBe('0:59.99');
    // 61.23 * 100 is 6122.999… in floating point; must still show .23
    expect(formatTime(61.23)).toBe('1:01.23');
  });
  it('is safe for negative and non-finite input', () => {
    expect(formatTime(-3)).toBe('0:00.00');
    expect(formatTime(Number.NaN)).toBe('0:00.00');
    expect(formatTime(Number.POSITIVE_INFINITY)).toBe('0:00.00');
  });
});

describe('formatPoints', () => {
  it('groups thousands with narrow no-break spaces', () => {
    expect(formatPoints(48210)).toBe(`48${NNBSP}210`);
    expect(formatPoints(1240)).toBe(`1${NNBSP}240`);
    expect(formatPoints(1234567)).toBe(`1${NNBSP}234${NNBSP}567`);
  });
  it('leaves small numbers alone and rounds fractions', () => {
    expect(formatPoints(0)).toBe('0');
    expect(formatPoints(999)).toBe('999');
    expect(formatPoints(999.6)).toBe(`1${NNBSP}000`);
  });
  it('uses a typographic minus for negatives and 0 for non-finite', () => {
    expect(formatPoints(-1500)).toBe(`−1${NNBSP}500`);
    expect(formatPoints(Number.NaN)).toBe('0');
  });
});

describe('formatKmh', () => {
  it('converts m/s to integer km/h', () => {
    expect(formatKmh(0)).toBe('0');
    expect(formatKmh(10)).toBe('36');
    expect(formatKmh(40)).toBe('144');
    expect(formatKmh(8.33)).toBe('30');
  });
  it('shows magnitude only and is safe for non-finite input', () => {
    expect(formatKmh(-5)).toBe('18');
    expect(formatKmh(Number.NaN)).toBe('0');
  });
});

describe('pluralRu', () => {
  const forms: [string, string, string] = ['очко', 'очка', 'очков'];
  it('picks the Russian plural form', () => {
    expect(pluralRu(1, forms)).toBe('очко');
    expect(pluralRu(21, forms)).toBe('очко');
    expect(pluralRu(3, forms)).toBe('очка');
    expect(pluralRu(44, forms)).toBe('очка');
    expect(pluralRu(5, forms)).toBe('очков');
    expect(pluralRu(11, forms)).toBe('очков');
    expect(pluralRu(12, forms)).toBe('очков');
    expect(pluralRu(111, forms)).toBe('очков');
    expect(pluralRu(48210, forms)).toBe('очков');
    expect(pluralRu(0, forms)).toBe('очков');
  });
});
