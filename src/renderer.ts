import type { Grid, CellState } from './engine';
import type { Skin } from './skin';

// ── Public config ─────────────────────────────────────────────────────────────

export type RendererConfig = {
  canvas: HTMLCanvasElement;
  skin: Skin;
  tileWidth: number;
  rows: number;
  cols: number;
  historyDepth: number;
};

// ── Isometric projection ──────────────────────────────────────────────────────
//
//   screenX = (col - row) * tw/2
//   screenY = (col + row) * tw/4  −  z * tw/2
//
// (x, y) = top-center vertex of the cube's top-face diamond.

export function toIso(
  col: number, row: number, z: number, tw: number,
): { x: number; y: number } {
  return {
    x: (col - row) * (tw / 2),
    y: (col + row) * (tw / 4) - z * (tw / 2),
  };
}

// ── Cube drawing primitives ───────────────────────────────────────────────────

type BodyColors = { top: string; left: string; right: string; outline?: string };

// Both CanvasRenderingContext2D and OffscreenCanvasRenderingContext2D share the
// drawing API; this alias lets drawCubeBody / drawCubeTop accept either.
type AnyCtx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

// Three-face body — rendered once into the OffscreenCanvas cache per layer.
// showLeft / showRight come from face culling (hidden when a neighbor is alive).
function drawCubeBody(
  ctx: AnyCtx2D,
  sx: number, sy: number, tw: number,
  colors: BodyColors,
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

  // Top face (dark body colour — overwritten by cap on the live layer)
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

// Accent cap — top diamond only, drawn live every frame over the newest layer.
function drawCubeTop(
  ctx: AnyCtx2D,
  sx: number, sy: number, tw: number,
  accent: string,
): void {
  const hw = tw / 2;
  const qw = tw / 4;
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.moveTo(sx,      sy);
  ctx.lineTo(sx + hw, sy + qw);
  ctx.lineTo(sx,      sy + hw);
  ctx.lineTo(sx - hw, sy + qw);
  ctx.closePath();
  ctx.fill();
}

// ── Sorted cell list (painter's algorithm + face culling) ─────────────────────
//
// Built once per committed layer (inside commitLayer) and cached in
// `this.currentCells`. Re-used on every RAF frame for the cap pass —
// no sort or allocation at render time.

type SortedCell = {
  r: number; c: number;
  state: CellState;
  depth: number;
  showLeft: boolean;
  showRight: boolean;
};

function buildSortedCells(grid: Grid): SortedCell[] {
  const { rows, cols, data } = grid;
  const cells: SortedCell[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const state = data[r * cols + c] as CellState;
      if (state === 0) continue;
      const belowRow = (r + 1) % rows;
      const rightCol = (c + 1) % cols;
      cells.push({
        r, c, state, depth: r + c,
        showLeft:  data[belowRow * cols + c]       !== 1,
        showRight: data[r        * cols + rightCol] !== 1,
      });
    }
  }
  cells.sort((a, b) => a.depth - b.depth);
  return cells;
}

// ── Layout ────────────────────────────────────────────────────────────────────
//
// All OffscreenCanvas instances share identical dimensions determined by
// grid size and tile width. The blit positions on the main canvas change only
// on window resize, so they are precomputed here.
//
//  OffscreenCanvas coordinate system:
//    localOriginX = rows * tw/2   (shifts origin so the leftmost cell is at x=0)
//    localOriginY = 0             (top of the (0,0) diamond is the top edge)
//
//  Main canvas blit positions:
//    blit_x       = constant for all layers (horizontal centering)
//    blit_y_top   = y of the newest layer's OffscreenCanvas top-left
//    older layers = blit_y_top + (topLi - li) * tw/2   (each is tw/2 lower)

type Layout = {
  blit_x:       number;
  blit_y_top:   number;
  localOriginX: number;
  osWidth:      number;
  osHeight:     number;
};

function computeLayout(
  canvasW: number, canvasH: number,
  rows: number, cols: number, tileW: number,
): Layout {
  return {
    blit_x:       canvasW / 2 - (rows + cols) * tileW / 4,
    blit_y_top:   canvasH * 0.35 - (rows + cols) * tileW / 8,
    localOriginX: rows * tileW / 2,
    osWidth:      (rows + cols) * tileW / 2,
    osHeight:     (rows + cols + 2) * tileW / 4,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  skin: Skin;
  tileW: number;
  private rows: number;
  private cols: number;
  private historyDepth: number;

  // OffscreenCanvas per committed generation — body only, rendered once.
  private layerCache: OffscreenCanvas[] = [];

  // Sorted+culled cells for the current live generation.
  // Set inside commitLayer; re-used in render() so the cap pass allocates nothing.
  private currentCells: SortedCell[] | null = null;

  private layout: Layout;

  constructor(config: RendererConfig) {
    this.canvas       = config.canvas;
    this.ctx          = config.canvas.getContext('2d')!;
    this.skin         = config.skin;
    this.tileW        = config.tileWidth;
    this.rows         = config.rows;
    this.cols         = config.cols;
    this.historyDepth = config.historyDepth;
    this.layout = computeLayout(
      config.canvas.width, config.canvas.height,
      this.rows, this.cols, this.tileW,
    );
  }

  // ── commitLayer ─────────────────────────────────────────────────────────────
  // Call once per new generation (same cadence as history.push).
  // Renders the body into an OffscreenCanvas and stores it; also caches the
  // sorted cell list for the subsequent cap passes.

  commitLayer(grid: Grid): void {
    const { tileW, skin, layout } = this;
    const { osWidth, osHeight, localOriginX } = layout;
    const outline = skin.gridColor;

    const cells = buildSortedCells(grid);
    this.currentCells = cells;

    const os  = new OffscreenCanvas(Math.ceil(osWidth), Math.ceil(osHeight));
    const ctx = os.getContext('2d')!;

    for (const { r, c, state, showLeft, showRight } of cells) {
      const colors: BodyColors = state === 2
        ? { top: '#555', left: '#2e2e2e', right: '#3d3d3d', outline }
        : { top: skin.historyPalette.topFace, left: skin.historyPalette.leftFace, right: skin.historyPalette.rightFace, outline };
      const { x, y } = toIso(c, r, 0, tileW);
      drawCubeBody(ctx, localOriginX + x, y, tileW, colors, showLeft, showRight);
    }

    this.layerCache.push(os);
    if (this.layerCache.length > this.historyDepth) this.layerCache.shift();
  }

  // Rebuild the full cache from a layers array (for timeline scrubber replay).
  rebuildCache(layers: Grid[]): void {
    this.layerCache   = [];
    this.currentCells = null;
    for (const g of layers) this.commitLayer(g);
  }

  // ── render ──────────────────────────────────────────────────────────────────
  // Called every RAF frame.
  //
  // Pass 1 — blit all cached body OffscreenCanvases oldest → newest.
  //           Each layer is a single drawImage call. Historical layers cost
  //           nothing beyond a GPU texture blit.
  //
  // Pass 2 — draw the accent cap (top diamond only) for every alive cell in
  //           the current live generation, using the pre-built currentCells list.
  //           No sort, no allocation.

  render(): void {
    const { ctx, canvas, tileW, skin, layerCache, layout } = this;
    const { blit_x, blit_y_top, localOriginX, osHeight } = layout;

    ctx.fillStyle = skin.backgroundColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (layerCache.length === 0) return;

    const topLi = layerCache.length - 1;

    // Pass 1: blit bodies
    for (let li = 0; li <= topLi; li++) {
      const blit_y = blit_y_top + (topLi - li) * (tileW / 2);
      if (blit_y + osHeight < 0 || blit_y > canvas.height) continue;
      ctx.drawImage(layerCache[li], blit_x, blit_y);
    }

    // Pass 2: accent cap over the top layer
    const capOX = blit_x + localOriginX;
    const capOY = blit_y_top;
    const cells  = this.currentCells;
    if (cells) {
      for (const { r, c, state } of cells) {
        if (state !== 1) continue; // cap = alive cells only, not dying
        const { x, y } = toIso(c, r, 0, tileW);
        drawCubeTop(ctx, capOX + x, capOY + y, tileW, skin.accent);
      }
    }

    // Grid overlay (floats one cube-height above the caps)
    if (skin.gridColor && tileW >= 8) {
      this.drawGridOverlay(capOX, capOY);
    }
  }

  private drawGridOverlay(capOX: number, capOY: number): void {
    const { ctx, tileW, skin, rows, cols } = this;
    const hw = tileW / 2;
    const qw = tileW / 4;
    ctx.strokeStyle = skin.gridColor!;
    ctx.lineWidth = 0.5;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const { x, y } = toIso(c, r, 1, tileW); // z=1 → grid sits above the caps
        const sx = capOX + x, sy = capOY + y;
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

  // Single-layer draw onto the main canvas (used by stamp preview, scrubber, etc.)
  drawLayer(grid: Grid, _z: number): void {
    const { ctx, tileW, skin, layout } = this;
    const { blit_x, blit_y_top, localOriginX } = layout;
    const ox = blit_x + localOriginX;
    const oy = blit_y_top;
    const outline = skin.gridColor;

    for (const { r, c, state, showLeft, showRight } of buildSortedCells(grid)) {
      const colors: BodyColors = state === 2
        ? { top: '#555', left: '#2e2e2e', right: '#3d3d3d', outline }
        : { top: skin.historyPalette.topFace, left: skin.historyPalette.leftFace, right: skin.historyPalette.rightFace, outline };
      const { x, y } = toIso(c, r, 0, tileW);
      drawCubeBody(ctx, ox + x, oy + y, tileW, colors, showLeft, showRight);
    }
  }

  resize(width: number, height: number): void {
    this.canvas.width  = width;
    this.canvas.height = height;
    // OffscreenCanvas contents remain valid; only blit positions change.
    this.layout = computeLayout(width, height, this.rows, this.cols, this.tileW);
  }
}
