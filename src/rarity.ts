// Rarity system — weighted trait draws, per-axis rarity points, and the headline
// Rarity tier. All weight/point tables live here so the distribution is tunable
// in one place. Brian's Brain is kept in the points maps (so its code paths stay
// intact) but is intentionally absent from RULESET_WEIGHTS — it is never minted.

import type { RulesetName } from './engine';

export type GridTier      = 'Small' | 'Medium' | 'Large';
export type DensityTier   = 'Sparse' | 'Balanced' | 'Dense';
// 'Chrome' stays in the union (code intact) but is not in ACCENT_WEIGHTS — never minted.
export type AccentVariant = 'White' | 'Dark' | 'Complementary' | 'Chrome' | 'Prismatic';
export type PaletteMode    = 'standard' | 'monochrome' | 'noisy' | 'rainbow';
export type ShapeKind     = 'cube' | 'cylinder' | 'sphere';
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

// Per-ruleset sustainable density range [lo, hi]. Density is relative to what
// each rule can keep alive — the tier picks a sub-region of this range.
export const SEED_DENSITY: Record<RulesetName, readonly [number, number]> = {
  classic:  [0.30, 0.38], // standard soup — long-lived dynamics before settling
  highlife: [0.30, 0.38], // like classic plus replicators
  maze:     [0.03, 0.07], // permissive survival saturates fast
  daynight: [0.42, 0.50], // self-complementary; needs density near 0.5 or it collapses
  brain:    [0.03, 0.07], // kept for code integrity — never drawn
};

// Map the tier to a center within the ruleset's range, then triangular-sample
// around it (two-rng average → peak at center), clamped back into the range.
export function sampleDensity(
  rng: () => number, ruleset: RulesetName, tier: DensityTier,
): number {
  const [lo, hi] = SEED_DENSITY[ruleset];
  const span   = hi - lo;
  const center = tier === 'Sparse' ? lo + span * 0.17
               : tier === 'Dense'  ? hi - span * 0.17
               : lo + span * 0.5;
  const jitter = (rng() + rng() - 1) * span * 0.22;
  return Math.min(hi, Math.max(lo, center + jitter));
}

// ── Accent variant ─────────────────────────────────────────────────────────────
// Chrome and Dark are intentionally absent (dropped from the draw, not enough
// cap contrast); their code/points stay so they can still be forced for testing.
export const ACCENT_WEIGHTS: readonly [AccentVariant, number][] = [
  ['White', 62], ['Complementary', 30], ['Prismatic', 8],
];
export const ACCENT_POINTS: Record<AccentVariant, number> = {
  White: 0, Dark: 1, Complementary: 1, Chrome: 2, Prismatic: 4,
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

// ── Shape (body voxel geometry) ────────────────────────────────────────────────
export const SHAPE_WEIGHTS: readonly [ShapeKind, number][] = [
  ['cube', 60], ['cylinder', 30], ['sphere', 10],
];
export const SHAPE_POINTS: Record<ShapeKind, number> = { cube: 0, cylinder: 1, sphere: 2 };
export const SHAPE_LABEL: Record<ShapeKind, string> = {
  cube: 'Cube', cylinder: 'Cylinder', sphere: 'Sphere',
};

// ── Rarity tier ────────────────────────────────────────────────────────────────
// Thresholds calibrated by simulation (Shape axis in; Chrome + Dark out of the
// accent draw). Resulting frequencies ≈ Common 58% · Uncommon 27% · Rare 11% ·
// Epic 3.3% · Legendary 0.7% — each tier meaningfully rarer than the last.
export function rarityTier(points: number): RarityTier {
  if (points <= 4)  return 'Common';
  if (points <= 6)  return 'Uncommon';
  if (points <= 8)  return 'Rare';
  if (points <= 10) return 'Epic';
  return 'Legendary';
}
