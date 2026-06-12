// Transport controls + vertical timeline scrubber (paused only).
// Purely presentational — all sim state lives in App.tsx.

export type ControlsProps = {
  playing: boolean;
  editing: boolean;
  scrubIndex: number;     // index into the paused history snapshot
  scrubMax: number;       // snapshot length - 1
  genLabel: string;       // absolute generation number at the cursor
  onPlayPause: () => void;
  onStepBack: () => void; // disabled at the oldest retained generation
  onStepFwd: () => void;  // at scrubMax: computes one new generation
  onScrub: (index: number) => void;
  onRestart: () => void;  // fresh randomized grid, history cleared
  onEdit: () => void;     // enter canvas edit mode
  onClear: () => void;    // edit mode: wipe the canvas
};

export default function Controls({
  playing, editing, scrubIndex, scrubMax, genLabel,
  onPlayPause, onStepBack, onStepFwd, onScrub, onRestart, onEdit, onClear,
}: ControlsProps) {
  if (editing) {
    return (
      <div id="controls">
        <button type="button" title="Clear canvas" onClick={onClear}>
          🗑
        </button>
        <button type="button" title="Start (space)" onClick={onPlayPause}>
          ▶
        </button>
      </div>
    );
  }

  return (
    <>
      <div id="controls">
        <button type="button" title="Restart" onClick={onRestart}>
          ⟳
        </button>
        <button type="button" title="Edit canvas" onClick={onEdit}>
          ✎
        </button>
        {!playing && (
          <button
            type="button"
            title="Step backward (←)"
            disabled={scrubIndex <= 0}
            onClick={onStepBack}
          >
            ◄
          </button>
        )}
        <button type="button" title="Play / pause (space)" onClick={onPlayPause}>
          {playing ? '⏸' : '▶'}
        </button>
        {!playing && (
          <button type="button" title="Step forward (→)" onClick={onStepFwd}>
            ►
          </button>
        )}
      </div>

      {!playing && (
        <div id="scrubber">
          <span id="scrubber-label">{genLabel}</span>
          <input
            type="range"
            min={0}
            max={Math.max(scrubMax, 0)}
            step={1}
            value={scrubIndex}
            aria-label="Timeline"
            onChange={e => onScrub(Number(e.currentTarget.value))}
          />
        </div>
      )}
    </>
  );
}
