// Aesthetic configuration — all visual parameters derived from the fxHash seed.

import type { AccentVariant, PaletteMode } from './rarity';

// noiseMap is sized to the largest possible grid so it can be generated at skin
// derivation time (before the grid-size draw). The renderer indexes it with the
// actual grid's stride: noiseMap[row * cols + col] (always < NOISE_DIM²).
export const NOISE_DIM = 128;

export type Skin = {
  id:   string;
  name: string;
  // Tower cubes (history + live body): main color + a darker speckle companion.
  towerColor:      string;
  towerNoiseColor: string;
  // Live-layer cap planes — the accent.
  accentColor:      string;
  accentNoiseColor: string;
  // Dying cells (Brian's Brain) — a triadic hue unrelated to tower/accent.
  dyingColor:       string;
  // Ground slab — always the base hue (tower tone), even when brain swaps the
  // tower hue, so the ground stays the world's base color.
  groundColor:      string;
  backgroundColor: string;
  gridColor:       string; // edit-mode grid lines (opacity applied in renderer)

  // ── Rarity variants ──────────────────────────────────────────────────────
  paletteMode: PaletteMode;          // standard | monochrome | noisy | rainbow
  // solid → flat caps · prismatic → rainbow caps · metallic → PBR caps · pulse → breathing caps
  accentMode:  'solid' | 'prismatic' | 'metallic' | 'pulse';
  // Per-cell HSL offsets for noisy (undefined otherwise). Signed values in
  // ~[-1, 1]; renderer scales into hue/lightness deltas.
  noiseMap?:   Float32Array;
};

// ── HSL → hex (pure; keeps this module THREE-free) ────────────────────────────
// h ∈ [0,360), s/l ∈ [0,1]. Returns '#rrggbb'.
function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  s = Math.min(1, Math.max(0, s));
  l = Math.min(1, Math.max(0, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if      (h <  60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else              { r = c; b = x; }
  const hex = (v: number) =>
    Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

// Named hue families at 30° centers — the discrete "Skin" trait value.
const FAMILIES: { name: string; hue: number }[] = [
  { name: 'Crimson', hue: 0   },
  { name: 'Amber',   hue: 30  },
  { name: 'Gold',    hue: 60  },
  { name: 'Lime',    hue: 90  },
  { name: 'Green',   hue: 120 },
  { name: 'Emerald', hue: 150 },
  { name: 'Cyan',    hue: 180 },
  { name: 'Azure',   hue: 210 },
  { name: 'Blue',    hue: 240 },
  { name: 'Violet',  hue: 270 },
  { name: 'Magenta', hue: 300 },
  { name: 'Rose',    hue: 330 },
];

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// Deterministically derive a coherent palette from the seed's rng. Design rules:
//   • Tower & background share one hue; background is darker (the lit tower is
//     brightened by the sun, so a darker raw sky reads as balanced in-render).
//   • Accent is the complementary hue (base+180°), high saturation/lightness —
//     a noticeable-contrast cap.
//   • Saturation spans a wide range across tokens for trait variety.
// Draw order is fixed so the same seed always yields the same palette.
export type SkinOptions = {
  brainSwap:     boolean;
  paletteMode:   PaletteMode;
  accentVariant: AccentVariant;
};

export function deriveSkin(rng: () => number, opts: SkinOptions): Skin {
  const { brainSwap, paletteMode, accentVariant } = opts;
  const family  = FAMILIES[Math.floor(rng() * FAMILIES.length)];
  const baseHue = family.hue + (rng() * 2 - 1) * 12; // jitter within the family

  // Brian's Brain (brainSwap): the dying state is everywhere, so swap the tower
  // and dying hues — the living tower takes the triadic (baseHue+120°) and pops,
  // while dying cells take the base hue and recede into the same-hue sky.
  const triadic  = (baseHue + 120) % 360;
  const towerHue = brainSwap ? triadic : baseHue;
  const dyingHue = brainSwap ? baseHue : triadic;

  // Squared draw biases toward the low end: most towers read as muted stone,
  // a minority reach into richer saturation.
  const towerSat = 0.1 + rng() ** 2 * 0.3; // ~0.12 base, long tail toward 0.55
  const towerL   = 0.50 + rng() * 0.12;

  const bgL   = clamp01(towerL - (0.20 + rng() * 0.08)); // same hue, darker
  const bgSat = clamp01(towerSat * 1.1);

  // ── Accent variant (independent of the palette mode — the one guaranteed pop)
  let accentHue: number, accentSat: number, accentL: number;
  let accentMode: 'solid' | 'prismatic' | 'metallic' | 'pulse' = 'solid';
  let flatAccent = false; // true → cap has no speckle (noiseColor === color)
  switch (accentVariant) {
    case 'White':
      accentHue = baseHue; accentSat = 0.05 + rng() * 0.05; accentL = 0.92 + rng() * 0.05;
      break;
    case 'Pulse':
      // Renderer breathes the cap lightness each frame; accentColor only carries
      // the base hue + saturation it pulses (greyscale on B&W tokens).
      accentMode = 'pulse';
      accentHue = baseHue; accentSat = paletteMode === 'bnw' ? 0 : 0.9; accentL = 0.6;
      break;
    case 'Dark':
      // Deep, desaturated base-hue cap — sinks below the tower tone.
      accentHue = baseHue; accentSat = 0.18 + rng() * 0.10; accentL = 0.12 + rng() * 0.06;
      break;
    case 'Complementary':
      accentHue = (baseHue + 180) % 360; accentSat = 0.70 + rng() * 0.2; accentL = 0.65 + rng() * 0.12;
      break;
    case 'Chrome':
      // Reflective neutral metal — the renderer gives the caps a PBR material
      // (metalness/roughness) + env map. accentColor is only the ghost/CSS tint.
      accentMode = 'metallic';
      accentHue = 210; accentSat = 0.03; accentL = 0.82;
      flatAccent = true;
      break;
    case 'Prismatic':
      // Renderer paints a per-cell rainbow; accentColor is only a neutral fallback.
      accentMode = 'prismatic';
      accentHue = baseHue; accentSat = 0.0; accentL = 0.85;
      break;
  }
  const accentColor      = hslToHex(accentHue, accentSat, accentL);
  const accentNoiseColor = flatAccent
    ? accentColor
    : hslToHex(accentHue, accentSat * 0.95, accentL - 0.1);

  // ── Palette mode. 'bnw' zeroes the scene saturation (accent stays the one pop).
  // 'textured' carries a per-cell HSL offset map the renderer applies to the body
  // cubes. 'prismatic' is painted entirely by the renderer (unsaturated rainbow
  // across the body), so the skin keeps colored values here.
  const mono  = paletteMode === 'bnw';
  const noisy = paletteMode === 'textured';
  const tSat  = mono ? 0 : towerSat;
  const bSat  = mono ? 0 : bgSat;

  let noiseMap: Float32Array | undefined;
  if (noisy) {
    noiseMap = new Float32Array(NOISE_DIM * NOISE_DIM);
    for (let i = 0; i < noiseMap.length; i++) noiseMap[i] = rng() * 2 - 1; // signed offset
  }

  return {
    id:   family.name.toLowerCase(),
    name: family.name,

    towerColor:      hslToHex(towerHue, tSat, towerL),
    towerNoiseColor: hslToHex(towerHue, tSat * 0.9, towerL - 0.10),

    accentColor,
    accentNoiseColor,

    // Tower & dying share saturation/lightness; only their hue differs (and
    // swaps for Brian's Brain — see towerHue/dyingHue above).
    dyingColor: hslToHex(dyingHue, tSat, towerL),

    // Ground always uses the base hue at the noise tone.
    groundColor: hslToHex(baseHue, tSat * 0.9, towerL - 0.10),

    backgroundColor: hslToHex(baseHue, bSat, bgL),
    gridColor:       hslToHex(accentHue, mono ? 0 : 0.40, 0.85),

    paletteMode,
    accentMode,
    noiseMap,
  };
}

export const FALLBACK_SKIN: Skin = {
  id:   'stone',
  name: 'Stone',

  accentColor:      'hsl(246, 77%, 59%)',
  accentNoiseColor: 'hsl(268, 80%, 61%)',

  towerColor:      'hsl(0, 0%, 41%)',
  towerNoiseColor: 'hsl(0, 0%, 27%)',

  dyingColor:      'hsl(140, 60%, 52%)',
  groundColor:     'hsl(0, 0%, 27%)',

  backgroundColor: 'hsl(0, 0%, 12%)',
  gridColor:       '#ffffff',

  paletteMode: 'colored',
  accentMode:  'solid',
};
