// ── Types ─────────────────────────────────────────────────────────────────────

export type CellState = 0 | 1 | 2; // 0=dead  1=alive  2=dying (Brian's Brain)

// Read-only grid view — used by History snapshots and Renderer.
// Dense rows × cols layout: index = row * cols + col
export type Grid = {
  readonly rows: number;
  readonly cols: number;
  readonly data: Uint8Array;
};

// Invisible simulation margin around the visible grid (cells per side).
// Patterns walk off the viewport and keep evolving out of sight; they die at
// the true outer boundary ~MARGIN cells away, so no splash is ever visible
// at the viewport edge.
export const MARGIN = 20;

// Live simulation buffer — owns both front (data) and back arrays.
// step() writes into back and returns the pair swapped; no Uint8Array is
// allocated per generation once a GridBuffer exists.
//
// GHOST MARGIN: data/back are (rows + 2·MARGIN) × (cols + 2·MARGIN). The
// whole margin is simulated except its outermost 1-cell ring, which is
// permanently dead and never written — it gives boundary cells correct
// neighbor counts with zero special-casing (no torus wrap, no asymmetric
// edge counting). The visible/playable world is the centered rows × cols
// region; use setCell/getCell or innerSnapshot to access it.
//   internal index = (row + MARGIN) * (cols + 2·MARGIN) + (col + MARGIN)
export type GridBuffer = {
  readonly rows: number;
  readonly cols: number;
  readonly data: Uint8Array; // current generation (front), margin-padded
  readonly back: Uint8Array; // write scratch — do not read externally
};

// A Grid is either a dense snapshot or a margin-padded buffer; the data
// length tells them apart. All accessors below handle both layouts.
function isPadded(grid: Grid): boolean {
  return grid.data.length === (grid.rows + 2 * MARGIN) * (grid.cols + 2 * MARGIN);
}

function cellIndex(grid: Grid, row: number, col: number): number {
  return isPadded(grid)
    ? (row + MARGIN) * (grid.cols + 2 * MARGIN) + (col + MARGIN)
    : row * grid.cols + col;
}

// ── Rulesets ──────────────────────────────────────────────────────────────────

export type StandardRuleset = { kind: 'standard'; born: number[]; survive: number[] };
export type BrainRuleset    = { kind: 'brain' };
export type Ruleset         = StandardRuleset | BrainRuleset;

export const RULESETS = {
  classic:  { kind: 'standard' as const, born: [3],          survive: [2, 3] },
  highlife: { kind: 'standard' as const, born: [3, 6],       survive: [2, 3] },
  maze:     { kind: 'standard' as const, born: [3],          survive: [1, 2, 3, 4, 5] },
  daynight: { kind: 'standard' as const, born: [3, 6, 7, 8], survive: [3, 4, 6, 7, 8] },
  brain:    { kind: 'brain' as const },
} satisfies Record<string, Ruleset>;

export type RulesetName = keyof typeof RULESETS;

// ── Grid primitives ───────────────────────────────────────────────────────────

export function createGrid(rows: number, cols: number): GridBuffer {
  const size = (rows + 2 * MARGIN) * (cols + 2 * MARGIN); // margin-padded
  return {
    rows, cols,
    data: new Uint8Array(size),
    back: new Uint8Array(size),
  };
}

// Produces a new margin-padded GridBuffer from any Grid (dense snapshot or
// padded buffer) — copies the cell data, allocates a fresh back buffer.
// Dense sources start with an empty margin.
export function cloneGrid(grid: Grid): GridBuffer {
  const buf = createGrid(grid.rows, grid.cols);
  if (isPadded(grid)) {
    buf.data.set(grid.data);
  } else {
    const { rows, cols, data } = grid;
    const stride = cols + 2 * MARGIN;
    for (let r = 0; r < rows; r++) {
      buf.data.set(data.subarray(r * cols, (r + 1) * cols), (r + MARGIN) * stride + MARGIN);
    }
  }
  return buf;
}

// Dense rows × cols copy of the visible region — the layout History stores
// and the renderer consumes. Always returns a fresh copy.
export function innerSnapshot(grid: Grid): Grid {
  const { rows, cols } = grid;
  if (!isPadded(grid)) return { rows, cols, data: grid.data.slice() };
  const out = new Uint8Array(rows * cols);
  const stride = cols + 2 * MARGIN;
  for (let r = 0; r < rows; r++) {
    const base = (r + MARGIN) * stride + MARGIN;
    out.set(grid.data.subarray(base, base + cols), r * cols);
  }
  return { rows, cols, data: out };
}

export function setCell(grid: Grid, row: number, col: number, state: CellState): void {
  grid.data[cellIndex(grid, row, col)] = state;
}

export function getCell(grid: Grid, row: number, col: number): CellState {
  return grid.data[cellIndex(grid, row, col)] as CellState;
}

// Returns a new GridBuffer with the visible region randomized; does not
// mutate the source. The margin starts empty (dead).
export function randomizeGrid(grid: Grid, density = 0.3, rng = Math.random): GridBuffer {
  const buf = createGrid(grid.rows, grid.cols);
  const stride = grid.cols + 2 * MARGIN;
  for (let r = 0; r < grid.rows; r++) {
    const base = (r + MARGIN) * stride + MARGIN;
    for (let c = 0; c < grid.cols; c++) {
      buf.data[base + c] = rng() < density ? 1 : 0;
    }
  }
  return buf;
}

// ── Neighbor counting (exported utility; NOT inlined inside step) ─────────────

export function countAliveNeighbors(grid: Grid, row: number, col: number): number {
  const { rows, cols, data } = grid;
  if (isPadded(grid)) {
    // Neighbor reads fall into the simulated margin naturally for edge cells
    const stride = cols + 2 * MARGIN;
    const i = (row + MARGIN) * stride + (col + MARGIN);
    return (data[i - stride - 1] & 1) + (data[i - stride] & 1) + (data[i - stride + 1] & 1)
         + (data[i - 1] & 1)                                   + (data[i + 1] & 1)
         + (data[i + stride - 1] & 1) + (data[i + stride] & 1) + (data[i + stride + 1] & 1);
  }
  // Dense snapshot: skip out-of-bounds neighbors (bounded plane)
  let n = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = row + dr;
      const nc = col + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      if (data[nr * cols + nc] === 1) n++;
    }
  }
  return n;
}

// Counts the whole buffer: for padded grids this includes live cells in the
// invisible margin (alive anywhere in the simulated world), for dense
// snapshots just the visible region.
export function countAlive(grid: Grid): number {
  let n = 0;
  const { data } = grid;
  for (let i = 0; i < data.length; i++) if (data[i] === 1) n++;
  return n;
}

// ── Step ──────────────────────────────────────────────────────────────────────
//
// Writes the next generation into buf.back, then returns the buffer pair
// with data/back swapped — zero Uint8Array allocations per call.
//
// Inner-loop optimisations:
//   • Ghost margin: the simulated region is everything except the outermost
//     1-cell ring of the padded buffer, which is permanently dead and never
//     written — every neighbor read lands on a simulated cell or that dead
//     ring, so there are no wrap ternaries, bounds checks, or edge special
//     cases anywhere in the loop. Patterns evolve up to MARGIN−1 cells past
//     the viewport before dying at the true boundary, out of sight.
//   • Uint8Array[9] born/survive lookup tables replace Array.includes (O(1)
//     typed-array load vs. O(k) linear scan on every cell).
//   • Standard-ruleset neighbor sum is a direct data[offset] addition —
//     valid because standard rulesets only produce states 0 and 1.
//   • Brian's Brain uses `& 1` to mask dying cells (state 2) from the count.
//
// The outer ring of `back` is never written, so it stays dead across swaps.

export function step(buf: GridBuffer, ruleset: Ruleset): GridBuffer {
  const { rows, cols } = buf;
  const stride   = cols + 2 * MARGIN;     // padded row width
  const simRows  = rows + 2 * MARGIN - 2; // simulated region: all but the outer ring
  const simCols  = cols + 2 * MARGIN - 2;
  const read  = buf.data;
  const write = buf.back;

  if (ruleset.kind === 'brain') {
    for (let r = 0; r < simRows; r++) {
      const base = (r + 1) * stride + 1; // +1: skip the dead outer ring

      for (let c = 0; c < simCols; c++) {
        const i = base + c;
        const state = read[i];
        if (state === 1) { write[i] = 2; continue; }
        if (state === 2) { write[i] = 0; continue; }

        const n = (read[i - stride - 1] & 1) + (read[i - stride] & 1) + (read[i - stride + 1] & 1)
                + (read[i - 1] & 1)                                   + (read[i + 1] & 1)
                + (read[i + stride - 1] & 1) + (read[i + stride] & 1) + (read[i + stride + 1] & 1);
        write[i] = n === 2 ? 1 : 0;
      }
    }
  } else {
    const bornSet    = new Uint8Array(9);
    const surviveSet = new Uint8Array(9);
    for (const b of ruleset.born)    bornSet[b]    = 1;
    for (const s of ruleset.survive) surviveSet[s] = 1;

    for (let r = 0; r < simRows; r++) {
      const base = (r + 1) * stride + 1; // +1: skip the dead outer ring

      for (let c = 0; c < simCols; c++) {
        const i = base + c;

        const n = read[i - stride - 1] + read[i - stride] + read[i - stride + 1]
                + read[i - 1]                             + read[i + 1]
                + read[i + stride - 1] + read[i + stride] + read[i + stride + 1];

        write[i] = read[i] === 1 ? surviveSet[n] : bornSet[n];
      }
    }
  }

  // Swap — one cheap object literal, no Uint8Array allocation
  return { rows, cols, data: write, back: read };
}

// ── History ───────────────────────────────────────────────────────────────────
//
// Stores lightweight Grid snapshots: data.slice() copies only, no back buffer.
// push() accepts any Grid (GridBuffer satisfies Grid structurally).

export class History {
  private stack: Grid[] = [];
  private _total = 0;
  readonly maxDepth: number;

  constructor(maxDepth: number) { this.maxDepth = maxDepth; }

  push(buf: Grid): void {
    // innerSnapshot de-pads ghost-bordered buffers and copies dense ones —
    // the stack always holds dense rows × cols snapshots.
    this.stack.push(innerSnapshot(buf));
    this._total++;
    if (this.stack.length > this.maxDepth) this.stack.shift();
  }

  get(index: number): Grid | undefined { return this.stack[index]; }
  peek(): Grid | undefined              { return this.stack[this.stack.length - 1]; }

  trimTo(stackIndex: number): void {
    const removed = this.stack.length - stackIndex - 1;
    if (removed <= 0) return;
    this.stack = this.stack.slice(0, stackIndex + 1);
    this._total -= removed;
  }

  toArray(): Grid[] { return this.stack.slice(); }

  get length():           number { return this.stack.length; }
  get totalGenerations(): number { return this._total; }
  get oldestGeneration(): number { return this._total - this.stack.length; }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

export function printGrid(grid: Grid): string {
  const { rows, cols, data } = grid;
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      const s = data[cellIndex(grid, r, c)];
      line += s === 0 ? '.' : s === 1 ? '#' : 'o';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

function dataEquals(a: Grid, b: Grid, snap?: Uint8Array): boolean {
  const ref = snap ?? b.data;
  if (a.data.length !== ref.length) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== ref[i]) return false;
  return true;
}

// ── Console verification + benchmark ─────────────────────────────────────────

export function runEngineTest(): void {
  function alive(g: GridBuffer, ...coords: [number, number][]): void {
    for (const [r, c] of coords) setCell(g, r, c, 1);
  }

  console.group("Conway's Last Tower — Engine Test");

  // ── 1. Blinker period-2 ───────────────────────────────────────────────────
  // Snapshot gen0 before stepping — the double-buffer swap overwrites g0.data
  // after two steps, so we compare gen2 against the captured snapshot.
  console.group('1. Blinker (Classic B3/S23) — period-2');
  const g0 = createGrid(5, 5);
  alive(g0, [2,1],[2,2],[2,3]);
  const gen0snap = g0.data.slice();
  console.log('Gen 0 (horizontal):\n' + printGrid(g0));
  const g1 = step(g0, RULESETS.classic);
  console.log('Gen 1 (vertical):\n'   + printGrid(g1));
  const g2 = step(g1, RULESETS.classic);
  console.log('Gen 2 (horizontal):\n' + printGrid(g2));
  console.log('Period-2 ✓:', dataEquals(g2, g2, gen0snap) ? 'PASS' : 'FAIL');
  console.groupEnd();

  // ── 2. Block still life ───────────────────────────────────────────────────
  console.group('2. Block — still life');
  const block = createGrid(4, 4);
  alive(block, [1,1],[1,2],[2,1],[2,2]);
  const blockSnap = block.data.slice();
  const blockNext = step(block, RULESETS.classic);
  console.log('Still life ✓:', dataEquals(blockNext, blockNext, blockSnap) ? 'PASS' : 'FAIL');
  console.groupEnd();

  // ── 3. Glider alive-count ─────────────────────────────────────────────────
  console.group('3. Glider — 5 alive cells over 8 steps');
  let gl = createGrid(12, 12);
  alive(gl, [1,2],[2,3],[3,1],[3,2],[3,3]);
  let gliderOk = true;
  for (let i = 0; i < 8; i++) {
    gl = step(gl, RULESETS.classic);
    if (countAlive(gl) !== 5) { gliderOk = false; break; }
  }
  console.log('8-step alive-count ✓:', gliderOk ? 'PASS' : 'FAIL');
  console.groupEnd();

  // ── 4. Brian's Brain state cycle ─────────────────────────────────────────
  console.group("4. Brian's Brain — 1→2→0 cycle");
  const brain = createGrid(5, 5);
  alive(brain, [2,1],[2,3]);
  const br1 = step(brain, RULESETS.brain);
  console.log('Alive→dying ✓:',        (getCell(br1,2,1) === 2 && getCell(br1,2,3) === 2) ? 'PASS' : 'FAIL');
  console.log('Dead(2 nbrs)→alive ✓:', getCell(br1,2,2) === 1 ? 'PASS' : 'FAIL');
  const br2 = step(br1, RULESETS.brain);
  console.log('Dying→dead ✓:',         (getCell(br2,2,1) === 0 && getCell(br2,2,3) === 0) ? 'PASS' : 'FAIL');
  console.groupEnd();

  // ── 5. History stack ──────────────────────────────────────────────────────
  console.group('5. History — push / trimTo / accounting');
  const hist = new History(5);
  let cur = createGrid(3, 3);
  setCell(cur, 0, 0, 1);
  for (let i = 0; i < 8; i++) { hist.push(cur); cur = step(cur, RULESETS.classic); }
  console.log('capped at 5:',        hist.length === 5           ? 'PASS' : `FAIL (${hist.length})`);
  console.log('totalGenerations=8:', hist.totalGenerations === 8 ? 'PASS' : `FAIL (${hist.totalGenerations})`);
  console.log('oldestGeneration=3:', hist.oldestGeneration === 3 ? 'PASS' : `FAIL (${hist.oldestGeneration})`);
  hist.trimTo(2);
  console.log('trimTo(2)→length 3:', hist.length === 3           ? 'PASS' : `FAIL (${hist.length})`);
  console.log('total after trim=6:', hist.totalGenerations === 6 ? 'PASS' : `FAIL (${hist.totalGenerations})`);
  console.groupEnd();

  // ── 6. Ghost margin — no wrap, off-screen evolution ───────────────────────
  console.group('6. Ghost margin — no wrap, off-screen evolution');
  // (0,0), (0,7) and (7,0) are mutual neighbors on a torus (each would have
  // 2 and survive); with the margin they are isolated and die.
  const gb = createGrid(8, 8);
  alive(gb, [0,0],[0,7],[7,0]);
  const gb1 = step(gb, RULESETS.classic);
  console.log('no torus wrap (corners die) ✓:', countAlive(gb1) === 0 ? 'PASS' : 'FAIL');

  // A blinker on the top visible edge oscillates one cell into the invisible
  // margin and back — the old 1-cell dead border would have mangled it.
  let bl = createGrid(8, 8);
  alive(bl, [0,3],[0,4],[0,5]);
  bl = step(bl, RULESETS.classic);
  const worldAlive = countAlive(bl);                 // includes margin
  const visAlive   = countAlive(innerSnapshot(bl));  // visible only
  console.log('cell lives off-screen ✓:', (worldAlive === 3 && visAlive === 2) ? 'PASS' : 'FAIL');
  bl = step(bl, RULESETS.classic);
  console.log('returns on-screen ✓:', countAlive(innerSnapshot(bl)) === 3 ? 'PASS' : 'FAIL');

  // The outermost ring of the padded buffer must stay dead after stepping
  let ringClean = true;
  const gbStride = 8 + 2 * MARGIN;
  for (let i = 0; i < gb1.data.length; i++) {
    const r = Math.floor(i / gbStride);
    const c = i % gbStride;
    const onRing = r === 0 || r === gbStride - 1 || c === 0 || c === gbStride - 1;
    if (onRing && gb1.data[i] !== 0) { ringClean = false; break; }
  }
  console.log('outer ring clean ✓:', ringClean ? 'PASS' : 'FAIL');
  console.groupEnd();

  // ── 7. Benchmark ─────────────────────────────────────────────────────────
  console.group('7. Benchmark — 100 gens on 100×100 (Classic)');
  // Seeded LCG so the benchmark is reproducible without the fxhash shim
  let seed = 0xdeadbeef;
  const lcg = (): number => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  let bench = randomizeGrid(createGrid(100, 100), 0.35, lcg);
  console.time('step ×100');
  for (let i = 0; i < 100; i++) bench = step(bench, RULESETS.classic);
  console.timeEnd('step ×100');
  console.groupEnd();

  console.groupEnd();
}
