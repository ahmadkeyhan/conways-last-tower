export type StampCell = 0 | 1;
export type StampPattern = StampCell[][];

export type StampCategory =
  | 'still-life'
  | 'oscillator'
  | 'spaceship'
  | 'methuselah'
  | 'gun'
  | 'gemini';

// Stamp library tier — higher tiers include all lower tiers
// still-life=1, oscillator=2, spaceship=3, methuselah=4, gun=5, gemini=6
export type StampTier = 1 | 2 | 3 | 4 | 5 | 6;

export const TIER_BY_CATEGORY: Record<StampCategory, StampTier> = {
  'still-life':  1,
  'oscillator':  2,
  'spaceship':   3,
  'methuselah':  4,
  'gun':         5,
  'gemini':      6,
};

export type Stamp = {
  id: string;
  name: string;
  category: StampCategory;
  pattern: StampPattern;
  // expected period for oscillators/spaceships; undefined for still-lifes and methuselahs
  period?: number;
};

// ── Pattern helpers ───────────────────────────────────────────────────────────

function p(rows: string[]): StampPattern {
  return rows.map(row => [...row].map(c => (c === '#' ? 1 : 0)) as StampCell[]);
}

export function rotatePattern(pattern: StampPattern): StampPattern {
  const rows = pattern.length;
  const cols = pattern[0].length;
  return Array.from({ length: cols }, (_, c) =>
    Array.from({ length: rows }, (__, r) => pattern[rows - 1 - r][c]) as StampCell[]
  );
}

export function flipPattern(pattern: StampPattern): StampPattern {
  return pattern.map(row => [...row].reverse() as StampCell[]);
}

// ── Still Lifes ───────────────────────────────────────────────────────────────

const BLOCK: Stamp = {
  id: 'block', name: 'Block', category: 'still-life',
  pattern: p([
    '##',
    '##',
  ]),
};

const BEEHIVE: Stamp = {
  id: 'beehive', name: 'Beehive', category: 'still-life',
  pattern: p([
    '.##.',
    '#..#',
    '.##.',
  ]),
};

const LOAF: Stamp = {
  id: 'loaf', name: 'Loaf', category: 'still-life',
  pattern: p([
    '.##.',
    '#..#',
    '.#.#',
    '..#.',
  ]),
};

const BOAT: Stamp = {
  id: 'boat', name: 'Boat', category: 'still-life',
  pattern: p([
    '##.',
    '#.#',
    '.#.',
  ]),
};

// ── Oscillators ───────────────────────────────────────────────────────────────

const BLINKER: Stamp = {
  id: 'blinker', name: 'Blinker', category: 'oscillator', period: 2,
  pattern: p([
    '###',
  ]),
};

const TOAD: Stamp = {
  id: 'toad', name: 'Toad', category: 'oscillator', period: 2,
  pattern: p([
    '.###',
    '###.',
  ]),
};

const BEACON: Stamp = {
  id: 'beacon', name: 'Beacon', category: 'oscillator', period: 2,
  pattern: p([
    '##..',
    '##..',
    '..##',
    '..##',
  ]),
};

const PULSAR: Stamp = {
  id: 'pulsar', name: 'Pulsar', category: 'oscillator', period: 3,
  pattern: p([
    '..###...###..',
    '.............',
    '#....#.#....#',
    '#....#.#....#',
    '#....#.#....#',
    '..###...###..',
    '.............',
    '..###...###..',
    '#....#.#....#',
    '#....#.#....#',
    '#....#.#....#',
    '.............',
    '..###...###..',
  ]),
};

// ── Spaceships ────────────────────────────────────────────────────────────────

const GLIDER: Stamp = {
  id: 'glider', name: 'Glider', category: 'spaceship', period: 4,
  pattern: p([
    '.#.',
    '..#',
    '###',
  ]),
};

const LWSS: Stamp = {
  id: 'lwss', name: 'Lightweight Spaceship', category: 'spaceship', period: 4,
  pattern: p([
    '.####',
    '#...#',
    '....#',
    '#..#.',
  ]),
};

// ── Methuselahs ───────────────────────────────────────────────────────────────

const R_PENTOMINO: Stamp = {
  id: 'r-pentomino', name: 'R-Pentomino', category: 'methuselah',
  pattern: p([
    '.##',
    '##.',
    '.#.',
  ]),
};

const ACORN: Stamp = {
  id: 'acorn', name: 'Acorn', category: 'methuselah',
  pattern: p([
    '.#.....',
    '...#...',
    '##..###',
  ]),
};

const DIEHARD: Stamp = {
  id: 'diehard', name: 'Diehard', category: 'methuselah',
  pattern: p([
    '......#.',
    '##......',
    '.#...###',
  ]),
};

// ── Guns ─────────────────────────────────────────────────────────────────────

const GOSPER_GLIDER_GUN: Stamp = {
  id: 'gosper-glider-gun', name: 'Gosper Glider Gun', category: 'gun',
  pattern: p([
    '........................#...........',
    '......................#.#...........',
    '............##......##............##',
    '...........#...#....##............##',
    '##........#.....#...##..............',
    '##........#...#.##....#.#...........',
    '..........#.....#.......#...........',
    '...........#...#....................',
    '............##......................',
  ]),
};

// ── Gemini (placeholder) ──────────────────────────────────────────────────────
// TODO: encode Gemini self-replicating spaceship pattern

// ── Library ───────────────────────────────────────────────────────────────────

export const ALL_STAMPS: Stamp[] = [
  BLOCK, BEEHIVE, LOAF, BOAT,
  BLINKER, TOAD, BEACON, PULSAR,
  GLIDER, LWSS,
  R_PENTOMINO, ACORN, DIEHARD,
  GOSPER_GLIDER_GUN,
];

export function getStampsForTier(tier: StampTier): Stamp[] {
  return ALL_STAMPS.filter(s => TIER_BY_CATEGORY[s.category] <= tier);
}

export function getStampById(id: string): Stamp | undefined {
  return ALL_STAMPS.find(s => s.id === id);
}
