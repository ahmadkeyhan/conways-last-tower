import * as THREE from 'three';
import type { Grid } from './engine';
import type { Skin } from './skin';

// ── Public config ─────────────────────────────────────────────────────────────

export type RendererConfig = {
  canvas: HTMLCanvasElement;
  skin: Skin;
  tileWidth: number;
  rows: number;
  cols: number;
  historyDepth: number;
};

// Kept for interaction.ts pixel → grid-cell hit-testing.
export function toIso(
  col: number, row: number, z: number, tw: number,
): { x: number; y: number } {
  return {
    x: (col - row) * (tw / 2),
    y: (col + row) * (tw / 4) - z * (tw / 2),
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────
//
// Architecture:
//   • historyMesh  — InstancedMesh that accumulates all frozen layers.
//                    Instances are appended once (in _flushCap) and only
//                    removed when the history window is trimmed (O(1) copyWithin).
//   • capMesh      — InstancedMesh rebuilt each step with the current live layer.
//                    The accent color makes it visually distinct from history.
//
// Coordinate system:
//   x = col − cols/2 + 0.5
//   y = layerIndex × 0.5 + 0.25   (boxes are 0.5 units tall, stacked flush)
//   z = row − rows/2 + 0.5
//
// The OrthographicCamera sits at (1,1,1)-normalised × D from the pivot so the
// scene renders in classic isometric projection.  The pivot follows the top
// layer so it stays at ~35 % from the top of the viewport.

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  skin: Skin;
  tileW: number;
  private historyDepth: number;

  private gl: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.OrthographicCamera;
  private historyMesh: THREE.InstancedMesh;
  private capMesh: THREE.InstancedMesh;
  private maxHistoryInstances: number;

  // Running counts — updated in commitLayer / _flushCap
  private historyInstanceCount = 0;
  private layerInstanceCounts: number[] = [];
  private totalCommits = 0;
  private frustumH: number;

  // Reusable scratch objects — avoid per-frame allocations
  private readonly _mat  = new THREE.Matrix4();
  private readonly _camPivot = new THREE.Vector3();
  // (1,1,1)-normalised direction, stable across frames
  private readonly _isoDir = new THREE.Vector3(1, 1, 1).normalize();

  constructor(config: RendererConfig) {
    const { canvas, skin, tileWidth, rows, cols, historyDepth } = config;
    this.canvas       = canvas;
    this.skin         = skin;
    this.tileW        = tileWidth;
    this.historyDepth = historyDepth;

    // World units visible vertically — grid footprint fills ~60 % of height
    this.frustumH = (rows + cols) * 0.7;

    // ── WebGL renderer ────────────────────────────────────────────────────
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // ── Scene ─────────────────────────────────────────────────────────────
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(skin.backgroundColor);

    // ── Camera ────────────────────────────────────────────────────────────
    const fh = this.frustumH;
    this.camera = new THREE.OrthographicCamera(
      -fh / 2, fh / 2,   // left / right (will be fixed by resize)
       fh / 2, -fh / 2,  // top / bottom
      -2000, 2000,
    );
    const D = fh * 2;
    this.camera.position.set(D, D, D);
    this.camera.lookAt(0, 0, 0);

    // ── Lighting — directional from upper-right for natural 3-face shading ─
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const sun = new THREE.DirectionalLight(0xffffff, 0.9);
    sun.position.set(3, 5, 2);
    this.scene.add(sun);

    // ── Geometry & meshes ─────────────────────────────────────────────────
    // Flat voxel: 1 unit wide, 0.5 units tall, 1 unit deep
    const box = new THREE.BoxGeometry(1, 0.5, 1);

    // Cap instance buffer at 100 MB (each Matrix4 = 64 bytes)
    this.maxHistoryInstances = Math.min(
      historyDepth * rows * cols,
      Math.floor((100 * 1024 * 1024) / 64),
    );

    this.historyMesh = new THREE.InstancedMesh(
      box,
      new THREE.MeshLambertMaterial({ color: new THREE.Color(skin.historyPalette.topFace) }),
      this.maxHistoryInstances,
    );
    this.historyMesh.count = 0;

    this.capMesh = new THREE.InstancedMesh(
      box,
      new THREE.MeshLambertMaterial({ color: new THREE.Color(skin.accent) }),
      rows * cols,
    );
    this.capMesh.count = 0;

    this.scene.add(this.historyMesh, this.capMesh);
  }

  // ── commitLayer ─────────────────────────────────────────────────────────────
  // Called once per generation at step cadence (same as history.push).

  commitLayer(grid: Grid): void {
    // Freeze the outgoing cap into the history mesh
    this._flushCap();

    // Trim oldest history layer when the window is full
    if (this.layerInstanceCounts.length >= this.historyDepth) {
      const removed = this.layerInstanceCounts.shift()!;
      const arr = this.historyMesh.instanceMatrix.array as Float32Array;
      arr.copyWithin(0, removed * 16);
      this.historyInstanceCount -= removed;
    }

    this.historyMesh.count = this.historyInstanceCount;
    this.historyMesh.instanceMatrix.needsUpdate = true;

    // Build the new cap for the incoming grid
    this._buildCap(grid);

    this.totalCommits++;
    this._trackCamera();
  }

  // Rebuild the full cache from a layers array (timeline scrubber).
  rebuildCache(layers: Grid[]): void {
    this.historyMesh.count    = 0;
    this.historyInstanceCount = 0;
    this.layerInstanceCounts  = [];
    this.totalCommits         = 0;
    this.capMesh.count        = 0;
    for (const g of layers) this.commitLayer(g);
  }

  // ── render ──────────────────────────────────────────────────────────────────
  // Called every RAF frame — just dispatches to WebGL.

  render(): void {
    this.gl.render(this.scene, this.camera);
  }

  // Single-layer preview (stamp preview / scrubber hover).
  drawLayer(grid: Grid, _z: number): void {
    this._buildCap(grid);
    this.gl.render(this.scene, this.camera);
  }

  resize(width: number, height: number): void {
    this.gl.setSize(width, height, false);
    const aspect = width / height;
    const fh = this.frustumH;
    this.camera.left   = -fh * aspect / 2;
    this.camera.right  =  fh * aspect / 2;
    this.camera.top    =  fh / 2;
    this.camera.bottom = -fh / 2;
    this.camera.updateProjectionMatrix();
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  // Copy the current capMesh instances into the historyMesh buffer as a frozen layer.
  // Uses a single typed-array set() — no per-instance JS overhead.
  private _flushCap(): void {
    const n = this.capMesh.count;
    if (n === 0) return;
    if (this.historyInstanceCount + n > this.maxHistoryInstances) return;

    const src = this.capMesh.instanceMatrix.array as Float32Array;
    const dst = this.historyMesh.instanceMatrix.array as Float32Array;
    dst.set(src.subarray(0, n * 16), this.historyInstanceCount * 16);

    this.layerInstanceCounts.push(n);
    this.historyInstanceCount += n;
  }

  // Write instance matrices for every non-dead cell in grid into capMesh.
  // makeTranslation is faster than Object3D.updateMatrix (no quaternion path).
  private _buildCap(grid: Grid): void {
    const { rows, cols, data } = grid;
    const layerY = this.totalCommits * 0.5 + 0.25;
    let count = 0;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (data[r * cols + c] === 0) continue;
        this._mat.makeTranslation(c - cols / 2 + 0.5, layerY, r - rows / 2 + 0.5);
        this.capMesh.setMatrixAt(count++, this._mat);
      }
    }
    this.capMesh.count = count;
    this.capMesh.instanceMatrix.needsUpdate = true;
  }

  // Keep the top layer at ~35 % from the top of the viewport by moving the
  // camera pivot — the (1,1,1) look direction is always preserved.
  private _trackCamera(): void {
    const topY   = (this.totalCommits - 1) * 0.5 + 0.25;
    const pivotY = topY - this.frustumH * 0.12;
    const D      = this.frustumH * 2;
    this._camPivot.set(0, pivotY, 0);
    this.camera.position.copy(this._camPivot).addScaledVector(this._isoDir, D);
    this.camera.lookAt(this._camPivot);
  }
}
