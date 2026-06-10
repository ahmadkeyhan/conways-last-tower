export type CellState = 0 | 1 | 2; // 0=dead, 1=alive, 2=dying (Brian's Brain)
export type Grid = CellState[][];

export type StandardRuleset = {
  kind: 'standard';
  born: number[];
  survive: number[];
};

export type BrainRuleset = {
  kind: 'brain';
};

export type Ruleset = StandardRuleset | BrainRuleset;

export const RULESETS = {
  classic:  { kind: 'standard' as const, born: [3],          survive: [2, 3] },
  highlife: { kind: 'standard' as const, born: [3, 6],       survive: [2, 3] },
  maze:     { kind: 'standard' as const, born: [3],          survive: [1, 2, 3, 4, 5] },
  daynight: { kind: 'standard' as const, born: [3, 6, 7, 8], survive: [3, 4, 6, 7, 8] },
  brain:    { kind: 'brain' as const },
} satisfies Record<string, Ruleset>;

export type RulesetName = keyof typeof RULESETS;

export function createGrid(rows: number, cols: number): Grid {
  return Array.from({ length: rows }, () => new Array<CellState>(cols).fill(0));
}

export function cloneGrid(grid: Grid): Grid {
  return grid.map(row => [...row] as CellState[]);
}

export function randomizeGrid(grid: Grid, density = 0.3, rng = Math.random): Grid {
  const next = cloneGrid(grid);
  for (let r = 0; r < next.length; r++) {
    for (let c = 0; c < next[r].length; c++) {
      next[r][c] = rng() < density ? 1 : 0;
    }
  }
  return next;
}

export function countAliveNeighbors(grid: Grid, row: number, col: number): number {
  const rows = grid.length;
  const cols = grid[0].length;
  let count = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = (row + dr + rows) % rows;
      const nc = (col + dc + cols) % cols;
      // only state 1 counts as alive — dying cells (state 2) are inert for neighbor purposes
      if (grid[nr][nc] === 1) count++;
    }
  }
  return count;
}

export function countAlive(grid: Grid): number {
  let count = 0;
  for (const row of grid) {
    for (const cell of row) {
      if (cell === 1) count++;
    }
  }
  return count;
}

export function step(grid: Grid, ruleset: Ruleset): Grid {
  const rows = grid.length;
  const cols = grid[0].length;
  const next = createGrid(rows, cols);

  if (ruleset.kind === 'brain') {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const state = grid[r][c];
        if (state === 1) {
          next[r][c] = 2; // alive → dying
        } else if (state === 2) {
          next[r][c] = 0; // dying → dead
        } else {
          // dead → alive if exactly 2 alive neighbors
          next[r][c] = countAliveNeighbors(grid, r, c) === 2 ? 1 : 0;
        }
      }
    }
  } else {
    const { born, survive } = ruleset;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const alive = grid[r][c] === 1;
        const n = countAliveNeighbors(grid, r, c);
        if (alive) {
          next[r][c] = survive.includes(n) ? 1 : 0;
        } else {
          next[r][c] = born.includes(n) ? 1 : 0;
        }
      }
    }
  }

  return next;
}

export class History {
  private stack: Grid[] = [];
  private _totalGenerations = 0;
  readonly maxDepth: number;

  constructor(maxDepth: number) {
    this.maxDepth = maxDepth;
  }

  push(grid: Grid): void {
    this.stack.push(grid);
    this._totalGenerations++;
    if (this.stack.length > this.maxDepth) {
      this.stack.shift();
    }
  }

  get(index: number): Grid | undefined {
    return this.stack[index];
  }

  peek(): Grid | undefined {
    return this.stack[this.stack.length - 1];
  }

  // Truncate to stackIndex (inclusive); used by the timeline scrubber on resume
  trimTo(stackIndex: number): void {
    const removed = this.stack.length - stackIndex - 1;
    if (removed <= 0) return;
    this.stack = this.stack.slice(0, stackIndex + 1);
    this._totalGenerations -= removed;
  }

  get length(): number {
    return this.stack.length;
  }

  // Absolute generation number of the most recent stored frame
  get totalGenerations(): number {
    return this._totalGenerations;
  }

  // Absolute generation index of the oldest stored frame (= Z of stack[0])
  get oldestGeneration(): number {
    return this._totalGenerations - this.stack.length;
  }

  // All stored layers as a plain array (oldest first)
  toArray(): Grid[] {
    return this.stack.slice();
  }
}

export function printGrid(grid: Grid): string {
  return grid.map(row =>
    row.map(c => (c === 0 ? '.' : c === 1 ? '#' : 'o')).join('')
  ).join('\n');
}

// ── Console verification ──────────────────────────────────────────────────────

export function runEngineTest(): void {
  console.group("Conway's Last Tower — Engine Test");

  // ── Test 1: Blinker period-2 oscillation ─────────────────────────────────
  console.group('1. Blinker (Classic B3/S23) — period-2 check');
  const g0 = createGrid(5, 5);
  g0[2][1] = 1; g0[2][2] = 1; g0[2][3] = 1;
  console.log('Gen 0 (horizontal):\n' + printGrid(g0));

  const g1 = step(g0, RULESETS.classic);
  console.log('Gen 1 (vertical):\n' + printGrid(g1));

  const g2 = step(g1, RULESETS.classic);
  console.log('Gen 2 (should match gen 0):\n' + printGrid(g2));

  const period2 = JSON.stringify(g0) === JSON.stringify(g2);
  console.log('Period-2 ✓:', period2 ? 'PASS' : 'FAIL');
  console.groupEnd();

  // ── Test 2: Block still life ──────────────────────────────────────────────
  console.group('2. Block (still life) — no-change check');
  const block = createGrid(4, 4);
  block[1][1] = 1; block[1][2] = 1;
  block[2][1] = 1; block[2][2] = 1;
  const blockNext = step(block, RULESETS.classic);
  const stillLife = JSON.stringify(block) === JSON.stringify(blockNext);
  console.log('Still life ✓:', stillLife ? 'PASS' : 'FAIL');
  console.groupEnd();

  // ── Test 3: Glider maintains 5 alive cells ────────────────────────────────
  console.group('3. Glider — alive-count stability over 8 steps');
  const gliderBase = createGrid(12, 12);
  gliderBase[1][2] = 1;
  gliderBase[2][3] = 1;
  gliderBase[3][1] = 1; gliderBase[3][2] = 1; gliderBase[3][3] = 1;
  console.log('Gen 0:\n' + printGrid(gliderBase));

  let glider = gliderBase;
  let gliderOk = true;
  for (let i = 1; i <= 8; i++) {
    glider = step(glider, RULESETS.classic);
    if (countAlive(glider) !== 5) { gliderOk = false; break; }
  }
  console.log('8-step alive-count (expect 5 each) ✓:', gliderOk ? 'PASS' : 'FAIL');
  console.log('Gen 8:\n' + printGrid(glider));
  console.groupEnd();

  // ── Test 4: Brian's Brain state transitions ───────────────────────────────
  console.group("4. Brian's Brain — state cycle 1→2→0");
  const brain = createGrid(5, 5);
  // place two alive cells flanking a dead cell
  brain[2][1] = 1; brain[2][3] = 1;
  console.log('Gen 0 (two alive cells):\n' + printGrid(brain));

  const brain1 = step(brain, RULESETS.brain);
  console.log('Gen 1 (alive→dying, dead with 2 alive nbrs→alive):\n' + printGrid(brain1));

  const brain2 = step(brain1, RULESETS.brain);
  console.log('Gen 2:\n' + printGrid(brain2));

  const dyingTransition = brain1[2][1] === 2 && brain1[2][3] === 2;
  const bornTransition   = brain1[2][2] === 1;
  console.log('Alive→dying ✓:', dyingTransition ? 'PASS' : 'FAIL');
  console.log('Dead(2 alive nbrs)→alive ✓:', bornTransition ? 'PASS' : 'FAIL');
  console.groupEnd();

  // ── Test 5: History stack ─────────────────────────────────────────────────
  console.group('5. History — push / get / trimTo');
  const hist = new History(5);
  let cur = createGrid(3, 3);
  cur[0][0] = 1;
  for (let i = 0; i < 8; i++) {
    hist.push(cur);
    cur = step(cur, RULESETS.classic);
  }
  const depthOk = hist.length === 5;
  const totalOk = hist.totalGenerations === 8;
  const oldestOk = hist.oldestGeneration === 3;
  console.log('maxDepth capped at 5:', depthOk ? 'PASS' : `FAIL (got ${hist.length})`);
  console.log('totalGenerations = 8:', totalOk ? 'PASS' : `FAIL (got ${hist.totalGenerations})`);
  console.log('oldestGeneration = 3:', oldestOk ? 'PASS' : `FAIL (got ${hist.oldestGeneration})`);

  hist.trimTo(2); // keep stack[0..2]
  const trimOk  = hist.length === 3;
  const totalTrimOk = hist.totalGenerations === 6;
  console.log('trimTo(2) → length 3:', trimOk ? 'PASS' : `FAIL (got ${hist.length})`);
  console.log('totalGenerations after trim = 6:', totalTrimOk ? 'PASS' : `FAIL (got ${hist.totalGenerations})`);
  console.groupEnd();

  console.groupEnd(); // root group
}
