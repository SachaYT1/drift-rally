/**
 * The car line-up (plan/2026-10-04-sport-cars.md): what the garage shows and sells, and what each car changes in
 * the physics. A car's `tuning` lists only the values that differ from TUNING; tuningFor() lays them over the
 * live TUNING. Every car shares Iskra's footprint (length, width, collision capsule, wheels): TuningOverrides does
 * not let a car change them, so collisions and the track's tight spots behave the same for every car. The drift
 * arcs (curvInto / curvNeutral / curvCounter) are never overridden either: the track was laid out for them.
 *
 * Balance (src/game/carsBalance.test.ts): drift points accrue per second of drifting, so raw speed does NOT pay (a
 * faster car finishes sooner); the drift angle does. Pricier cars hold wider angles: Искра < Квадро < Ронин <
 * Скарабей in autopilot points, and Ронин has the fastest race.
 *
 * Names are fictional on purpose: the cars only evoke real ones (E30, Skyline, 911), never name them.
 */
import { DEG } from './math';
import { TUNING, type Tuning } from './tuning';

export const CAR_IDS = ['iskra', 'quadro', 'ronin', 'scarab'] as const;
export type CarId = (typeof CAR_IDS)[number];
/** The car every player starts with: free and always owned. */
export const DEFAULT_CAR: CarId = 'iskra';

/** Footprint values shared by every car (collision capsule, wheel placement): a car never overrides them. */
type Footprint = 'length' | 'width' | 'capsuleHalf' | 'radius' | 'wheelBase' | 'wheelRadius';

export interface TuningOverrides {
  car?: Partial<Omit<Tuning['car'], Footprint>>;
  drift?: Partial<Tuning['drift']>;
}

/** Garage card values, 0..100: display only, not physics parameters. */
export interface CarStats {
  speed: number;
  accel: number;
  handling: number;
  /** Drift angle. */
  angle: number;
}

export interface CarSpec {
  readonly id: CarId;
  /** Player-facing name. */
  readonly name: string;
  /** Garage subtitle under the name. */
  readonly subtitle: string;
  /** One line about the car's character. */
  readonly tagline: string;
  /** Coins; 0 = owned from the start. */
  readonly price: number;
  readonly stats: Readonly<CarStats>;
  readonly tuning: TuningOverrides;
}

export const CARS: Readonly<Record<CarId, CarSpec>> = {
  iskra: {
    id: 'iskra',
    name: 'Искра',
    subtitle: 'Дрифт-кар · задний привод',
    tagline: 'Лёгкая и послушная — с неё начинает каждый.',
    price: 0,
    stats: { speed: 76, accel: 85, handling: 77, angle: 60 },
    tuning: {},
  },
  quadro: {
    id: 'quadro',
    name: 'Квадро',
    subtitle: 'Спорт-седан · задний привод',
    tagline: 'Предсказуемый занос и большой угол. Лучшая первая покупка.',
    price: 300,
    stats: { speed: 72, accel: 80, handling: 84, angle: 68 },
    tuning: {
      // Gentle and wide: kicks from a lower speed, holds a wider angle, swings the body in more softly and keeps
      // its speed in the slide (less drag), which also carries it wide of the bomb by the bicycle.
      car: { maxSpeed: 38, engineAccel: 11.5 },
      drift: {
        minSpeed: 7,
        kickSteerThreshold: 0.18,
        dragSlip: 5,
        slipNarrow: 16 * DEG,
        slipMid: 32 * DEG,
        slipWide: 47 * DEG,
        slipMax: 56 * DEG,
        bodyResponse: 7,
      },
    },
  },
  ronin: {
    id: 'ronin',
    name: 'Ронин',
    subtitle: 'Турбо-купе · задний привод',
    tagline: 'Мощный: держит занос на высокой скорости. Самый быстрый заезд.',
    price: 900,
    stats: { speed: 90, accel: 92, handling: 74, angle: 80 },
    tuning: {
      // Power: needs speed to kick, grips harder before it lets go, keeps its speed in a wide slide.
      car: { maxSpeed: 43, engineAccel: 13.5, maxLatAccelGrip: 15 },
      drift: {
        minSpeed: 9,
        thrust: 10.5,
        driftTopSpeed: 60,
        dragSlip: 4.5,
        slipNarrow: 20 * DEG,
        slipMid: 39 * DEG,
        slipWide: 53 * DEG,
        slipMax: 60 * DEG,
      },
    },
  },
  scarab: {
    id: 'scarab',
    name: 'Скарабей',
    subtitle: 'Спорткар · задний мотор',
    tagline: 'Резко срывается и быстро перекладывается. Сложный, но с самым высоким потолком очков.',
    price: 2000,
    stats: { speed: 84, accel: 88, handling: 92, angle: 86 },
    tuning: {
      // Rear-engined snap: lets go early, rotates and flicks fast, drops out of a slide sooner off the throttle.
      car: { maxSpeed: 42, engineAccel: 13, maxLatAccelGrip: 13 },
      drift: {
        kickSteerThreshold: 0.15,
        bodyResponse: 11,
        bodyMaxYawRate: 5,
        flickBlendTime: 0.22,
        slipNarrow: 20 * DEG,
        slipMid: 38 * DEG,
        slipWide: 52 * DEG,
        slipMax: 60 * DEG,
        thrust: 10,
        exitDelay: 0.2,
        gripBlendTime: 0.25,
      },
    },
  },
};

export function isCarId(v: unknown): v is CarId {
  return typeof v === 'string' && (CAR_IDS as readonly string[]).includes(v);
}

/**
 * `base` with the car's overrides laid over its car and drift sections (every other section is shared). A car
 * without overrides gets `base` itself, so the DEV debug GUI's live edits keep reaching a running race; other
 * cars get a snapshot of car / drift taken when the race starts.
 */
export function tuningFor(id: CarId, base: Tuning = TUNING): Tuning {
  const o = CARS[id].tuning;
  if (!o.car && !o.drift) return base;
  return { ...base, car: { ...base.car, ...o.car }, drift: { ...base.drift, ...o.drift } };
}
