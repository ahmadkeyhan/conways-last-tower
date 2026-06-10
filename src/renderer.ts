// Isometric canvas renderer — stub
// Receives a History stack and draws the voxel tower layer by layer.
// Each generation is a layer at Z = its generation index.

import type { Grid } from './engine';
import type { Skin } from './skin';

export type RendererConfig = {
  canvas: HTMLCanvasElement;
  skin: Skin;
  tileWidth: number;  // isometric tile width in px
  tileHeight: number; // isometric tile height in px
};

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private config: RendererConfig;

  constructor(config: RendererConfig) {
    this.config = config;
    this.ctx = config.canvas.getContext('2d')!;
  }

  // Draw a single layer (Z = generation index) from a grid snapshot
  drawLayer(_grid: Grid, _z: number): void {
    // TODO: tileset stamper — look up sprite by neighbor mask, stamp at iso coords
  }

  // Draw the full visible tower (all layers in history up to currentZ)
  drawTower(_layers: Grid[], _currentZ: number): void {
    // TODO: clear, then drawLayer for each layer bottom → top
  }

  resize(width: number, height: number): void {
    this.config.canvas.width  = width;
    this.config.canvas.height = height;
  }
}

// Isometric projection helpers
export function toIso(col: number, row: number, z: number, tw: number, th: number) {
  return {
    x: ((col - row) * tw) / 2,
    y: ((col + row) * th) / 4 - z * (th / 2),
  };
}
