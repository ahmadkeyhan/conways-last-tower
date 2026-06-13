// ── Types ─────────────────────────────────────────────────────────────────────

export type CellState = 0 | 1 | 2; // 0=dead  1=alive  2=dying (Brian's Brain)

// Read-only grid view — used by History snapshots and Renderer.
// Dense rows × cols layout: index = row * cols + col
export type Grid = {
  readonly rows: number;
  readonly cols: number;
  readonly data: Uint8Array;
};

// Live simulation buffer — owns both front (data) and back arrays.
// step() writes into back and returns the pair swapped; no Uint8Array is
// allocated per generation once a GridBuffer exists.
//
// TORUS TOPOLOGY: the world wraps at every edge — a cell leaving the right
// side reappears on the left, top wraps to bottom, and so on. data/back are
// plain rows × cols arrays (index = row * cols + col); there is no margin.
export type GridBuffer = {
  readonly rows: number;
  readonly cols: number;
  readonly data: Uint8Array; // current generation (front)
  readonly back: Uint8Array; // write scratch — do not read externally
};

function cellIndex(grid: Grid, row: number, col: number): number {
  return row * grid.cols + col;
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

// Initial-soup density sweet-spots per ruleset: the live-cell fraction that gives
// sustained, evolving activity rather than instant death or near-instant stasis.
// Sampled as a [min,max] range so each token's opening differs. Tuned by eye.
export const SEED_DENSITY: Record<RulesetName, readonly [number, number]> = {
  classic:  [0.30, 0.38], // standard soup — long-lived dynamics before settling
  highlife: [0.30, 0.38], // like classic plus replicators
  maze:     [0.03, 0.07], // permissive survival saturates fast — keep it sparse (~0.05)
  daynight: [0.42, 0.50], // self-complementary; needs density near 0.5 or it collapses
  brain:    [0.04, 0.10], // explosive/spreading — sparse seed gives room, high burns out
};

export function pickSeedDensity(name: RulesetName, rng: () => number = Math.random): number {
  const [lo, hi] = SEED_DENSITY[name];
  return lo + rng() * (hi - lo);
}

// ── Grid primitives ───────────────────────────────────────────────────────────

export function createGrid(rows: number, cols: number): GridBuffer {
  const size = rows * cols;
  return {
    rows, cols,
    data: new Uint8Array(size),
    back: new Uint8Array(size),
  };
}

// Produces a new GridBuffer from any Grid — copies the cell data, allocates a
// fresh back buffer.
export function cloneGrid(grid: Grid): GridBuffer {
  const buf = createGrid(grid.rows, grid.cols);
  buf.data.set(grid.data);
  return buf;
}

// Dense rows × cols copy — the layout History stores and the renderer
// consumes. Always returns a fresh copy.
export function innerSnapshot(grid: Grid): Grid {
  return { rows: grid.rows, cols: grid.cols, data: grid.data.slice() };
}

export function setCell(grid: Grid, row: number, col: number, state: CellState): void {
  grid.data[cellIndex(grid, row, col)] = state;
}

export function getCell(grid: Grid, row: number, col: number): CellState {
  return grid.data[cellIndex(grid, row, col)] as CellState;
}

// Returns a new GridBuffer with the cells randomized; does not mutate the source.
export function randomizeGrid(grid: Grid, density = 0.3, rng = Math.random): GridBuffer {
  const buf = createGrid(grid.rows, grid.cols);
  for (let i = 0; i < buf.data.length; i++) {
    buf.data[i] = rng() < density ? 1 : 0;
  }
  return buf;
}

// ── Neighbor counting (exported utility; NOT inlined inside step) ─────────────

export function countAliveNeighbors(grid: Grid, row: number, col: number): number {
  const { rows, cols, data } = grid;
  let n = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = (row + dr + rows) % rows; // torus wrap
      const nc = (col + dc + cols) % cols;
      if (data[nr * cols + nc] === 1) n++;
    }
  }
  return n;
}

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
// TORUS TOPOLOGY: neighbor reads wrap at every edge. Row offsets are computed
// once per row (top/bottom wrap) and column wrap is handled per cell at the
// two horizontal extremes; interior cells use the fast contiguous offsets.
//
// Inner-loop optimisations:
//   • Uint8Array[9] born/survive lookup tables replace Array.includes (O(1)
//     typed-array load vs. O(k) linear scan on every cell).
//   • Standard-ruleset neighbor sum is a direct data[offset] addition —
//     valid because standard rulesets only produce states 0 and 1.
//   • Brian's Brain uses `& 1` to mask dying cells (state 2) from the count.

export function step(buf: GridBuffer, ruleset: Ruleset): GridBuffer {
  const { rows, cols } = buf;
  const read  = buf.data;
  const write = buf.back;

  const isBrain      = ruleset.kind === 'brain';
  const bornSet      = new Uint8Array(9);
  const surviveSet   = new Uint8Array(9);
  if (!isBrain) {
    for (const b of (ruleset as StandardRuleset).born)    bornSet[b]    = 1;
    for (const s of (ruleset as StandardRuleset).survive) surviveSet[s] = 1;
  }

  for (let r = 0; r < rows; r++) {
    const up   = (r === 0 ? rows - 1 : r - 1) * cols; // torus wrap rows
    const mid  = r * cols;
    const down = (r === rows - 1 ? 0 : r + 1) * cols;

    for (let c = 0; c < cols; c++) {
      const cl = c === 0        ? cols - 1 : c - 1; // torus wrap cols
      const cr = c === cols - 1 ? 0        : c + 1;
      const i  = mid + c;

      if (isBrain) {
        const state = read[i];
        if (state === 1) { write[i] = 2; continue; }
        if (state === 2) { write[i] = 0; continue; }
        const n = (read[up + cl] & 1) + (read[up + c] & 1) + (read[up + cr] & 1)
                + (read[mid + cl] & 1)                      + (read[mid + cr] & 1)
                + (read[down + cl] & 1) + (read[down + c] & 1) + (read[down + cr] & 1);
        write[i] = n === 2 ? 1 : 0;
      } else {
        const n = read[up + cl] + read[up + c] + read[up + cr]
                + read[mid + cl]               + read[mid + cr]
                + read[down + cl] + read[down + c] + read[down + cr];
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
    // innerSnapshot copies the cell data — the stack always holds independent
    // dense rows × cols snapshots.
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

  // ── 6. Torus wrap ─────────────────────────────────────────────────────────
  console.group('6. Torus wrap — edges connect');
  // (0,0), (0,7) and (7,0) are mutual neighbors on a torus: each has exactly
  // 2 alive neighbors and survives.
  const gb = createGrid(8, 8);
  alive(gb, [0,0],[0,7],[7,0]);
  const gb1 = step(gb, RULESETS.classic);
  console.log('corners survive (wrap) ✓:', countAlive(gb1) === 3 ? 'PASS' : 'FAIL');

  // A blinker on the top visible edge wraps one cell to the bottom edge.
  let bl = createGrid(8, 8);
  alive(bl, [0,3],[0,4],[0,5]);
  bl = step(bl, RULESETS.classic);
  console.log('blinker wraps top↔bottom ✓:',
    (getCell(bl, 0, 4) === 1 && getCell(bl, 1, 4) === 1 && getCell(bl, 7, 4) === 1) ? 'PASS' : 'FAIL');
  bl = step(bl, RULESETS.classic);
  console.log('blinker returns horizontal ✓:', countAlive(bl) === 3 ? 'PASS' : 'FAIL');
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
