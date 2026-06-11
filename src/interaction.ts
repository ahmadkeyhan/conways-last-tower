// Input handling and UI controls — stub
// Wires canvas pointer events to cell painting and stamp placement.
// Also owns play / pause / step / scrubber state.

import type { Grid, Ruleset } from './engine';
import type { Stamp } from './stamps';

export type SimState = 'playing' | 'paused';

export type InteractionConfig = {
  canvas: HTMLCanvasElement;
  gridRows: number;
  gridCols: number;
  onCellToggle: (row: number, col: number) => void;
  onStampPlace: (stamp: Stamp, row: number, col: number, rotation: number, flip: boolean) => void;
  onPlay: () => void;
  onPause: () => void;
  onStep: () => void;
  onScrub: (historyIndex: number) => void;
};

export type SimControls = {
  state: SimState;
  ruleset: Ruleset;
  historyIndex: number; // current scrubber position
  speed: number;        // ms per generation
};

export class InteractionManager {
  constructor(_config: InteractionConfig) {
    // TODO: store config, bind pointer events
  }

  // Convert canvas pixel coords to grid cell (handles isometric mapping)
  pixelToCell(_x: number, _y: number, _currentZ: number): { row: number; col: number } | null {
    // TODO
    return null;
  }

  applyStampToGrid(grid: Grid, stamp: Stamp, row: number, col: number, rotation: number, flip: boolean): Grid {
    // TODO: rotate/flip stamp before applying
    void rotation; void flip;
    const { rows, cols } = grid;
    const data = grid.data.slice();
    for (let dr = 0; dr < stamp.pattern.length; dr++) {
      for (let dc = 0; dc < stamp.pattern[dr].length; dc++) {
        const r = row + dr;
        const c = col + dc;
        if (r >= 0 && r < rows && c >= 0 && c < cols) {
          data[r * cols + c] = stamp.pattern[dr][dc] as 0 | 1;
        }
      }
    }
    return { rows, cols, data };
  }

  destroy(): void {
    // TODO: remove event listeners
  }
}
