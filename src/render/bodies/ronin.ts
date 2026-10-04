/**
 * «Ронин»: a Japanese turbo coupe in the spirit of the R32–R34 GT-R (no badges, no real name): a long hood with
 * a vent, a low glasshouse set back behind a raked windshield, a tall rear wing, four round tail lights, slim
 * headlights, a front lip and side skirts. Bayside-blue paint, bronze wheels.
 */
import { TUNING } from '../../shared/tuning';
import { COLORS, type CarBody, type Materials, type PartBuilder } from '../carParts';

const PAINT = 0x2556b4;
const HALF_PI = Math.PI / 2;

function build(b: PartBuilder, m: Materials): void {
  const L = TUNING.car.length;
  const F = L / 2;
  const { paint, trim, lamps } = m;
  // Lower body; long hood with a dark vent; short boot deck.
  b.rounded(paint, null, 1.78, 0.42, L - 0.08, 0.1, 0, 0.61, 0);
  b.rounded(paint, null, 1.7, 0.1, 1.5, 0.05, 0, 0.85, 1.18);
  b.box(trim, COLORS.dark, 0.52, 0.03, 0.34, 0, 0.905, 1.2);
  b.rounded(paint, null, 1.7, 0.1, 0.72, 0.05, 0, 0.85, -1.58);
  // Low glasshouse set back: glass block, raked windshield (top leans back) and rear glass (top leans forward),
  // a flat roof; door mirrors.
  b.rounded(trim, COLORS.glass, 1.42, 0.36, 1.36, 0.06, 0, 1.06, -0.36);
  b.box(trim, COLORS.glass, 1.4, 0.52, 0.04, 0, 1.08, 0.36, -0.85);
  b.box(trim, COLORS.glass, 1.4, 0.44, 0.04, 0, 1.075, -1.085, 0.66);
  b.rounded(paint, null, 1.46, 0.07, 1.1, 0.03, 0, 1.25, -0.4);
  for (const sx of [1, -1]) b.box(paint, null, 0.12, 0.07, 0.12, sx * 0.84, 0.98, 0.32);
  // Tall rear wing on two dark uprights.
  for (const sx of [1, -1]) b.box(trim, COLORS.dark, 0.06, 0.2, 0.1, sx * 0.56, 1.0, -1.78);
  b.rounded(paint, null, 1.62, 0.05, 0.32, 0.02, 0, 1.12, -1.8);
  // Four round tail lights.
  for (const x of [0.42, 0.66]) for (const sx of [1, -1]) b.cylinder(lamps, COLORS.taillight, 0.1, 0.04, 14, sx * x, 0.7, -F + 0.035, HALF_PI);
  // Slim headlights, a dark grille, the front lip and side skirts (between the wheels).
  for (const sx of [1, -1]) b.box(lamps, COLORS.headlight, 0.42, 0.09, 0.04, sx * 0.58, 0.74, F - 0.035);
  b.box(trim, COLORS.dark, 0.56, 0.1, 0.04, 0, 0.72, F - 0.035);
  b.box(trim, COLORS.dark, 1.74, 0.05, 0.22, 0, 0.4, F - 0.1);
  for (const sx of [1, -1]) b.box(trim, COLORS.dark, 0.06, 0.08, 1.5, sx * 0.88, 0.42, 0);
}

export const RONIN: CarBody = { paint: PAINT, wheel: { hub: 0xa07d3b, cap: 0x1e1e21 }, build };
