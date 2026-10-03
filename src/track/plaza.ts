/**
 * Map 1 «Площадь» (design spec §3). Control points, decor x/z and the ground rectangle are MAP
 * units (mockup x, mockup y - 40). Obstacles, props, bombs and coins are authored as (s, lateral):
 * s = arc length from the first control point (not from the start line), lateral + = left.
 * The s values were measured by projecting the mockup positions onto the built centreline.
 */
import type {
  BombDef,
  CoinRowDef,
  DecorDef,
  FootprintShape,
  HeavyObstacleDef,
  LightPropDef,
  TrackDef,
  VisualId,
} from './trackDef';

const HALF_PI = Math.PI / 2;

/** Zone 4: four legs of the giant bench straddle the road at lateral +/-5.5; the seat passes overhead. */
const BENCH_LEGS: FootprintShape[] = [-2.5, 2.5].flatMap((x) =>
  [-5.5, 5.5].map((z): FootprintShape => ({ type: 'circle', x, z, r: 0.45 })),
);

const HEAVY: HeavyObstacleDef[] = [
  { id: 'bench', visual: 'bench', s: 779, lateral: 0, yaw: 0, footprint: BENCH_LEGS, occluder: true },
  {
    // Zone 3: parked just outside the right barrier at the apex of the right-hand wiggle, nose
    // turned toward the road. Anchor = bike centre; the front wheel hub sits 6.3 m ahead. Only the
    // front wheel collides, fitted to the visible tyre at car height (<= ~1.5 m; the tyre's top half
    // overhangs the car): the road-side end (bx + r = 9.1, the tyre at ~1.1 m) reaches lateral ~ -6.2,
    // ~0.8 m onto the road; r = tyre half-width. The barrier-side end crosses the barrier (lateral
    // ~ -12.35), so no car-trapping gap opens between barrier and tyre.
    id: 'bicycle',
    visual: 'bicycle',
    s: 572,
    lateral: -14,
    yaw: 0.9,
    footprint: [{ type: 'capsule', ax: 3.65, az: 0, bx: 7.8, bz: 0, r: 1.3 }],
  },
  {
    // Zone 7: lies along the inside (right) edge at the left-side kink apex, reaching lateral ~ -4.5.
    id: 'sneaker',
    visual: 'sneaker',
    s: 1645,
    lateral: -5.5,
    yaw: 0,
    footprint: [{ type: 'capsule', ax: -2, az: 0, bx: 2, bz: 0, r: 1 }],
  },
];

const LIGHT: LightPropDef[] = [
  // Zone 2: paper cups on the outer edge of the fountain sweeper.
  { id: 'cup-1', kind: 'cup', s: 402, lateral: -5 },
  { id: 'cup-2', kind: 'cup', s: 438, lateral: -5 },
  { id: 'cup-3', kind: 'cup', s: 477, lateral: -5 },
  // Zone 6: soda cans alternating sides along the slalom wave.
  { id: 'can-1', kind: 'can', s: 1335, lateral: -3 },
  { id: 'can-2', kind: 'can', s: 1369, lateral: 3 },
  { id: 'can-3', kind: 'can', s: 1403, lateral: -3 },
  { id: 'can-4', kind: 'can', s: 1443, lateral: 3 },
  { id: 'can-5', kind: 'can', s: 1477, lateral: -3 },
  { id: 'can-6', kind: 'can', s: 1511, lateral: 3 },
];

/**
 * One bomb per long drift, on the inside of the corner 2.5 m off the centreline: the tight line passes over
 * it, the outside stays clear. Measured on the autopilot's drift line (it passes 1-3 m from each).
 */
const BOMBS: BombDef[] = [
  // Zone 2: apex of the fountain sweeper (left), before the inner coin row.
  { id: 'bomb-fountain', s: 390, lateral: 2.5 },
  // Zone 3: the left flick right after the bicycle.
  { id: 'bomb-bicycle', s: 630, lateral: 2.5 },
  // Zone 5: hairpin entry (right), before the coins on the inside.
  { id: 'bomb-hairpin', s: 1060, lateral: -2.5 },
  // Top-left: exit of the tight left before the sneaker kink.
  { id: 'bomb-corner', s: 1620, lateral: 2.5 },
];

/** Rows in lap order (coin ids follow this order). 28 coins. */
const COINS: CoinRowDef[] = [
  { s: 100, lateral: 0, count: 6, spacing: 8 }, // zone 1: start straight
  { s: 435, lateral: 4, count: 5, spacing: 10 }, // zone 2: fountain sweeper, inner line
  { s: 773, lateral: 0, count: 3, spacing: 6 }, // zone 4: under the bench
  { s: 1081, lateral: -4, count: 4, spacing: 8 }, // zone 5: hairpin, inside
  // Zone 6: on the weaving line, midway between consecutive cans.
  { s: 1352, lateral: 0, count: 1, spacing: 0 },
  { s: 1386, lateral: 0, count: 1, spacing: 0 },
  { s: 1423, lateral: 0, count: 1, spacing: 0 },
  { s: 1460, lateral: 0, count: 1, spacing: 0 },
  { s: 1530, lateral: 2, count: 3, spacing: 8 }, // top-left corner, inside
  { s: 1627, lateral: -2.5, count: 3, spacing: 7 }, // zone 7: brushing past the sneaker
];

/** Facing directions for decor (models face +Z; heading h faces (sin h, cos h)). */
const FACE_SOUTH = 0;
const FACE_EAST = HALF_PI;
const FACE_NORTH = Math.PI;
const FACE_WEST = -HALF_PI;

function decor(visual: VisualId, x: number, z: number, yaw = 0, extra: Partial<DecorDef> = {}): DecorDef {
  return { visual, x, z, yaw, ...extra };
}

/** Everything taller than tallDecorHeight stays >= tallDecorKeepOut from the centreline unless tagged occluder. */
const DECOR: DecorDef[] = [
  // Landmarks.
  decor('startArch', 199.9, 380.9, 1.566, { occluder: true }),
  decor('fountain', 480, 305),
  decor('planterTree', 330, 245, 0, { occluder: true }),
  // Office centre along the north edge, facing the plaza.
  decor('officeTower', -80, -140, FACE_SOUTH),
  decor('officeBlock', 60, -90, FACE_SOUTH),
  decor('officeTower', 200, -150, FACE_SOUTH),
  decor('officeBlock', 340, -80, FACE_SOUTH),
  decor('officeTower', 480, -140, FACE_SOUTH),
  decor('officeBlock', 620, -90, FACE_SOUTH),
  // East edge.
  decor('officeTower', 740, 60, FACE_WEST),
  decor('officeBlock', 700, 200, FACE_WEST),
  decor('officeTower', 740, 340, FACE_WEST),
  decor('officeBlock', 700, 480, FACE_WEST),
  // People: the spectator south of the start straight plus a few onlookers.
  decor('person', 300, 425, FACE_NORTH),
  decor('person', 620, 250, FACE_WEST),
  decor('person', 330, 0, FACE_SOUTH),
  decor('person', 20, 200, FACE_EAST),
  // Trees: perimeter corners, inside both lobes of the loop.
  decor('tree', 20, 29),
  decor('tree', 619, 29),
  decor('tree', 24, 388),
  decor('tree', 615, 388),
  decor('tree', 449, 179),
  decor('tree', 200, 209),
  decor('tree', -60, 250),
  decor('tree', 110, 450),
  decor('tree', 520, 450),
  // Bushes.
  decor('bush', 160, 300),
  decor('bush', 240, 300),
  decor('bush', 420, 140),
  decor('bush', 330, 160),
  decor('bush', 60, 450),
  decor('bush', 660, 150),
  // Lamps.
  decor('lamp', 120, 30),
  decor('lamp', 450, 10),
  decor('lamp', 400, 430),
  decor('lamp', 30, 120),
  decor('lamp', 620, 330),
  decor('lamp', 330, 340),
  // Benches and bins along the walkways.
  decor('bench', 250, 435, FACE_NORTH),
  decor('bench', 450, 120, FACE_SOUTH),
  decor('bench', 30, 300, FACE_EAST),
  decor('bench', 180, 160, FACE_SOUTH),
  decor('trashBin', 280, 440),
  decor('trashBin', 480, 15),
  decor('trashBin', 40, 340),
];

export const PLAZA: TrackDef = {
  id: 'plaza',
  name: 'Площадь',
  origin: [320, 230],
  controlPoints: [
    [150, 378], [270, 380], [390, 376], [470, 385], [535, 360], [562, 300], [560, 238], [540, 185], [554, 130], [540, 85], [490, 62],
    [420, 62], [380, 80], [372, 150], [372, 215], [370, 262], [352, 288], [330, 295], [308, 288], [290, 262], [287, 215], [287, 150],
    [270, 90], [218, 72], [163, 90], [128, 98], [98, 124], [84, 160], [82, 205], [102, 250], [82, 310], [95, 362],
  ],
  startS: 50,
  heavy: HEAVY,
  light: LIGHT,
  bombs: BOMBS,
  coins: COINS,
  decor: DECOR,
  ground: [-200, -260, 860, 700],
};
