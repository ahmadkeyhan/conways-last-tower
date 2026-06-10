import type { Grid, CellState } from './engine';
import type { Skin, CubePalette } from './skin';

// ── Public config ─────────────────────────────────────────────────────────────

export type RendererConfig = {
  canvas: HTMLCanvasElement;
  skin: Skin;
  tileWidth: number;
};

// ── Isometric projection ──────────────────────────────────────────────────────
//
// For a cube at grid position (col, row, z), with tile width `tw`:
//   • The top-face diamond is tw wide, tw/2 tall.
//   • Each side face is tw/2 wide, tw/2 tall (cube proportions).
//   • One Z level shifts the origin up by tw/2 (the side-face height).
//
//   screenX = (col - row) * tw/2
//   screenY = (col + row) * tw/4  −  z * tw/2
//
// The returned (x, y) is the top-center vertex of the cube's top face.
// Add (originX, originY) from the camera to get final canvas coords.

export function toIso(
  col: number, row: number, z: number, tw: number,
): { x: number; y: number } {
  return {
    x: (col - row) * (tw / 2),
    y: (col + row) * (tw / 4) - z * (tw / 2),
  };
}

// ── Cell cache ────────────────────────────────────────────────────────────────
//
// Sorted + face-culled cell lists are expensive to build (O(n log n) sort).
// Since Grid snapshots from History are immutable, we cache per Grid object
// using a WeakMap — built once on first render, free on all subsequent frames.
//
// Face culling:
//   • Left face  is hidden when the cell directly "behind-left" (row+1, col)
//     is alive — it fully covers the face from the camera's perspective.
//   • Right face is hidden when the cell "behind-right" (row, col+1) is alive.
//   • Top face is never culled within a layer.

type CachedCell = {
  r: number; c: number;
  state: CellState;
  depth: number;       // r + c — ascending = painter's order
  showLeft: boolean;
  showRight: boolean;
};

const cellCache = new WeakMap<Grid, CachedCell[]>();

function buildCells(layer: Grid): CachedCell[] {
  const { rows, cols, data } = layer;
  const cells: CachedCell[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const s = data[r * cols + c] as CellState;
      if (s === 0) continue;
      const belowRow = (r + 1) % rows;
      const rightCol = (c + 1) % cols;
      cells.push({
        r, c, state: s, depth: r + c,
        showLeft:  data[belowRow * cols + c]     !== 1,
        showRight: data[r        * cols + rightCol] !== 1,
      });
    }
  }
  cells.sort((a, b) => a.depth - b.depth);
  return cells;
}

function getCells(layer: Grid): CachedCell[] {
  let cells = cellCache.get(layer);
  if (!cells) { cells = buildCells(layer); cellCache.set(layer, cells); }
  return cells;
}

// ── Cube geometry ─────────────────────────────────────────────────────────────

type FaceColors = { top: string; left: string; right: string; outline: string | undefined };

function drawCube(
  ctx: CanvasRenderingContext2D,
  sx: number, sy: number, tw: number,
  colors: FaceColors,
  showLeft: boolean,
  showRight: boolean,
): void {
  const hw = tw / 2;
  const qw = tw / 4;
  const sh = tw / 2;

  const Tx = sx,       Ty = sy;
  const Rx = sx + hw,  Ry = sy + qw;
  const Mx = sx,       My = sy + hw;
  const Lx = sx - hw,  Ly = sy + qw;
  const BLx = sx - hw, BLy = sy + qw + sh;
  const BCx = sx,      BCy = sy + hw + sh;
  const BRx = sx + hw, BRy = sy + qw + sh;

  // top face — always drawn
  ctx.beginPath();
  ctx.moveTo(Tx, Ty); ctx.lineTo(Rx, Ry);
  ctx.lineTo(Mx, My); ctx.lineTo(Lx, Ly);
  ctx.closePath();
  ctx.fillStyle = colors.top;
  ctx.fill();
  if (colors.outline) {
    ctx.strokeStyle = colors.outline;
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }

  if (showLeft) {
    ctx.beginPath();
    ctx.moveTo(Lx, Ly);   ctx.lineTo(Mx, My);
    ctx.lineTo(BCx, BCy); ctx.lineTo(BLx, BLy);
    ctx.closePath();
    ctx.fillStyle = colors.left;
    ctx.fill();
    if (colors.outline) ctx.stroke();
  }

  if (showRight) {
    ctx.beginPath();
    ctx.moveTo(Mx, My);   ctx.lineTo(Rx, Ry);
    ctx.lineTo(BRx, BRy); ctx.lineTo(BCx, BCy);
    ctx.closePath();
    ctx.fillStyle = colors.right;
    ctx.fill();
    if (colors.outline) ctx.stroke();
  }
}

function faceColors(palette: CubePalette, state: CellState, outline: string | undefined): FaceColors {
  if (state === 2) {
    return { top: '#555', left: '#2e2e2e', right: '#3d3d3d', outline };
  }
  return { top: palette.topFace, left: palette.leftFace, right: palette.rightFace, outline };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  skin: Skin;
  tileW: number;

  constructor(config: RendererConfig) {
    this.canvas = config.canvas;
    this.ctx = config.canvas.getContext('2d')!;
    this.skin = config.skin;
    this.tileW = config.tileWidth;
  }

  private cameraOrigin(
    rows: number, cols: number, currentZ: number,
  ): { ox: number; oy: number } {
    const { canvas, tileW } = this;
    return {
      ox: canvas.width / 2 - ((cols - rows) * tileW) / 4,
      oy: canvas.height * 0.35 - ((cols + rows) * tileW) / 8 + currentZ * (tileW / 2),
    };
  }

  // `layers` is oldest-first; `currentZ` is the absolute Z of layers[last].
  render(layers: Grid[], currentZ: number): void {
    const { ctx, canvas, tileW, skin } = this;

    ctx.fillStyle = skin.backgroundColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (layers.length === 0) return;

    const rows = layers[0].rows;
    const cols = layers[0].cols;
    if (rows === 0 || cols === 0) return;

    const { ox, oy } = this.cameraOrigin(rows, cols, currentZ);
    const baseZ    = currentZ - layers.length + 1;
    const outline  = skin.gridColor;
    const cubeH    = tileW;
    const topLi    = layers.length - 1;

    for (let li = 0; li < layers.length; li++) {
      const z = baseZ + li;

      // Viewport cull
      const layerTopY = oy - z * (tileW / 2);
      const layerBotY = oy + (rows + cols - 2) * (tileW / 4) - z * (tileW / 2) + cubeH;
      if (layerBotY < 0 || layerTopY > canvas.height) continue;

      const palette = li === topLi ? skin.latestPalette : skin.historyPalette;
      const layer   = layers[li];
      const cells   = getCells(layer); // cached — O(1) on repeat frames

      for (const { r, c, state, showLeft, showRight } of cells) {
        const { x, y } = toIso(c, r, z, tileW);
        drawCube(ctx, ox + x, oy + y, tileW, faceColors(palette, state, outline), showLeft, showRight);
      }
    }

    if (skin.gridColor && tileW >= 8) {
      this.drawGridOverlay(rows, cols, currentZ, ox, oy);
    }
  }

  private drawGridOverlay(
    rows: number, cols: number, z: number,
    ox: number, oy: number,
  ): void {
    const { ctx, tileW, skin } = this;
    const hw = tileW / 2;
    const qw = tileW / 4;
    ctx.strokeStyle = skin.gridColor!;
    ctx.lineWidth = 0.5;
    const gz = z + 1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const { x, y } = toIso(c, r, gz, tileW);
        const sx = ox + x, sy = oy + y;
        ctx.beginPath();
        ctx.moveTo(sx,      sy);
        ctx.lineTo(sx + hw, sy + qw);
        ctx.lineTo(sx,      sy + hw);
        ctx.lineTo(sx - hw, sy + qw);
        ctx.closePath();
        ctx.stroke();
      }
    }
  }

  drawLayer(grid: Grid, z: number): void {
    const { rows, cols } = grid;
    const { ox, oy } = this.cameraOrigin(rows, cols, z);
    const { ctx, tileW, skin } = this;
    const outline = skin.gridColor;
    const cells   = getCells(grid);

    for (const { r, c, state, showLeft, showRight } of cells) {
      const { x, y } = toIso(c, r, z, tileW);
      drawCube(ctx, ox + x, oy + y, tileW, faceColors(skin.latestPalette, state, outline), showLeft, showRight);
    }
  }

  resize(width: number, height: number): void {
    this.canvas.width  = width;
    this.canvas.height = height;
  }
}
