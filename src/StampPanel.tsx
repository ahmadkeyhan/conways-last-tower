// Stamp library panel — edit mode only. Purely presentational.

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
  onSelect: (id: string) => void; // selecting the current stamp deselects it
  onRotate: () => void;
  onFlip: () => void;
};

export default function StampPanel({
  selectedId, onSelect, onRotate, onFlip,
}: StampPanelProps) {
  return (
    <div id="stamp-panel">
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
    </div>
  );
}
