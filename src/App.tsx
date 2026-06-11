import { useEffect, useRef } from 'react';
import { createGrid, randomizeGrid, step, History, RULESETS } from './engine';
import { Renderer } from './renderer';
import { FALLBACK_SKIN } from './skin';
import { initFx } from './fxhash';

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const infoRef   = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;

    const { rng, traits } = initFx();
    const ruleset = RULESETS[traits.ruleset];
    const N = traits.gridSize;

    const history = new History(traits.historyDepth);
    let grid = randomizeGrid(createGrid(N, N), 0.35, rng);
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

    const STEP_MS = 1000 / 24;
    let lastStep = 0;
    let raf = 0;
    let running = true;

    function loop(t: number) {
      if (!running) return;

      if (t - lastStep >= STEP_MS) {
        grid = step(grid, ruleset);
        history.push(grid);
        renderer.commitLayer(grid);   // render body to OffscreenCanvas once
        lastStep = t;

        if (infoRef.current) {
          infoRef.current.textContent =
            `Gen ${history.totalGenerations}  |  ${traits.ruleset}  |  ${N}×${N}  |  tile ${tileW}px`;
        }
      }

      renderer.render();              // blit cached bodies + draw live cap
      raf = requestAnimationFrame(loop);
    }

    raf = requestAnimationFrame(loop);

    return () => {
      running = false;
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
