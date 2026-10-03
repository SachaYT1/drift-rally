/**
 * «Скарабей»: a rear-engined sports coupe in the spirit of the classic 911 (no badges, no real name): a round
 * body, bug-eye headlights in the front wings, a low hood between them, a fastback falling to the tail, wide
 * rear haunches, a ducktail spoiler and a full-width tail light bar. Signal-yellow paint, silver wheels.
 */
import { TUNING } from '../../shared/tuning';
import { COLORS, type CarBody, type Materials, type PartBuilder } from '../carParts';

const PAINT = 0xf4c23d;
const HALF_PI = Math.PI / 2;

function build(b: PartBuilder, m: Materials): void {
  const L = TUNING.car.length;
  const F = L / 2;
  const WB = TUNING.car.wheelBase / 2;
  const { paint, trim, lamps } = m;
  // Round lower body.
  b.rounded(paint, null, 1.7, 0.4, L - 0.14, 0.16, 0, 0.6, 0);
  // Front wings rise above the low hood; bug-eye headlights (tilted up a little) in dark rings at their noses.
  for (const sx of [1, -1]) {
    b.rounded(paint, null, 0.42, 0.22, 1.12, 0.1, sx * 0.63, 0.83, WB - 0.05);
    b.cylinder(trim, COLORS.dark, 0.125, 0.04, 16, sx * 0.63, 0.86, F - 0.2, HALF_PI - 0.25);
    b.cylinder(lamps, COLORS.headlight, 0.1, 0.04, 16, sx * 0.63, 0.86, F - 0.18, HALF_PI - 0.25);
  }
  // Low hood between the wings, falling toward the nose.
  b.rounded(paint, null, 0.86, 0.08, 1.2, 0.04, 0, 0.82, 1.22, 0.06);
  // Wide rear haunches over the rear wheels.
  for (const sx of [1, -1]) b.rounded(paint, null, 0.34, 0.26, 1.2, 0.12, sx * 0.74, 0.84, -WB + 0.05);
  // Round glasshouse behind a raked windshield, a short roof, the fastback falling from the roof to the tail.
  b.rounded(trim, COLORS.glass, 1.32, 0.4, 1.3, 0.14, 0, 1.03, -0.12);
  b.box(trim, COLORS.glass, 1.3, 0.42, 0.04, 0, 1.06, 0.56, -0.7);
  b.rounded(paint, null, 1.34, 0.08, 0.82, 0.04, 0, 1.24, -0.2);
  b.rounded(paint, null, 1.36, 0.1, 1.3, 0.05, 0, 1.0, -1.12, -0.32);
  for (const sx of [1, -1]) b.box(paint, null, 0.12, 0.07, 0.12, sx * 0.8, 0.98, 0.4);
  // Ducktail lip rising toward the tail.
  b.rounded(paint, null, 1.28, 0.05, 0.34, 0.02, 0, 0.92, -1.86, 0.3);
  // Full-width tail light bar over a dark engine grille; slim dark bumpers.
  b.box(lamps, COLORS.taillight, 1.36, 0.06, 0.04, 0, 0.74, -F + 0.055);
  b.box(trim, COLORS.dark, 0.7, 0.1, 0.04, 0, 0.6, -F + 0.055);
  for (const sz of [1, -1]) b.rounded(trim, COLORS.dark, 1.66, 0.1, 0.12, 0.04, 0, 0.44, sz * (F - 0.04));
}

export const SCARAB: CarBody = { paint: PAINT, wheel: { hub: 0xd6d8db, cap: 0x1e1e21 }, build };
