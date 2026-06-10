// Aesthetic configuration — all visual parameters derived from the fxHash seed.

export type CubePalette = {
  topFace:   string; // CSS color for the top face
  leftFace:  string; // left side (shadow)
  rightFace: string; // right side (highlight or secondary shadow)
  deadCell:  string; // reserved for future tileset logic
};

export type Skin = {
  id:             string;
  name:           string;
  // Full-brightness palette used for the newest (top) layer
  latestPalette:  CubePalette;
  // Darkened palette used for every older layer
  historyPalette: CubePalette;
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

  // Latest layer — bright warm limestone
  latestPalette: {
    topFace:   '#56e91c',
    leftFace:  '#242424',
    rightFace: '#686868',
    deadCell:  '#1a1a1a',
  },

  // History layers — dark, cold basalt
  historyPalette: {
    topFace:   '#9f9f9f',
    leftFace:  '#242424',
    rightFace: '#686868',
    deadCell:  '#1a1a1a',
  },

  tilesetPath:     '/assets/tilesets/stone/',
  gridColor:       'rgba(255,255,255,0.04)',
  backgroundColor: '#242424',
};
