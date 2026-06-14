// Rarity system — weighted trait draws, per-axis rarity points, and the headline
// Rarity tier. All weight/point tables live here so the distribution is tunable
// in one place. Brian's Brain is kept in the points maps (so its code paths stay
// intact) but is intentionally absent from RULESET_WEIGHTS — it is never minted.

import type { RulesetName } from './engine';

export type GridTier      = 'Small' | 'Medium' | 'Large';
export type DensityTier   = 'Sparse' | 'Balanced' | 'Dense';
export type AccentVariant = 'White' | 'Complementary' | 'Silver' | 'Prismatic';
export type PaletteMode    = 'standard' | 'monochrome' | 'noisy' | 'rainbow';
export type RarityTier    = 'Common' | 'Uncommon' | 'Rare' | 'Epic' | 'Legendary';

// ── Weighted pick ──────────────────────────────────────────────────────────────
// Consumes exactly one rng() per call (keeps the draw order deterministic).
export function weightedPick<T>(rng: () => number, entries: readonly [T, number][]): T {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [value, w] of entries) {
    if ((r -= w) < 0) return value;
  }
  return entries[entries.length - 1][0];
}

// ── Ruleset (Brian's Brain excluded from the draw) ─────────────────────────────
export const RULESET_WEIGHTS: readonly [RulesetName, number][] = [
  ['classic', 35], ['highlife', 30], ['daynight', 25], ['maze', 10],
];
export const RULESET_POINTS: Record<RulesetName, number> = {
  classic: 0, highlife: 1, daynight: 2, maze: 3, brain: 0,
};

// ── Grid size — tier picked, then a value sampled within the tier's range ───────
export const GRID_TIER_WEIGHTS: readonly [GridTier, number][] = [
  ['Small', 45], ['Medium', 35], ['Large', 20],
];
export const GRID_TIER_POINTS: Record<GridTier, number> = { Small: 0, Medium: 1, Large: 2 };
export const GRID_TIER_RANGE: Record<GridTier, readonly [number, number]> = {
  Small: [64, 85], Medium: [86, 106], Large: [107, 128],
};

// ── Seed density — tier picked, value sampled in the ruleset-aware band ─────────
export const DENSITY_TIER_WEIGHTS: readonly [DensityTier, number][] = [
  ['Balanced', 50], ['Sparse', 25], ['Dense', 25],
];
export const DENSITY_TIER_POINTS: Record<DensityTier, number> = {
  Balanced: 0, Sparse: 1, Dense: 1,
};

// Per-ruleset sustainable density centers. Density is relative to what each rule
// can keep alive — Maze/Brain saturate fast so they live near ~0.08; Day & Night
// needs ~0.4+ or it collapses. Value = center + triangular jitter (±spread).
export const DENSITY_BANDS: Record<
  RulesetName,
  { sparse: number; balanced: number; dense: number; spread: number }
> = {
  classic:  { sparse: 0.20, balanced: 0.30, dense: 0.42, spread: 0.05 },
  highlife: { sparse: 0.20, balanced: 0.30, dense: 0.42, spread: 0.05 },
  maze:     { sparse: 0.05, balanced: 0.08, dense: 0.11, spread: 0.02 },
  daynight: { sparse: 0.32, balanced: 0.42, dense: 0.50, spread: 0.05 },
  brain:    { sparse: 0.05, balanced: 0.08, dense: 0.11, spread: 0.02 },
};

// Triangular sample around the band's tier center (two-rng average → peak at center).
export function sampleDensity(
  rng: () => number, ruleset: RulesetName, tier: DensityTier,
): number {
  const band = DENSITY_BANDS[ruleset];
  const center = tier === 'Sparse' ? band.sparse : tier === 'Dense' ? band.dense : band.balanced;
  const jitter = (rng() + rng() - 1) * band.spread; // triangular in [-spread, +spread]
  return Math.min(0.95, Math.max(0.01, center + jitter));
}

// ── Accent variant ─────────────────────────────────────────────────────────────
export const ACCENT_WEIGHTS: readonly [AccentVariant, number][] = [
  ['White', 46], ['Complementary', 30], ['Silver', 15], ['Prismatic', 9],
];
export const ACCENT_POINTS: Record<AccentVariant, number> = {
  White: 0, Complementary: 1, Silver: 2, Prismatic: 4,
};

// ── Palette mode ───────────────────────────────────────────────────────────────
export const PALETTE_WEIGHTS: readonly [PaletteMode, number][] = [
  ['standard', 50], ['monochrome', 30], ['noisy', 14], ['rainbow', 6],
];
export const PALETTE_POINTS: Record<PaletteMode, number> = {
  standard: 0, monochrome: 1, noisy: 2, rainbow: 4,
};
export const PALETTE_LABEL: Record<PaletteMode, string> = {
  standard: 'Standard', monochrome: 'Monochrome', noisy: 'Noisy', rainbow: 'Rainbow',
};

// ── Rarity tier ────────────────────────────────────────────────────────────────
// Thresholds + weights calibrated by 200k simulation. Resulting frequencies ≈
// Common 39% · Uncommon 34% · Rare 18% · Epic 6.5% · Legendary 1.6%
// (Prismatic/NoisyMono weights were bumped to lift Legendary onto its ~1.5% target).
export function rarityTier(points: number): RarityTier {
  if (points <= 3) return 'Common';
  if (points <= 5) return 'Uncommon';
  if (points <= 7) return 'Rare';
  if (points <= 9) return 'Epic';
  return 'Legendary';
}
