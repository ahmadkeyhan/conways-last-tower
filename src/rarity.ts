// Rarity system — weighted trait draws, per-axis rarity points, and the headline
// Rarity tier. All weight/point tables live here so the distribution is tunable
// in one place. Brian's Brain is kept in the points maps (so its code paths stay
// intact) but is intentionally absent from RULESET_WEIGHTS — it is never minted.

import type { RulesetName } from './engine';

export type GridTier      = 'Small' | 'Medium' | 'Large';
// 'Chrome' / 'Dark' stay in the union (code intact) but are not in ACCENT_WEIGHTS — never minted.
export type AccentVariant = 'White' | 'Dark' | 'Complementary' | 'Chrome' | 'Prismatic' | 'Pulse';
export type PaletteMode    = 'colored' | 'bnw' | 'textured' | 'prismatic';
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

// ── Seed density — a hidden per-token opening intensity, NOT a feature/tier ─────
// Sampled uniformly in the ruleset's interval (what each rule can sustain: Maze
// fossilizes fast → tiny; Day & Night needs ~0.4+). Doesn't affect rarity.
export const DENSITY_RANGE: Record<RulesetName, readonly [number, number]> = {
  classic:  [0.15, 0.50],
  highlife: [0.15, 0.50],
  daynight: [0.28, 0.50],
  maze:     [0.03, 0.06],
  brain:    [0.03, 0.06], // dormant
};

export function sampleDensity(rng: () => number, ruleset: RulesetName): number {
  const [lo, hi] = DENSITY_RANGE[ruleset];
  return lo + rng() * (hi - lo);
}

// ── Accent variant ─────────────────────────────────────────────────────────────
// Chrome and Dark are intentionally absent (dropped from the draw, not enough
// cap contrast); their code/points stay so they can still be forced for testing.
export const ACCENT_WEIGHTS: readonly [AccentVariant, number][] = [
  ['White', 55], ['Complementary', 30], ['Prismatic', 8], ['Pulse', 7],
];
export const ACCENT_POINTS: Record<AccentVariant, number> = {
  White: 0, Dark: 1, Complementary: 1, Chrome: 2, Pulse: 3, Prismatic: 4,
};

// ── Palette mode ───────────────────────────────────────────────────────────────
export const PALETTE_WEIGHTS: readonly [PaletteMode, number][] = [
  ['colored', 50], ['bnw', 30], ['textured', 14], ['prismatic', 6],
];
export const PALETTE_POINTS: Record<PaletteMode, number> = {
  colored: 0, bnw: 1, textured: 2, prismatic: 4,
};
export const PALETTE_LABEL: Record<PaletteMode, string> = {
  colored: 'Colored Tower', bnw: 'B&W Tower', textured: 'Textured Tower', prismatic: 'Prismatic Tower',
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
// Thresholds calibrated by simulation (Seed Density dropped as a rarity axis;
// max points now 15). Resulting frequencies ≈ Common 45% · Uncommon 32% ·
// Rare 16% · Epic 5.5% · Legendary 1.3% — close to the 50/28/15/5.5/1.5 target.
export function rarityTier(points: number): RarityTier {
  if (points <= 3) return 'Common';
  if (points <= 5) return 'Uncommon';
  if (points <= 7) return 'Rare';
  if (points <= 9) return 'Epic';
  return 'Legendary';
}
