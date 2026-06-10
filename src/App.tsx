import { useRef } from 'react';

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  return (
    <div id="app">
      <canvas
        ref={canvasRef}
        id="game-canvas"
        width={window.innerWidth}
        height={window.innerHeight}
      />
      <div id="ui-overlay" />
    </div>
  );
}
