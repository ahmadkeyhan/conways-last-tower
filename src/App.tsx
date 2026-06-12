import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createGrid, randomizeGrid, step, cloneGrid, History, RULESETS } from './engine';
import type { Grid } from './engine';
import { Renderer } from './renderer';
import Controls from './Controls';
import { FALLBACK_SKIN } from './skin';
import { initFx } from './fxhash';

// Imperative sim API — created inside the effect, called from UI handlers.
type SimAPI = {
  playPause: () => void;
  stepBack: () => void;
  stepFwd: () => void;
  scrubTo: (index: number) => void;
  restart: () => void;
};

type UiState = {
  playing: boolean;
  scrubIndex: number;
  scrubMax: number;
  genLabel: string;
};

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const infoRef   = useRef<HTMLDivElement>(null);
  const simRef    = useRef<SimAPI | null>(null);
  const [ui, setUi] = useState<UiState>({
    playing: true, scrubIndex: 0, scrubMax: 0, genLabel: '',
  });

  useEffect(() => {
    const canvas = canvasRef.current!;

    const { rng, traits } = initFx();
    const ruleset = RULESETS[traits.ruleset];
    const N = traits.gridSize;

    let history = new History(traits.historyDepth);
    let grid = randomizeGrid(createGrid(N, N), 0.05, rng);
    history.push(grid);

    const tileW = Math.min(32, Math.max(4, Math.floor((window.innerWidth * 0.7) / N)));

    const renderer = new Renderer({
      canvas,
      skin: FALLBACK_SKIN,
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

    // Commit the initial generation so there is always one layer in cache
    renderer.commitLayer(grid);

    // ── Sim control state ───────────────────────────────────────────────────
    // Mutable state lives here (the RAF loop reads it); React state mirrors
    // only what the UI renders.

    let playing = true;
    let scrubLayers: Grid[] | null = null; // frozen history snapshot while paused
    let scrubIndex = 0;

    function updateInfo(text: string) {
      if (infoRef.current) infoRef.current.textContent = text;
    }

    // Absolute generation number of snapshot entry i (1-based, matches "Gen N")
    function genAt(i: number): number {
      return history.oldestGeneration + i + 1;
    }

    function syncUi() {
      const paused = !playing && scrubLayers !== null;
      setUi({
        playing,
        scrubIndex,
        scrubMax: paused ? scrubLayers!.length - 1 : 0,
        genLabel: paused ? `gen ${genAt(scrubIndex)}` : '',
      });
      if (paused) {
        updateInfo(`paused @ gen ${genAt(scrubIndex)}  |  ${traits.ruleset}  |  ${N}×${N}`);
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
      if (playing || !scrubLayers) return;
      const k = Math.max(0, Math.min(index, scrubLayers.length - 1));
      if (k === scrubIndex) return;
      scrubIndex = k;
      renderer.rebuildCache(scrubLayers.slice(0, k + 1));
      syncUi();
    }

    function stepBack() {
      if (playing || !scrubLayers) return;
      scrubTo(scrubIndex - 1);
    }

    function stepFwd() {
      if (playing || !scrubLayers) return;
      if (scrubIndex < scrubLayers.length - 1) {
        // Walk forward through existing history — never trims
        scrubTo(scrubIndex + 1);
      } else {
        // At the tip: compute one new generation, stay paused.
        // (grid is untouched by scrubbing, so it is still the live buffer.)
        grid = step(grid, ruleset);
        history.push(grid);
        renderer.commitLayer(grid);
        scrubLayers = history.toArray();
        scrubIndex  = scrubLayers.length - 1;
        syncUi();
      }
    }

    function playPause() {
      if (playing) pause();
      else play();
    }

    // Fresh randomized grid, cleared history, resumes playing.
    // (The rng stream continues, so each restart produces a new layout.)
    function restart() {
      history = new History(traits.historyDepth);
      grid = randomizeGrid(createGrid(N, N), 0.35, rng);
      history.push(grid);
      renderer.rebuildCache([grid]);
      scrubLayers = null;
      scrubIndex  = 0;
      playing = true;
      renderer.resumeOrbit();
      updateInfo(`Gen ${history.totalGenerations}  |  ${traits.ruleset}  |  ${N}×${N}  |  tile ${tileW}px`);
      syncUi();
    }

    simRef.current = { playPause, stepBack, stepFwd, scrubTo, restart };

    function onKey(e: KeyboardEvent) {
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

    // ── Main loop — always runs (orbit + pause glide animate every frame) ───

    const STEP_MS = 1000 / 8;
    let lastStep = 0;
    let raf = 0;
    let running = true;

    function loop(t: number) {
      if (!running) return;

      if (playing && t - lastStep >= STEP_MS) {
        grid = step(grid, ruleset);
        history.push(grid);
        renderer.commitLayer(grid);
        lastStep = t;
        updateInfo(`Gen ${history.totalGenerations}  |  ${traits.ruleset}  |  ${N}×${N}  |  tile ${tileW}px`);
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
    };
  }, []);

  return (
    // --accent feeds the scrubber thumb color from the active skin
    <div id="app" style={{ '--accent': FALLBACK_SKIN.accent } as CSSProperties}>
      <canvas ref={canvasRef} id="game-canvas" />
      <div id="ui-overlay">
        <div ref={infoRef} id="info-bar" />
        <Controls
          playing={ui.playing}
          scrubIndex={ui.scrubIndex}
          scrubMax={ui.scrubMax}
          genLabel={ui.genLabel}
          onPlayPause={() => simRef.current?.playPause()}
          onStepBack={() => simRef.current?.stepBack()}
          onStepFwd={() => simRef.current?.stepFwd()}
          onScrub={k => simRef.current?.scrubTo(k)}
          onRestart={() => simRef.current?.restart()}
        />
      </div>
    </div>
  );
}
