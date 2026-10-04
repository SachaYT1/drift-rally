/** «Искра»: the open-top toy buggy from the user's garage reference; the starter car. */
import { TUNING } from '../../shared/tuning';
import { COLORS, type CarBody, type Materials, type PartBuilder } from '../carParts';

const PAINT = 0xf0573a;

/** Body parts in model space (y up from the ground, +Z forward, +X left). */
function build(b: PartBuilder, mats: Materials): void {
  const L = TUNING.car.length;
  const { paint, trim, lamps } = mats;
  // Paint: thick rounded slab, raised hood and rear deck, side rails around the open cockpit.
  b.rounded(paint, null, 1.72, 0.46, L, 0.15, 0, 0.63, 0);
  b.rounded(paint, null, 1.62, 0.16, 1.62, 0.07, 0, 0.86, 1.13);
  b.rounded(paint, null, 1.62, 0.13, 0.86, 0.06, 0, 0.84, -1.52);
  for (const sx of [0.78, -0.78]) b.rounded(paint, null, 0.16, 0.12, 1.46, 0.05, sx, 0.88, -0.38);
  // Underbody, headrest pad, front grille; seats sit on the painted cockpit deck.
  b.box(trim, COLORS.dark, 1.1, 0.24, 3.3, 0, 0.3, 0);
  b.rounded(trim, COLORS.dark, 1.12, 0.2, 0.24, 0.07, 0, 1.38, -0.98);
  b.box(trim, COLORS.dark, 0.66, 0.1, 0.04, 0, 0.66, L / 2 + 0.005);
  for (const sx of [0.4, -0.4]) {
    b.rounded(trim, COLORS.seat, 0.56, 0.12, 0.52, 0.04, sx, 0.92, -0.36);
    b.rounded(trim, COLORS.seat, 0.56, 0.44, 0.14, 0.05, sx, 1.1, -0.66, -0.18);
  }
  // Roll bar behind the seats.
  for (const sx of [0.58, -0.58]) b.box(trim, COLORS.metal, 0.07, 0.5, 0.07, sx, 1.1, -0.98);
  b.box(trim, COLORS.metal, 1.23, 0.07, 0.07, 0, 1.34, -0.98);
  // Windshield: silver frame + dark glass, raked back, standing on the hood's rear edge.
  const wsZ = 0.38;
  const wsTilt = -0.38;
  const wsH = 0.5;
  const cy = 0.9 + (wsH / 2) * Math.cos(wsTilt);
  const cz = wsZ + (wsH / 2) * Math.sin(wsTilt);
  b.box(trim, COLORS.glass, 1.26, wsH - 0.08, 0.03, 0, cy, cz, wsTilt);
  for (const sx of [0.66, -0.66]) b.box(trim, COLORS.frame, 0.07, wsH, 0.06, sx, cy, cz, wsTilt);
  const topY = 0.9 + wsH * Math.cos(wsTilt);
  const topZ = wsZ + wsH * Math.sin(wsTilt);
  b.box(trim, COLORS.frame, 1.39, 0.07, 0.06, 0, topY, topZ, wsTilt);
  b.box(trim, COLORS.frame, 1.39, 0.06, 0.08, 0, 0.92, wsZ, wsTilt);
  // White headlights on the nose, red tail lights on the tail.
  for (const sx of [0.56, -0.56]) {
    b.box(lamps, COLORS.headlight, 0.34, 0.12, 0.04, sx, 0.66, L / 2 + 0.005);
    b.box(lamps, COLORS.taillight, 0.3, 0.1, 0.04, sx, 0.66, -L / 2 - 0.005);
  }
}

export const ISKRA: CarBody = { paint: PAINT, wheel: { hub: 0xb4aea6, cap: PAINT }, build };
