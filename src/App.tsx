import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  createGrid, randomizeGrid, step, cloneGrid, History, RULESETS,
  getCell, setCell, innerSnapshot, countAlive,
} from './engine';
import type { Grid } from './engine';
import { Renderer } from './renderer';
import Controls from './Controls';
import StampPanel from './StampPanel';
import { getStampById, rotatePattern, flipPattern } from './stamps';
import type { Stamp, StampPattern } from './stamps';
import { initFx } from './fxhash';
import type { FxContext } from './fxhash';

// Imperative sim API — created inside the effect, called from UI handlers.
type SimAPI = {
  playPause: () => void;
  stepBack: () => void;
  stepFwd: () => void;
  scrubTo: (index: number) => void;
  restart: () => void;
  enterEdit: () => void;
  clearCanvas: () => void;
  selectStamp: (id: string) => void;
  rotateStamp: () => void;
  flipStamp: () => void;
};

type UiState = {
  playing: boolean;
  editing: boolean;
  selectedStamp: string | null;
  scrubIndex: number;
  scrubMax: number;
  genLabel: string;
};

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const infoRef   = useRef<HTMLDivElement>(null);
  const simRef    = useRef<SimAPI | null>(null);
  // Once-only fxhash init — the lazy guard survives StrictMode's double render
  // and avoids registering features twice. Shared by the effect and the JSX
  // below (the --accent CSS var), so both see the same seed-derived skin.
  const fxRef     = useRef<FxContext | null>(null);
  if (!fxRef.current) fxRef.current = initFx();
  const [ui, setUi] = useState<UiState>({
    playing: true, editing: false, selectedStamp: null,
    scrubIndex: 0, scrubMax: 0, genLabel: '',
  });

  useEffect(() => {
    const canvas = canvasRef.current!;

    const { rng, traits, skin } = fxRef.current!;
    const ruleset = RULESETS[traits.ruleset];
    const N = traits.gridSize;

    let history = new History(traits.historyDepth);
    let grid = randomizeGrid(createGrid(N, N), 0.35, rng);
    history.push(grid);

    const tileW = Math.min(32, Math.max(4, Math.floor((window.innerWidth * 0.7) / N)));

    const renderer = new Renderer({
      canvas,
      skin,
      tileWidth: tileW,
      rows: N,
      cols: N,
      historyDepth: traits.historyDepth,
    });

    function resize() {
      renderer.resize(window.innerWidth, window.innerHeight);
    }
    resize();
    window.addEventListener('resize', resize);

    // Commit the initial generation so there is always one layer in cache.
    // The live GridBuffer is ghost-padded — the renderer always receives
    // dense snapshots (history entries or innerSnapshot copies).
    renderer.commitLayer(history.peek()!);

    // ── Sim control state ───────────────────────────────────────────────────
    // Mutable state lives here (the RAF loop reads it); React state mirrors
    // only what the UI renders.

    let playing = true;
    let scrubLayers: Grid[] | null = null; // frozen history snapshot while paused
    let scrubIndex = 0;

    // Edit mode state
    let editing = false;
    let selStamp: Stamp | null = null;
    let stampRot  = 0;     // quarter-turns, 0..3
    let stampFlip = false;
    let painting  = false;
    let paintVal: 0 | 1 = 1;
    let hoverCell: { row: number; col: number } | null = null;

    function updateInfo(text: string) {
      if (infoRef.current) infoRef.current.textContent = text;
    }

    // Absolute generation number of snapshot entry i (1-based, matches "Gen N")
    function genAt(i: number): number {
      return history.oldestGeneration + i + 1;
    }

    function syncUi() {
      const paused = !playing && !editing && scrubLayers !== null;
      setUi({
        playing,
        editing,
        selectedStamp: selStamp ? selStamp.id : null,
        scrubIndex,
        scrubMax: paused ? scrubLayers!.length - 1 : 0,
        genLabel: paused ? `gen ${genAt(scrubIndex)}` : '',
      });
      if (paused) {
        updateInfo(`paused @ gen ${genAt(scrubIndex)}  |  ${traits.ruleset}  |  ${N}×${N}`);
      } else if (editing) {
        updateInfo(`edit  |  draw or stamp  |  ${N}×${N}`);
      }
    }

    function pause() {
      if (!playing) return;
      playing = false;
      renderer.pauseOrbit();
      scrubLayers = history.toArray();
      scrubIndex  = scrubLayers.length - 1;
      syncUi();
    }

    function play() {
      if (playing) return;
      // Branch: resuming from a scrubbed-back position discards the future
      if (scrubLayers && scrubIndex < scrubLayers.length - 1) {
        history.trimTo(scrubIndex);
        grid = cloneGrid(scrubLayers[scrubIndex]);
        // renderer cache already shows layers 0..scrubIndex — consistent
      }
      scrubLayers = null;
      playing = true;
      renderer.resumeOrbit();
      syncUi();
    }

    function scrubTo(index: number) {
      if (playing || editing || !scrubLayers) return;
      const k = Math.max(0, Math.min(index, scrubLayers.length - 1));
      if (k === scrubIndex) return;
      scrubIndex = k;
      renderer.rebuildCache(scrubLayers.slice(0, k + 1));
      syncUi();
    }

    function stepBack() {
      if (playing || editing || !scrubLayers) return;
      scrubTo(scrubIndex - 1);
    }

    function stepFwd() {
      if (playing || editing || !scrubLayers) return;
      if (scrubIndex < scrubLayers.length - 1) {
        // Walk forward through existing history — never trims
        scrubTo(scrubIndex + 1);
      } else {
        // At the tip: compute one new generation, stay paused.
        // (grid is untouched by scrubbing, so it is still the live buffer.)
        grid = step(grid, ruleset);
        history.push(grid);
        renderer.commitLayer(history.peek()!);
        scrubLayers = history.toArray();
        scrubIndex  = scrubLayers.length - 1;
        syncUi();
      }
    }

    function playPause() {
      if (editing) startFromCanvas();
      else if (playing) pause();
      else play();
    }

    // Fresh randomized grid, cleared history, resumes playing.
    // (The rng stream continues, so each restart produces a new layout.)
    function restart() {
      history = new History(traits.historyDepth);
      grid = randomizeGrid(createGrid(N, N), 0.35, rng);
      history.push(grid);
      renderer.rebuildCache([history.peek()!]);
      scrubLayers = null;
      scrubIndex  = 0;
      editing  = false;
      selStamp = null;
      renderer.setGhost(null);
      playing = true;
      renderer.resumeOrbit();
      updateInfo(`Gen ${history.totalGenerations}  |  ${traits.ruleset}  |  ${N}×${N}  |  population ${countAlive(grid)}`);
      syncUi();
    }

    // ── Edit mode ───────────────────────────────────────────────────────────

    function enterEdit() {
      if (editing) return;
      playing = false;
      // Edit what is displayed: adopt the scrubbed snapshot if rewound
      if (scrubLayers && scrubIndex < scrubLayers.length - 1) {
        grid = cloneGrid(scrubLayers[scrubIndex]);
      }
      scrubLayers = null;
      editing = true;
      renderer.setEditView(true);                    // glide to top-down, axis-aligned
      renderer.rebuildCache([innerSnapshot(grid)]);  // collapse tower to the canvas layer
      syncUi();
    }

    // Start the engine with the edited canvas as generation 0 (fresh tower).
    function startFromCanvas() {
      if (!editing) return;
      history = new History(traits.historyDepth);
      history.push(grid);
      selStamp  = null;
      hoverCell = null;
      renderer.setGhost(null);
      editing = false;
      playing = true;
      renderer.resumeOrbit();
      syncUi();
    }

    function clearCanvas() {
      if (!editing) return;
      grid.data.fill(0); // ghost ring is already 0 — fill is safe
      renderer.updateLiveLayer(innerSnapshot(grid));
    }

    // Selected stamp pattern with rotation/flip applied
    function transformedPattern(): StampPattern {
      let pat = selStamp!.pattern;
      for (let i = 0; i < stampRot; i++) pat = rotatePattern(pat);
      if (stampFlip) pat = flipPattern(pat);
      return pat;
    }

    // Alive cells of the transformed stamp, centered on the anchor; in-bounds only
    function stampCells(anchor: { row: number; col: number }) {
      const pat = transformedPattern();
      const r0 = anchor.row - Math.floor(pat.length / 2);
      const c0 = anchor.col - Math.floor(pat[0].length / 2);
      const cells: { row: number; col: number }[] = [];
      for (let r = 0; r < pat.length; r++) {
        for (let c = 0; c < pat[r].length; c++) {
          if (pat[r][c] !== 1) continue;
          const row = r0 + r;
          const col = c0 + c;
          if (row >= 0 && row < N && col >= 0 && col < N) cells.push({ row, col });
        }
      }
      return cells;
    }

    function refreshGhost() {
      renderer.setGhost(selStamp && hoverCell ? stampCells(hoverCell) : null);
    }

    function selectStamp(id: string) {
      selStamp  = selStamp && selStamp.id === id ? null : (getStampById(id) ?? null);
      stampRot  = 0;
      stampFlip = false;
      refreshGhost();
      syncUi();
    }

    function rotateStamp() {
      if (!selStamp) return;
      stampRot = (stampRot + 1) % 4;
      refreshGhost();
    }

    function flipStamp() {
      if (!selStamp) return;
      stampFlip = !stampFlip;
      refreshGhost();
    }

    // ── Edit pointer handlers (paint + stamp placement) ─────────────────────

    function onPointerDown(e: PointerEvent) {
      if (!editing || e.button !== 0) return;
      const cell = renderer.pickCell(e.clientX, e.clientY);
      if (!cell) return;
      if (selStamp) {
        // OR the stamp into the grid; stays selected for repeat placement
        for (const { row, col } of stampCells(cell)) setCell(grid, row, col, 1);
        renderer.updateLiveLayer(innerSnapshot(grid));
        return;
      }
      paintVal = getCell(grid, cell.row, cell.col) === 1 ? 0 : 1;
      setCell(grid, cell.row, cell.col, paintVal);
      renderer.updateLiveLayer(innerSnapshot(grid));
      painting = true;
      canvas.setPointerCapture(e.pointerId);
    }

    function onPointerMove(e: PointerEvent) {
      if (!editing) return;
      const cell = renderer.pickCell(e.clientX, e.clientY);
      if (painting) {
        if (!cell) return;
        if (getCell(grid, cell.row, cell.col) !== paintVal) {
          setCell(grid, cell.row, cell.col, paintVal);
          renderer.updateLiveLayer(innerSnapshot(grid));
        }
      } else if (selStamp) {
        hoverCell = cell;
        refreshGhost();
      }
    }

    function onPointerUp() {
      painting = false;
    }

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);

    simRef.current = {
      playPause, stepBack, stepFwd, scrubTo, restart,
      enterEdit, clearCanvas, selectStamp, rotateStamp, flipStamp,
    };

    function onKey(e: KeyboardEvent) {
      if (editing) {
        if (e.code === 'Space')        { e.preventDefault(); startFromCanvas(); }
        else if (e.key === 'r' || e.key === 'R') rotateStamp();
        else if (e.key === 'f' || e.key === 'F') flipStamp();
        else if (e.key === 'Escape' && selStamp) {
          selStamp = null;
          renderer.setGhost(null);
          syncUi();
        }
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        playPause();
      } else if (!playing && e.key === 'ArrowLeft') {
        e.preventDefault();
        stepBack();
      } else if (!playing && e.key === 'ArrowRight') {
        e.preventDefault();
        stepFwd();
      }
    }
    window.addEventListener('keydown', onKey);

    // ── Main loop — always runs (orbit + camera glides animate every frame) ─

    const STEP_MS = 1000 / 12;
    let lastStep = 0;
    let raf = 0;
    let running = true;

    function loop(t: number) {
      if (!running) return;

      if (playing && t - lastStep >= STEP_MS) {
        grid = step(grid, ruleset);
        history.push(grid);
        renderer.commitLayer(history.peek()!);
        lastStep = t;
        updateInfo(`Gen ${history.totalGenerations}  |  ${traits.ruleset}  |  ${N}×${N}  |  population ${countAlive(grid)}`);
      }

      renderer.render();
      raf = requestAnimationFrame(loop);
    }

    raf = requestAnimationFrame(loop);

    return () => {
      running = false;
      simRef.current = null;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', onKey);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
    };
  }, []);

  return (
    // --accent feeds the scrubber/panel highlight color from the active skin
    <div
      id="app"
      className={ui.editing ? 'editing' : ''}
      style={{ '--accent': fxRef.current!.skin.accentColor } as CSSProperties}
    >
      <canvas ref={canvasRef} id="game-canvas" />
      <div id="ui-overlay">
        <div ref={infoRef} id="info-bar" />
        <Controls
          playing={ui.playing}
          editing={ui.editing}
          scrubIndex={ui.scrubIndex}
          scrubMax={ui.scrubMax}
          genLabel={ui.genLabel}
          onPlayPause={() => simRef.current?.playPause()}
          onStepBack={() => simRef.current?.stepBack()}
          onStepFwd={() => simRef.current?.stepFwd()}
          onScrub={k => simRef.current?.scrubTo(k)}
          onRestart={() => simRef.current?.restart()}
          onEdit={() => simRef.current?.enterEdit()}
          onClear={() => simRef.current?.clearCanvas()}
        />
        {ui.editing && (
          <StampPanel
            selectedId={ui.selectedStamp}
            onSelect={id => simRef.current?.selectStamp(id)}
            onRotate={() => simRef.current?.rotateStamp()}
            onFlip={() => simRef.current?.flipStamp()}
          />
        )}
      </div>
    </div>
  );
}
