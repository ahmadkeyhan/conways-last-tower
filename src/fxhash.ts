// fxHash integration.
// window.$fx is defined by the standalone snippet at public/fxhash.min.js, loaded
// first in index.html. The snippet must stay a separate file (the sandbox locates
// and version-checks it) — do NOT bundle the SDK. To refresh it, re-copy
// node_modules/@fxhash/project-sdk/dist/fxhash.min.js into public/.
import { SEED_DENSITY, pickSeedDensity, type RulesetName } from './engine';
import type { StampTier } from './stamps';
import { deriveSkin, type Skin } from './skin';

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
  gridSize:     number;       // max grid dimension (N)
  ruleset:      RulesetName;
  stampTier:    StampTier;    // internal — edit-mode stamp library (not a feature)
  historyDepth: number;       // internal — max generations stored (not a feature)
  seedDensity:  number;       // opening-soup live fraction (sampled in the ruleset's band)
  skinId:       string;
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

// ── Feature bucketing — fxhash rarity works best with few distinct values ──────

const gridTier = (n: number): string =>
  n <= 85 ? 'Small' : n <= 106 ? 'Medium' : 'Large';

// Position of the sampled density within its ruleset's band → coarse tier.
function densityTier(name: RulesetName, v: number): string {
  const [lo, hi] = SEED_DENSITY[name];
  const t = (v - lo) / (hi - lo);
  return t < 1 / 3 ? 'Sparse' : t < 2 / 3 ? 'Balanced' : 'Dense';
}

const RULESET_LABEL: Record<RulesetName, string> = {
  classic:  'Classic',
  highlife: 'HighLife',
  maze:     'Maze',
  daynight: 'Day & Night',
  brain:    "Brian's Brain",
};

export function initFx(): FxContext {
  const api = window.$fx; // defined by the bundled @fxhash/project-sdk import

  const rng = () => api.rand();

  function pick<T>(choices: T[]): T {
    return choices[Math.floor(rng() * choices.length)];
  }

  function lerp(min: number, max: number): number {
    return Math.floor(rng() * (max - min + 1)) + min;
  }

  const rulesetNames: RulesetName[] = ['classic', 'highlife', 'maze', 'daynight', 'brain'];

  // Picked first so the rng stream stays stable; deriveSkin needs it (Brian's
  // Brain swaps the tower/dying hues since dying cells are everywhere).
  const ruleset: RulesetName = pick(rulesetNames);

  // Seed-derived palette — drawn at a fixed point after the ruleset.
  const skin = deriveSkin(rng, ruleset === 'brain');

  // Fixed draw order: ruleset → skin → gridSize → stampTier → historyDepth → seedDensity.
  const traits: TokenTraits = {
    gridSize:     lerp(64, 128),
    ruleset,
    stampTier:    pick([1, 2, 3, 4, 5, 6]) as StampTier,
    historyDepth: lerp(100, 200),
    seedDensity:  pickSeedDensity(ruleset, rng),
    skinId:       skin.id,
  };

  // Public features — bucketed for fxhash rarity. Stamp Library / History Depth
  // are intentionally omitted (they don't affect the autonomous render).
  api.features({
    'Ruleset':      RULESET_LABEL[ruleset],
    'Skin':         skin.name,
    'Grid Size':    gridTier(traits.gridSize),
    'Seed Density': densityTier(ruleset, traits.seedDensity),
  });

  return {
    rng, traits, skin,
    isCapture: api.context === 'capture' || api.isPreview,
    preview: () => api.preview(),
  };
}
