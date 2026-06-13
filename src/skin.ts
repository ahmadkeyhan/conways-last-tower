// Aesthetic configuration — all visual parameters derived from the fxHash seed.

export type Skin = {
  id:   string;
  name: string;
  // Tower cubes (history + live body): main color with a random splash of
  // the noise color baked into a chunky pixel texture (see makeNoiseTexture
  // in renderer.ts) — Minecraft-block look instead of flat monocolor.
  towerColor:      string;
  towerNoiseColor: string;
  // Live-layer cap planes: same noise treatment with the accent pair.
  accentColor:      string;
  accentNoiseColor: string;
  backgroundColor: string;
  gridColor:       string; // edit-mode grid lines (opacity applied in renderer)
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
export function deriveSkin(rng: () => number): Skin {
  const family  = FAMILIES[Math.floor(rng() * FAMILIES.length)];
  const baseHue = family.hue + (rng() * 2 - 1) * 12; // jitter within the family

  // Squared draw biases toward the low end: most towers read as muted stone,
  // a minority reach into richer saturation.
  const towerSat = 0.1 + rng() ** 2 * 0.3; // ~0.12 base, long tail toward 0.55
  const towerL   = 0.50 + rng() * 0.12;

  const bgL   = clamp01(towerL - (0.20 + rng() * 0.08)); // same hue, darker
  const bgSat = clamp01(towerSat * 1.1);

  // Accent is one of two distinct looks (no muddy middle): either almost white
  // or the saturated complementary color.
  const accentHue   = (baseHue + 180) % 360; // complementary
  const whiteAccent = rng() < 0.5;
  const accentSat   = whiteAccent ? 0.05 + rng() * 0.05 : 0.70 + rng() * 0.2;
  const accentL     = whiteAccent ? 0.92 + rng() * 0.05 : 0.65 + rng() * 0.12;

  return {
    id:   family.name.toLowerCase(),
    name: family.name,

    towerColor:      hslToHex(baseHue, towerSat, towerL),
    towerNoiseColor: hslToHex(baseHue, towerSat * 0.9, towerL - 0.10),

    accentColor:      hslToHex(accentHue, accentSat, accentL),
    accentNoiseColor: hslToHex(accentHue, accentSat * 0.95, accentL - 0.1),

    backgroundColor: hslToHex(baseHue, bgSat, bgL),
    gridColor:       hslToHex(accentHue, 0.40, 0.85),
  };
}

export const FALLBACK_SKIN: Skin = {
  id:   'stone',
  name: 'Stone',

  accentColor:      'hsl(246, 77%, 59%)',
  accentNoiseColor: 'hsl(268, 80%, 61%)',

  towerColor:      'hsl(0, 0%, 41%)',
  towerNoiseColor: 'hsl(0, 0%, 27%)',

  backgroundColor: 'hsl(0, 0%, 12%)',
  gridColor:       '#ffffff',
};
