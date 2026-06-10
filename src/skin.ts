// Aesthetic configuration — stub
// All visual parameters are derived deterministically from the fxHash seed.

export type CubePalette = {
  topFace: string;   // CSS color for the top face of a cube
  leftFace: string;  // left face (shadow)
  rightFace: string; // right face (shadow, opposite side)
  deadCell: string;  // empty cell / background tint
};

export type Skin = {
  id: string;
  name: string;
  palette: CubePalette;
  // Path prefix for pre-rendered tileset sprites, e.g. '/assets/tilesets/stone/'
  tilesetPath: string;
  // Grid line color; undefined = no grid lines
  gridColor?: string;
  // Background canvas color
  backgroundColor: string;
};

// Derive a Skin from a seeded random function (provided by fxhash.ts)
export function deriveSkin(rng: () => number): Skin {
  void rng;
  // TODO: sample hue, saturation, lightness; pick tileset variant; generate palette
  return FALLBACK_SKIN;
}

export const FALLBACK_SKIN: Skin = {
  id: 'stone',
  name: 'Stone',
  palette: {
    topFace:   '#c8c0b8',
    leftFace:  '#807870',
    rightFace: '#a09890',
    deadCell:  '#1a1a1a',
  },
  tilesetPath: '/assets/tilesets/stone/',
  gridColor: 'rgba(255,255,255,0.04)',
  backgroundColor: '#111111',
};
