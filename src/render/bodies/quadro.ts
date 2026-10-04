/**
 * «Квадро»: a boxy late-80s German sport sedan in the spirit of the E30 M3 (no badges, no real name): flat
 * panels with sharp edges, box flares over the wheels, an upright glasshouse, black bumpers, a black nose with
 * four round headlights and twin kidney grilles, wide red tail lights and a boot-lip spoiler. Alpine white,
 * gold mesh wheels.
 */
import { TUNING } from '../../shared/tuning';
import { COLORS, type CarBody, type Materials, type PartBuilder } from '../carParts';

const PAINT = 0xf1f0ea;
const HALF_PI = Math.PI / 2;

function build(b: PartBuilder, m: Materials): void {
  const L = TUNING.car.length;
  const F = L / 2;
  const WB = TUNING.car.wheelBase / 2;
  const { paint, trim, lamps } = m;
  // Boxy lower body with small edge radii; hood and boot decks just below the beltline.
  b.rounded(paint, null, 1.74, 0.44, L - 0.12, 0.05, 0, 0.62, 0);
  b.rounded(paint, null, 1.66, 0.08, 1.15, 0.03, 0, 0.87, 1.3);
  b.rounded(paint, null, 1.66, 0.1, 0.78, 0.03, 0, 0.88, -1.5);
  // Box flares over all four wheels.
  for (const sx of [1, -1]) for (const z of [WB, -WB]) b.rounded(paint, null, 0.14, 0.17, 1.0, 0.04, sx * 0.86, 0.77, z);
  // Upright glasshouse: dark glass split into windows by body-colour A, B and C pillars, under a flat roof that
  // overhangs it a little; door mirrors.
  b.box(trim, COLORS.glass, 1.46, 0.38, 1.6, 0, 1.08, -0.14);
  for (const sx of [1, -1]) for (const z of [0.62, -0.1, -0.9]) b.box(paint, null, 0.04, 0.38, 0.1, sx * 0.735, 1.08, z);
  b.rounded(paint, null, 1.54, 0.08, 1.66, 0.03, 0, 1.3, -0.14);
  for (const sx of [1, -1]) b.box(paint, null, 0.12, 0.08, 0.12, sx * 0.84, 1.0, 0.56);
  // Black nose: four round headlights and twin kidneys (silver frame, dark inside).
  b.box(trim, COLORS.dark, 1.62, 0.2, 0.05, 0, 0.7, F - 0.03);
  for (const x of [0.44, 0.64]) for (const sx of [1, -1]) b.cylinder(lamps, COLORS.headlight, 0.075, 0.04, 12, sx * x, 0.7, F, HALF_PI);
  for (const sx of [1, -1]) {
    b.box(trim, COLORS.frame, 0.15, 0.17, 0.04, sx * 0.1, 0.71, F - 0.005);
    b.box(trim, COLORS.dark, 0.11, 0.13, 0.04, sx * 0.1, 0.71, F + 0.005);
  }
  // Chunky black bumpers.
  for (const sz of [1, -1]) b.rounded(trim, COLORS.dark, 1.8, 0.15, 0.18, 0.05, 0, 0.46, sz * (F - 0.02));
  // Wide red tail lights around a dark centre panel; boot-lip spoiler.
  for (const sx of [1, -1]) b.box(lamps, COLORS.taillight, 0.5, 0.15, 0.04, sx * 0.56, 0.74, -F + 0.045);
  b.box(trim, COLORS.dark, 0.6, 0.15, 0.04, 0, 0.74, -F + 0.045);
  b.box(trim, COLORS.dark, 1.42, 0.04, 0.14, 0, 0.95, -1.84);
}

export const QUADRO: CarBody = { paint: PAINT, wheel: { hub: 0xc9a24a, cap: 0x2b2b2e }, build };
