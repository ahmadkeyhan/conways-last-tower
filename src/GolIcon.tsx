import { useEffect, useRef } from 'react';
import { createGrid, step, RULESETS } from './engine';
import { SIZE } from './iconEngine';

// 24×24 GoL icon. Resting = the seed. On hover, run Classic Life live and
// forever (one step / frame @ 12 fps — cheap on a 24×24 torus). Color follows
// the button's CSS `color`, so the hover → accent rule tints the icon.

const FPS = 12;
const FRAME_MS = 1000 / FPS;

export type GolIconProps = {
  seed: Uint8Array;          // SIZE*SIZE of 0/1 (resting icon + Life seed)
  title: string;
  onClick: () => void;
  disabled?: boolean;
};

export default function GolIcon({ seed, title, onClick, disabled }: GolIconProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;

    const draw = (cells: Uint8Array) => {
      ctx.clearRect(0, 0, SIZE*8, SIZE*8);
      ctx.fillStyle = getComputedStyle(canvas).color; // currentColor equivalent
      
      for (let i = 0; i < cells.length; i++) {
        if (cells[i]) {
          ctx.beginPath()
          ctx.arc((i % SIZE) * 8 + 0.5, (i / SIZE) * 8 + 0.5 | 0, 3.5, 0, 2* Math.PI);
          ctx.fill()
        }
      }
      
    };

    draw(seed);

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let raf = 0;
    let buf = createGrid(SIZE, SIZE);
    let last = 0;
    let acc = 0;

    const tick = (t: number) => {
      if (last) acc += t - last;
      last = t;
      while (acc >= FRAME_MS) {
        acc -= FRAME_MS;
        buf = step(buf, RULESETS.classic);
        draw(buf.data);
      }
      raf = requestAnimationFrame(tick);
    };

    const start = () => {
      if (raf) return;
      buf = createGrid(SIZE, SIZE);
      buf.data.set(seed);        // restart Life from the seed each hover
      last = 0; acc = 0;
      raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      draw(seed);                // snap back to the resting seed
    };

    const parent = canvas.parentElement!;
    parent.addEventListener('pointerenter', start);
    parent.addEventListener('pointerleave', stop);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      parent.removeEventListener('pointerenter', start);
      parent.removeEventListener('pointerleave', stop);
    };
  }, [seed]);

  return (
    <button type="button" className="gol-icon" title={title} onClick={onClick} disabled={disabled}>
      <canvas ref={canvasRef} width={SIZE*8} height={SIZE*8} aria-hidden="true" />
    </button>
  );
}
