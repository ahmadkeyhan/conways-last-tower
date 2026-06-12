// Transport controls + vertical timeline scrubber (paused only).
// Purely presentational — all sim state lives in App.tsx.

export type ControlsProps = {
  playing: boolean;
  scrubIndex: number;     // index into the paused history snapshot
  scrubMax: number;       // snapshot length - 1
  genLabel: string;       // absolute generation number at the cursor
  onPlayPause: () => void;
  onStepBack: () => void; // disabled at the oldest retained generation
  onStepFwd: () => void;  // at scrubMax: computes one new generation
  onScrub: (index: number) => void;
};

export default function Controls({
  playing, scrubIndex, scrubMax, genLabel,
  onPlayPause, onStepBack, onStepFwd, onScrub,
}: ControlsProps) {
  return (
    <>
      <div id="controls">
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
