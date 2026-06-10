// fxHash v3 integration — stub
// The $fx object is injected by fxHash at runtime. At dev-time we shim it.

import type { RulesetName } from './engine';
import type { StampTier } from './stamps';

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
    s |= 0; s = s + 0x6d2b79f5 | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
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

  const traits: TokenTraits = {
    gridSize:     lerp(32, 128),
    ruleset:      pick(rulesetNames),
    stampTier:    pick([1, 2, 3, 4, 5, 6]) as StampTier,
    historyDepth: lerp(50, 500),
    skinId:       pick(['stone', 'crystal', 'neon', 'obsidian', 'ivory']),
  };

  api.features({
    'Grid Size':     traits.gridSize,
    'Ruleset':       traits.ruleset,
    'Stamp Library': traits.stampTier,
    'History Depth': traits.historyDepth,
    'Skin':          traits.skinId,
  });

  return { rng, traits };
}
