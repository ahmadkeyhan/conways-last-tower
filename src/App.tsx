import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  createGrid, seedWithNoise, step, cloneGrid, History, RULESETS,
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

// Smallest grid the user can shrink the canvas to in edit mode. On a torus an
// 8×8 world still has room for blinkers, toads, beacons and a glider that
// travels several cells before wrapping onto itself — below this, patterns fold
// back instantly and Life stops being interesting.
const MIN_GRID = 8;

// Imperative sim API — created inside the effect, called from UI handlers.
type SimAPI = {
  playPause: () => void;
  stepBack: () => void;
  stepFwd: () => void;
  scrubTo: (index: number) => void;
  restart: () => void;
  enterEdit: () => void;
  clearCanvas: () => void;
  setGridSize: (n: number) => void;
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
  gridSize: number;
  minGrid: number;
  maxGrid: number;
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
    gridSize: fxRef.current.traits.gridSize,
    minGrid: Math.min(MIN_GRID, fxRef.current.traits.gridSize),
    maxGrid: fxRef.current.traits.gridSize,
  });

  useEffect(() => {
    const canvas = canvasRef.current!;

    const { rng, traits, skin, isCapture, preview } = fxRef.current!;
    const ruleset = RULESETS[traits.ruleset];
    const N = traits.gridSize;          // token's max grid size (trait)
    const minGrid = Math.min(MIN_GRID, N);
    let   gridN = N;                    // current active grid size (editable)

    let history = new History(traits.historyDepth);
    // The opening soup is a token trait: simplex-noise clustered seed at the
    // sampled density + ruleset guards, captured immutably so Restart replays
    // the exact same generation 0.
    let grid = seedWithNoise(
      gridN, gridN, traits.seedDensity,
      traits.noiseFrequency, traits.noiseOffsetX, traits.noiseOffsetY,
      traits.ruleset, rng,
    );
    const initialSoup = cloneGrid(grid); // token's gen-0, captured once at size N
    history.push(grid);

    const tileFor = (n: number) =>
      Math.min(32, Math.max(4, Math.floor((window.innerWidth * 0.7) / n)));

    // `let` so a grid-size change can dispose and swap in a fresh renderer —
    // every closure below references `renderer` by name, so they all follow it.
    let renderer = new Renderer({
      canvas,
      skin,
      tileWidth: tileFor(gridN),
      rows: gridN,
      cols: gridN,
      historyDepth: traits.historyDepth,
      shape: traits.shape,
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
        gridSize: gridN,
        minGrid,
        maxGrid: N,
      });
      if (paused) {
        updateInfo(`paused @ gen ${genAt(scrubIndex)}  |  ${traits.ruleset}  |  ${gridN}×${gridN}`);
      } else if (editing) {
        updateInfo(`edit  |  draw or stamp  |  ${gridN}×${gridN}`);
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

    // Replay the token's fixed opening: cleared history, resumes playing.
    // (The initial soup is a trait — restart always reproduces the same gen 0.)
    function restart() {
      if (gridN !== N) rebuildRenderer(N); // restart returns to the token's full grid
      history = new History(traits.historyDepth);
      grid = cloneGrid(initialSoup);
      history.push(grid);
      renderer.rebuildCache([history.peek()!]);
      scrubLayers = null;
      scrubIndex  = 0;
      editing  = false;
      selStamp = null;
      renderer.setGhost(null);
      playing = true;
      renderer.resumeOrbit();
      updateInfo(`Gen ${history.totalGenerations}  |  ${traits.ruleset}  |  ${gridN}×${gridN}  |  population ${countAlive(grid)}`);
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

    // Dispose the current renderer and build a fresh one at size n on the same
    // canvas (the WebGL context is reused). frustum/fog/buffers all scale to n.
    function rebuildRenderer(n: number) {
      gridN = n;
      renderer.dispose();
      renderer = new Renderer({
        canvas,
        skin,
        tileWidth: tileFor(n),
        rows: n,
        cols: n,
        historyDepth: traits.historyDepth,
        shape: traits.shape
      });
      renderer.resize(window.innerWidth, window.innerHeight);
    }

    // Edit-mode only: resize the drawing canvas. The existing drawing is kept
    // centered — center-cropped when shrinking, center-padded when growing.
    function setGridSize(n: number) {
      if (!editing) return;
      n = Math.max(minGrid, Math.min(N, Math.round(n)));
      if (n === gridN) return;

      // Re-anchor the old cells to the new grid's center before swapping.
      const prev = grid;
      const prevN = gridN;
      const next = createGrid(n, n);
      const off = Math.floor((n - prevN) / 2); // +pad when growing, −crop when shrinking
      for (let r = 0; r < prevN; r++) {
        const nr = r + off;
        if (nr < 0 || nr >= n) continue;
        for (let c = 0; c < prevN; c++) {
          const nc = c + off;
          if (nc < 0 || nc >= n) continue;
          if (getCell(prev, r, c) === 1) setCell(next, nr, nc, 1);
        }
      }

      rebuildRenderer(n);
      grid = next;
      history = new History(traits.historyDepth);
      hoverCell = null;
      renderer.setGhost(null);
      renderer.setEditView(true, true);              // snap (no glide) to top-down
      renderer.rebuildCache([innerSnapshot(grid)]);
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
          if (row >= 0 && row < gridN && col >= 0 && col < gridN) cells.push({ row, col });
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
      enterEdit, clearCanvas, setGridSize, selectStamp, rotateStamp, flipStamp,
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

    if (isCapture) {
      // Capture path: fast-forward to a full cube (one generation per grid row),
      // freeze at the isometric corner (ground + UI hidden), render one framed
      // frame, then trigger the fxhash snapshot.
      const CAPTURE_GEN = N; // grid size → the tower is a complete N×N×N cube
      while (history.totalGenerations < CAPTURE_GEN) {
        grid = step(grid, ruleset);
        history.push(grid);
        renderer.commitLayer(history.peek()!);
      }
      renderer.renderCapture();
      preview();
    } else {
      raf = requestAnimationFrame(loop);
    }

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
      {/* Overlay hidden in the fxhash capture environment — clean canvas only. */}
      {!fxRef.current!.isCapture && (
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
            gridSize={ui.gridSize}
            minGrid={ui.minGrid}
            maxGrid={ui.maxGrid}
            onGridSize={n => simRef.current?.setGridSize(n)}
            onSelect={id => simRef.current?.selectStamp(id)}
            onRotate={() => simRef.current?.rotateStamp()}
            onFlip={() => simRef.current?.flipStamp()}
          />
        )}
      </div>
      )}
    </div>
  );
}
