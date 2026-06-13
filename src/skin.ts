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

export function deriveSkin(_rng: () => number): Skin {
  // TODO: sample hue/saturation from rng, generate the palette
  return FALLBACK_SKIN;
}

export const FALLBACK_SKIN: Skin = {
  id:   'stone',
  name: 'Stone',

  towerColor:      '#ff8080',
  towerNoiseColor: '#d66f6f',

  accentColor:      '#ffffff',
  accentNoiseColor: '#c9c9c9',

  backgroundColor: '#8a4646',
  gridColor:       '#ffffff',
};
