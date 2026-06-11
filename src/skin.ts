// Aesthetic configuration — all visual parameters derived from the fxHash seed.

export type CubePalette = {
  topFace:   string;
  leftFace:  string;
  rightFace: string;
  deadCell:  string; // reserved for future tileset logic
};

export type Skin = {
  id:             string;
  name:           string;
  // Body palette — rendered once into the OffscreenCanvas cache for every layer
  historyPalette: CubePalette;
  // Accent — the bright cap diamond drawn live over the current (top) layer only
  accent:         string;
  tilesetPath:    string;
  gridColor?:     string;
  backgroundColor: string;
};

export function deriveSkin(_rng: () => number): Skin {
  // TODO: sample hue/saturation from rng, generate both palettes
  return FALLBACK_SKIN;
}

export const FALLBACK_SKIN: Skin = {
  id:   'stone',
  name: 'Stone',

  // Body — dark basalt, rendered once per layer into cache
  historyPalette: {
    topFace:   '#707070',
    leftFace:  '#242424',
    rightFace: '#494949',
    deadCell:  '#1a1a1a',
  },

  // Cap — bright accent drawn live every frame over the newest layer only
  accent: '#cf5ee6',

  tilesetPath:     '/assets/tilesets/stone/',
  gridColor:       'rgba(255,255,255,0.04)',
  backgroundColor: '#242424',
};
