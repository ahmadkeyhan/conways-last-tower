// fxHash integration.
// window.$fx is defined by the standalone snippet at public/fxhash.min.js, loaded
// first in index.html. The snippet must stay a separate file (the sandbox locates
// and version-checks it) — do NOT bundle the SDK. To refresh it, re-copy
// node_modules/@fxhash/project-sdk/dist/fxhash.min.js into public/.
import type { RulesetName } from './engine';
import type { StampTier } from './stamps';
import { deriveSkin, type Skin } from './skin';
import {
  weightedPick, sampleDensity, rarityTier,
  RULESET_WEIGHTS, RULESET_POINTS,
  GRID_TIER_WEIGHTS, GRID_TIER_POINTS, GRID_TIER_RANGE,
  DENSITY_TIER_WEIGHTS, DENSITY_TIER_POINTS,
  ACCENT_WEIGHTS, ACCENT_POINTS,
  PALETTE_WEIGHTS, PALETTE_POINTS, PALETTE_LABEL,
  SHAPE_WEIGHTS, SHAPE_POINTS, SHAPE_LABEL,
  type AccentVariant, type PaletteMode, type ShapeKind, type RarityTier,
} from './rarity';

// Minimal local typing for the snippet's $fx — only the members we use. Keeps
// the build decoupled from the SDK package (which is not imported at runtime).
type FxHashAPI = {
  rand: () => number;
  features: (features: Record<string, string | number | boolean>) => void;
  context: 'standalone' | 'capture' | 'minting' | string;
  isPreview: boolean;
  preview: () => void;
};
declare global {
  interface Window { $fx: FxHashAPI }
}

// ── Trait extraction ──────────────────────────────────────────────────────────

export type TokenTraits = {
  gridSize:     number;        // grid dimension (N), sampled within the grid tier
  ruleset:      RulesetName;
  stampTier:    StampTier;     // internal — edit-mode stamp library (not a feature)
  historyDepth: number;        // internal — max generations stored (not a feature)
  seedDensity:  number;        // opening-soup live fraction (ruleset-aware band)
  // Simplex seeding params (internal — not features)
  noiseFrequency: number;
  noiseOffsetX:   number;
  noiseOffsetY:   number;
  skinId:       string;
  // Rarity axes
  accent:       AccentVariant;
  palette:      PaletteMode;
  shape:        ShapeKind;
  rarity:       RarityTier;
};

export type FxContext = {
  rng:    () => number;
  traits: TokenTraits;
  skin:   Skin;
  // True when fxhash is generating the static preview image (context "capture",
  // or the legacy ?preview=1). Drives the gen-120 still in App.
  isCapture: boolean;
  preview:   () => void;  // signal the snapshot is ready ($fx.preview())
};

const RULESET_LABEL: Record<RulesetName, string> = {
  classic:  'Classic',
  highlife: 'HighLife',
  maze:     'Maze',
  daynight: 'Day & Night',
  brain:    "Brian's Brain",
};

// Accent half of the compound "Visual" feature. Dormant variants (Dark/Chrome)
// are included so the map stays total over AccentVariant.
const ACCENT_CAP: Record<AccentVariant, string> = {
  White:         'White Cap',
  Complementary: 'Complementary Cap',
  Prismatic:     'Prismatic Cap',
  Pulse:         'Pulse Cap',
  Dark:          'Dark Cap',
  Chrome:        'Chrome Cap',
};

export function initFx(): FxContext {
  const api = window.$fx; // defined by the standalone fxhash snippet

  const rng = () => api.rand();

  const pick = <T,>(choices: T[]): T => choices[Math.floor(rng() * choices.length)];
  const lerp = (min: number, max: number): number => Math.floor(rng() * (max - min + 1)) + min;

  // ── Weighted draws (fixed order — deterministic per seed) ─────────────────
  //   ruleset → palette → accent → skin → gridTier+value → density → shape
  const ruleset       = weightedPick(rng, RULESET_WEIGHTS);
  const paletteMode   = weightedPick(rng, PALETTE_WEIGHTS);
  const accentVariant = weightedPick(rng, ACCENT_WEIGHTS);

  const skin = deriveSkin(rng, {
    brainSwap: ruleset === 'brain', // never true while brain is out of the draw
    paletteMode,
    accentVariant,
  });

  const gridTier   = weightedPick(rng, GRID_TIER_WEIGHTS);
  const [gLo, gHi] = GRID_TIER_RANGE[gridTier];
  const gridSize   = lerp(gLo, gHi);

  const densityTier = weightedPick(rng, DENSITY_TIER_WEIGHTS);
  const seedDensity = sampleDensity(rng, ruleset, densityTier);

  // Simplex seeding params (consumed by seedWithNoise in App).
  const noiseFrequency = 0.08 + rng() * 0.12; // 0.08–0.20
  const noiseOffsetX   = rng() * 1000;
  const noiseOffsetY   = rng() * 1000;

  const shape = weightedPick(rng, SHAPE_WEIGHTS);

  // Internal-only traits (not features); drawn last so they don't perturb the
  // rarity-relevant stream above.
  const stampTier    = pick([1, 2, 3, 4, 5, 6]) as StampTier;
  const historyDepth = lerp(100, 200);

  // ── Rarity score → tier ───────────────────────────────────────────────────
  const points =
    RULESET_POINTS[ruleset] +
    GRID_TIER_POINTS[gridTier] +
    DENSITY_TIER_POINTS[densityTier] +
    ACCENT_POINTS[accentVariant] +
    PALETTE_POINTS[paletteMode] +
    SHAPE_POINTS[shape];
  const rarity = rarityTier(points);

  const traits: TokenTraits = {
    gridSize, ruleset, stampTier, historyDepth, seedDensity,
    noiseFrequency, noiseOffsetX, noiseOffsetY,
    skinId: skin.id, accent: accentVariant, palette: paletteMode, shape, rarity,
  };

  // The Skin hue family is only meaningful when the tower carries that hue —
  // B&W greyscales the scene and Prismatic spans every hue, so report those.
  const skinFeature =
    paletteMode === 'bnw'       ? 'Greyscale'
    : paletteMode === 'prismatic' ? 'Spectrum'
    : skin.name;

  // Palette + Accent merge into one compound "Visual" feature, e.g.
  // "B&W Tower / Pulse Cap". PALETTE_LABEL already yields the "… Tower" half.
  const visual = `${PALETTE_LABEL[paletteMode]} / ${ACCENT_CAP[accentVariant]}`;

  // Public features (7).
  api.features({
    'Ruleset':      RULESET_LABEL[ruleset],
    'Shape':        SHAPE_LABEL[shape],
    'Grid Size':    gridTier,
    'Seed Density': densityTier,
    'Skin':         skinFeature,
    'Visual':       visual,
    'Rarity':       rarity,
  });

  return {
    rng, traits, skin,
    isCapture: api.context === 'capture' || api.isPreview,
    preview: () => api.preview(),
  };
}
