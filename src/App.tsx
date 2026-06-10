import { useEffect, useRef } from 'react';
import { createGrid, randomizeGrid, step, History, RULESETS } from './engine';
import { Renderer } from './renderer';
import { FALLBACK_SKIN } from './skin';
import { initFx } from './fxhash';

export default function App() {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const infoRef    = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;

    // ── Init from fxHash / dev shim ──────────────────────────────────────────
    const { rng, traits } = initFx();
    const ruleset = RULESETS[traits.ruleset];

    // ── Initial grid ─────────────────────────────────────────────────────────
    const N = traits.gridSize;
    const history = new History(traits.historyDepth);
    let grid = randomizeGrid(createGrid(N, N), 0.35, rng);
    history.push(grid);

    // ── Renderer ─────────────────────────────────────────────────────────────
    // Scale tile size so the grid fits within ~70% of the viewport width
    const tileW = Math.min(32, Math.max(4, Math.floor((window.innerWidth * 0.7) / N)));

    const renderer = new Renderer({ canvas, skin: FALLBACK_SKIN, tileWidth: tileW });

    function resize() {
      renderer.resize(window.innerWidth, window.innerHeight);
    }
    resize();
    window.addEventListener('resize', resize);

    // ── Simulation loop ───────────────────────────────────────────────────────
    const STEP_MS = 120; // ~8 generations/second
    let lastStep = 0;
    let raf = 0;
    let alive = true;

    function loop(t: number) {
      if (!alive) return;

      if (t - lastStep >= STEP_MS) {
        grid = step(grid, ruleset);
        history.push(grid);
        lastStep = t;

        if (infoRef.current) {
          infoRef.current.textContent =
            `Gen ${history.totalGenerations}  |  ${traits.ruleset}  |  ${N}×${N}  |  tile ${tileW}px`;
        }
      }

      renderer.render(history.toArray(), history.totalGenerations - 1);
      raf = requestAnimationFrame(loop);
    }

    raf = requestAnimationFrame(loop);

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <div id="app">
      <canvas ref={canvasRef} id="game-canvas" />
      <div id="ui-overlay">
        <div ref={infoRef} id="info-bar" />
      </div>
    </div>
  );
}
