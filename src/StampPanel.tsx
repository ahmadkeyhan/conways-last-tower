// Stamp library panel — edit mode only. Purely presentational.

import { useEffect, useState } from 'react';
import { ALL_STAMPS } from './stamps';
import type { Stamp, StampCategory } from './stamps';

const SECTIONS: { label: string; category: StampCategory }[] = [
  { label: 'Still Lifes', category: 'still-life' },
  { label: 'Oscillators', category: 'oscillator' },
  { label: 'Spaceships',  category: 'spaceship' },
  { label: 'Guns',        category: 'gun' },
];

export type StampPanelProps = {
  selectedId: string | null;
  gridSize: number;
  minGrid: number;
  maxGrid: number;
  onGridSize: (n: number) => void; // commit a new grid size (rebuilds the canvas)
  onSelect: (id: string) => void;  // selecting the current stamp deselects it
  onRotate: () => void;
  onFlip: () => void;
};

// Grid-size slider. Tracks the drag locally and only commits on release, so the
// expensive renderer rebuild fires once per adjustment, not on every tick.
function GridSizeControl({
  gridSize, minGrid, maxGrid, onGridSize,
}: Pick<StampPanelProps, 'gridSize' | 'minGrid' | 'maxGrid' | 'onGridSize'>) {
  const [draft, setDraft] = useState(gridSize);
  // Follow external changes (e.g. restart resets to the max grid)
  useEffect(() => { setDraft(gridSize); }, [gridSize]);

  const commit = () => { if (draft !== gridSize) onGridSize(draft); };

  return (
    <div className="stamp-section" id="grid-size">
      <div className="stamp-section-title">Grid Size — {draft}×{draft}</div>
      <input
        type="range"
        min={minGrid}
        max={maxGrid}
        step={1}
        value={draft}
        aria-label="Grid size"
        onChange={e => setDraft(Number(e.currentTarget.value))}
        onPointerUp={commit}
        onKeyUp={commit}
      />
    </div>
  );
}

export default function StampPanel({
  selectedId, gridSize, minGrid, maxGrid, onGridSize, onSelect, onRotate, onFlip,
}: StampPanelProps) {
  return (
    <div id="stamp-panel">
      <div id="stamp-gallery">
        {SECTIONS.map(({ label, category }) => {
          const stamps = ALL_STAMPS.filter((s: Stamp) => s.category === category);
          if (stamps.length === 0) return null;
          return (
            <div key={category} className="stamp-section">
              <div className="stamp-section-title">{label}</div>
              {stamps.map(s => (
                <button
                  key={s.id}
                  type="button"
                  className={s.id === selectedId ? 'selected' : ''}
                  onClick={() => onSelect(s.id)}
                >
                  {s.name}
                </button>
              ))}
            </div>
          );
        })}
      </div>

      <div id="stamp-transform">
        <button
          type="button"
          title="Rotate (R)"
          disabled={!selectedId}
          onClick={onRotate}
        >
          ⟲
        </button>
        <button
          type="button"
          title="Flip (F)"
          disabled={!selectedId}
          onClick={onFlip}
        >
          ⇋
        </button>
      </div>

      <GridSizeControl
        gridSize={gridSize}
        minGrid={minGrid}
        maxGrid={maxGrid}
        onGridSize={onGridSize}
      />
    </div>
  );
}
