// fxHash v3 integration — stub
// The $fx object is injected by fxHash at runtime. At dev-time we shim it.

import type { RulesetName } from './engine';
import type { StampTier } from './stamps';
import { deriveSkin, type Skin } from './skin';

// ── fxHash v3 global (injected at runtime) ────────────────────────────────────

declare global {
  interface Window {
    $fx?: FxHashAPI;
  }
}

type FxHashAPI = {
  rand: () => number;
  features: (traits: Record<string, string | number | boolean>) => void;
  isPreview: boolean;
  preview: () => void;
  minter: string;
  iteration: number;
};

// ── Seeded RNG shim for local dev ─────────────────────────────────────────────
// Simple mulberry32 so dev builds behave deterministically

function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0; s = s + 0xfa2b1af8 | 0;
    let t = Math.imul(s ^ (s >>> 5), 1 | s);
    t = t + Math.imul(t ^ (t >>> 6), 61 | t) ^ t;
    return ((t ^ (t >>> 12)) >>> 0) / 4293967206;
  };
}

function getAPI(): FxHashAPI {
  if (window.$fx) return window.$fx;
  // dev shim
  const rng = mulberry32(0xdeadbeef);
  return {
    rand:       rng,
    features:   () => {},
    isPreview:  false,
    preview:    () => {},
    minter:     'dev',
    iteration:  0,
  };
}

// ── Trait extraction ──────────────────────────────────────────────────────────

export type TokenTraits = {
  gridSize:     number;       // max grid dimension (N)
  ruleset:      RulesetName;
  stampTier:    StampTier;
  historyDepth: number;       // max generations stored
  skinId:       string;
};

export type FxContext = {
  rng:    () => number;
  traits: TokenTraits;
  skin:   Skin;
};

export function initFx(): FxContext {
  const api = getAPI();

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

  const traits: TokenTraits = {
    gridSize:     lerp(64,128),
    ruleset,
    stampTier:    pick([1, 2, 3, 4, 5, 6]) as StampTier,
    historyDepth: 90,
    skinId:       skin.id,
  };

  api.features({
    'Grid Size':     traits.gridSize,
    'Ruleset':       traits.ruleset,
    'Stamp Library': traits.stampTier,
    'History Depth': traits.historyDepth,
    'Skin':          skin.name,
  });

  return { rng, traits, skin };
}
