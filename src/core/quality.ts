/**
 * Render quality presets (design spec §5, Rendering rules). Pure, no three.js.
 *
 * Presets are rendering constants from the spec, not gameplay tuning, so they live here
 * rather than in shared/tuning.ts.
 */
import type { QualityLevel } from '../shared/types';

export interface QualityPreset {
  /** Upper bound for renderer.setPixelRatio. */
  readonly pixelRatioCap: number;
  readonly shadows: boolean;
}

export const QUALITY_PRESETS: Readonly<Record<QualityLevel, QualityPreset>> = Object.freeze({
  low: Object.freeze({ pixelRatioCap: 1, shadows: false }),
  medium: Object.freeze({ pixelRatioCap: 1.25, shadows: true }),
  high: Object.freeze({ pixelRatioCap: 1.5, shadows: true }),
});

/** Renderer strings of software rasterisers (SwiftShader, Mesa llvmpipe, Microsoft Basic Render). */
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|software|basic render/i;

export function isQualityLevel(value: unknown): value is QualityLevel {
  return typeof value === 'string' && Object.hasOwn(QUALITY_PRESETS, value);
}

/** Auto quality: 'low' on software renderers, otherwise 'medium'. `null` = renderer string unavailable. */
export function detectQuality(rendererName: string | null): QualityLevel {
  return rendererName !== null && SOFTWARE_RENDERER.test(rendererName) ? 'low' : 'medium';
}

/** min(devicePixelRatio, preset cap). A missing or invalid devicePixelRatio counts as 1. */
export function pixelRatioFor(level: QualityLevel, devicePixelRatio: number): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(dpr, QUALITY_PRESETS[level].pixelRatioCap);
}

export function shadowsFor(level: QualityLevel): boolean {
  return QUALITY_PRESETS[level].shadows;
}
