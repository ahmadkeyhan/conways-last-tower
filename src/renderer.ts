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

// ── Cube geometry ─────────────────────────────────────────────────────────────

type FaceColors = { top: string; left: string; right: string; outline: string | undefined };

function drawCube(
  ctx: CanvasRenderingContext2D,
  sx: number, sy: number, tw: number,
  colors: FaceColors,
): void {
  const hw = tw / 2;   // half width
  const qw = tw / 4;   // quarter width (= diamond half-height)
  const sh = tw / 2;   // side-face height (equals diamond height for a cube)

  // 7 key vertices
  const Tx = sx,       Ty = sy;             // top of diamond
  const Rx = sx + hw,  Ry = sy + qw;        // right of diamond
  const Mx = sx,       My = sy + hw;        // center-bottom of diamond
  const Lx = sx - hw,  Ly = sy + qw;        // left of diamond
  const BLx = sx - hw, BLy = sy + qw + sh;  // bottom-left
  const BCx = sx,      BCy = sy + hw + sh;  // bottom-center
  const BRx = sx + hw, BRy = sy + qw + sh;  // bottom-right

  // top face (diamond)
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

  // left face
  ctx.beginPath();
  ctx.moveTo(Lx, Ly);   ctx.lineTo(Mx, My);
  ctx.lineTo(BCx, BCy); ctx.lineTo(BLx, BLy);
  ctx.closePath();
  ctx.fillStyle = colors.left;
  ctx.fill();
  if (colors.outline) ctx.stroke();

  // right face
  ctx.beginPath();
  ctx.moveTo(Mx, My);   ctx.lineTo(Rx, Ry);
  ctx.lineTo(BRx, BRy); ctx.lineTo(BCx, BCy);
  ctx.closePath();
  ctx.fillStyle = colors.right;
  ctx.fill();
  if (colors.outline) ctx.stroke();
}

function faceColors(palette: CubePalette, state: CellState, outline: string | undefined): FaceColors {
  if (state === 2) {
    // Brian's Brain dying cells — subdued grey so they read as "fading"
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

  // Camera origin so the center of `currentZ` layer sits at 35% of screen height.
  //
  // Derivation: the center cell of layer currentZ at (col=cols/2, row=rows/2) maps to:
  //   screen_y = oy + (cols+rows)/2 * tw/4 - currentZ * tw/2
  // Setting that equal to canvas.height * 0.35 and solving for oy gives:
  //   oy = canvas.height * 0.35 - (cols+rows) * tw/8 + currentZ * tw/2
  private cameraOrigin(
    rows: number, cols: number, currentZ: number,
  ): { ox: number; oy: number } {
    const { canvas, tileW } = this;
    return {
      ox: canvas.width / 2 - ((cols - rows) * tileW) / 4,
      oy: canvas.height * 0.35 - ((cols + rows) * tileW) / 8 + currentZ * (tileW / 2),
    };
  }

  // Render the full tower. `layers` is oldest-first; `currentZ` is the
  // absolute Z index of layers[layers.length - 1].
  render(layers: Grid[], currentZ: number): void {
    const { ctx, canvas, tileW, skin } = this;

    ctx.fillStyle = skin.backgroundColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (layers.length === 0) return;

    const rows = layers[0].length;
    const cols = layers[0][0]?.length ?? 0;
    if (rows === 0 || cols === 0) return;

    const { ox, oy } = this.cameraOrigin(rows, cols, currentZ);
    const baseZ = currentZ - layers.length + 1;
    const outline = skin.gridColor;

    // Compute layer screen bounds for culling
    // Top of layer z (highest screen point) = cell (0,0,z) → oy + toIso(0,0,z).y
    // Bottom of layer z (lowest) = bottom-face of cell (rows-1,cols-1,z) → + tw (cube height)
    const cubeH = tileW; // total cube visual height = tw/2 (diamond) + tw/2 (sides)

    const topLi = layers.length - 1; // index of the newest layer

    for (let li = 0; li < layers.length; li++) {
      const z = baseZ + li;

      // Cull layers fully outside the viewport
      const layerTopY  = oy - z * (tileW / 2);
      const layerBotY  = oy + (rows + cols - 2) * (tileW / 4) - z * (tileW / 2) + cubeH;
      if (layerBotY < 0 || layerTopY > canvas.height) continue;

      const palette = li === topLi ? skin.latestPalette : skin.historyPalette;
      const layer   = layers[li];

      // Collect non-dead cells; sort ascending by (row+col) for painter's algorithm
      const cells: Array<{ r: number; c: number; state: CellState; depth: number }> = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const s = layer[r][c];
          if (s !== 0) cells.push({ r, c, state: s, depth: r + c });
        }
      }
      cells.sort((a, b) => a.depth - b.depth);

      for (const { r, c, state } of cells) {
        const { x, y } = toIso(c, r, z, tileW);
        drawCube(ctx, ox + x, oy + y, tileW, faceColors(palette, state, outline));
      }
    }

    // Subtle grid diamonds for the top layer (only when tileW is large enough to see)
    if (skin.gridColor && tileW >= 8) {
      this.drawGridOverlay(rows, cols, currentZ, ox, oy);
    }
  }

  // Draws the diamond outlines of each cell at layer z (floor plane reference)
  private drawGridOverlay(
    rows: number, cols: number, z: number,
    ox: number, oy: number,
  ): void {
    const { ctx, tileW, skin } = this;
    const hw = tileW / 2;
    const qw = tileW / 4;
    ctx.strokeStyle = skin.gridColor!;
    ctx.lineWidth = 0.5;
    // Draw at z+1 so the grid sits on top of the top layer's cubes
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
    const rows = grid.length;
    const cols = grid[0]?.length ?? 0;
    const { ox, oy } = this.cameraOrigin(rows, cols, z);
    const { ctx, tileW, skin } = this;
    const outline = skin.gridColor;

    const cells: Array<{ r: number; c: number; state: CellState; depth: number }> = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const s = grid[r][c];
        if (s !== 0) cells.push({ r, c, state: s, depth: r + c });
      }
    }
    cells.sort((a, b) => a.depth - b.depth);

    for (const { r, c, state } of cells) {
      const { x, y } = toIso(c, r, z, tileW);
      drawCube(ctx, ox + x, oy + y, tileW, faceColors(skin.latestPalette, state, outline));
    }
  }

  resize(width: number, height: number): void {
    this.canvas.width  = width;
    this.canvas.height = height;
  }
}
