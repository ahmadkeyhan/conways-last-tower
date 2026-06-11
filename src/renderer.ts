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
//   • liveMesh     — body cubes of the current live layer, same dark material
//                    as history. Rebuilt each step; flushed into historyMesh
//                    when the next generation is committed.
//   • capMesh      — flat accent planes sitting on top of the live cubes.
//                    This is the only visual marker of the newest generation.
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
  private liveMesh: THREE.InstancedMesh;
  private capMesh: THREE.InstancedMesh;
  private sun: THREE.DirectionalLight;
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
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.15;
    // The scene only changes when a generation commits (~12/s), not every RAF
    // frame — render the shadow map on demand in commitLayer, not per frame.
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.gl.shadowMap.autoUpdate = false;

    // ── Scene ─────────────────────────────────────────────────────────────
    const fh = this.frustumH;
    const D  = fh * 2; // camera distance from pivot along the iso axis
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(skin.backgroundColor);
    // Lower layers sit farther from the ortho camera — fog fades the tower
    // base into the background for a cheap depth cue.
    this.scene.fog = new THREE.Fog(
      new THREE.Color(skin.backgroundColor), D + fh * 0.4, D + fh * 1.6,
    );

    // ── Camera ────────────────────────────────────────────────────────────
    this.camera = new THREE.OrthographicCamera(
      -fh / 2, fh / 2,   // left / right (will be fixed by resize)
       fh / 2, -fh / 2,  // top / bottom
      -2000, 2000,
    );
    this.camera.position.set(D, D, D);
    this.camera.lookAt(0, 0, 0);

    // ── Lighting ──────────────────────────────────────────────────────────
    // Hemisphere ambient: cool sky / dark ground for soft color variation.
    this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x16161c, 0.55));

    // Warm key light from the upper right — casts the soft cube shadows.
    // Position and target follow the tower top (see _trackCamera).
    const sun = new THREE.DirectionalLight(0xfff1dd, 1.7);
    sun.position.set(fh * 0.55, fh * 1.1, fh * 0.3);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const ext = fh * 0.9;
    sun.shadow.camera.left   = -ext;
    sun.shadow.camera.right  =  ext;
    sun.shadow.camera.top    =  ext;
    sun.shadow.camera.bottom = -ext;
    sun.shadow.camera.near   = 1;
    sun.shadow.camera.far    = fh * 5;
    sun.shadow.bias       = -0.0002;
    sun.shadow.normalBias = 0.05;
    this.sun = sun;
    this.scene.add(sun, sun.target);

    // ── Geometry & meshes ─────────────────────────────────────────────────
    // Flat voxel: 1 unit wide, 0.5 units tall, 1 unit deep
    const box = new THREE.BoxGeometry(1, 0.5, 1);

    // Cap instance buffer at 100 MB (each Matrix4 = 64 bytes)
    this.maxHistoryInstances = Math.min(
      historyDepth * rows * cols,
      Math.floor((100 * 1024 * 1024) / 64),
    );

    const bodyMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(skin.historyPalette.topFace),
      roughness: 0.82,
      metalness: 0.08,
    });

    this.historyMesh = new THREE.InstancedMesh(box, bodyMat, this.maxHistoryInstances);
    this.historyMesh.count = 0;
    this.historyMesh.castShadow    = true;
    this.historyMesh.receiveShadow = true;

    // Live layer body — identical dark cubes; flushed into historyMesh on commit
    this.liveMesh = new THREE.InstancedMesh(box, bodyMat, rows * cols);
    this.liveMesh.count = 0;
    this.liveMesh.castShadow    = true;
    this.liveMesh.receiveShadow = true;

    // Accent cap — flat plane resting on each live cube's top face.
    // MeshBasicMaterial: flat unlit accent, matching the old 2D cap diamond.
    const capPlane = new THREE.PlaneGeometry(1, 1);
    capPlane.rotateX(-Math.PI / 2); // lie flat, facing +Y
    this.capMesh = new THREE.InstancedMesh(
      capPlane,
      new THREE.MeshBasicMaterial({ color: new THREE.Color(skin.accent) }),
      rows * cols,
    );
    this.capMesh.count = 0;

    // Bounding spheres are computed once from initial instance positions and
    // go stale as the tower grows — the camera rises past them and Three.js
    // culls the entire mesh. The camera always faces the tower, so skip culling.
    this.historyMesh.frustumCulled = false;
    this.liveMesh.frustumCulled    = false;
    this.capMesh.frustumCulled     = false;

    this.scene.add(this.historyMesh, this.liveMesh, this.capMesh);
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

    // Geometry and light moved — re-render the shadow map on the next frame
    // (shadowMap.autoUpdate is off; this is the only place the scene changes).
    this.gl.shadowMap.needsUpdate = true;
  }

  // Rebuild the full cache from a layers array (timeline scrubber).
  rebuildCache(layers: Grid[]): void {
    this.historyMesh.count    = 0;
    this.historyInstanceCount = 0;
    this.layerInstanceCounts  = [];
    this.totalCommits         = 0;
    this.liveMesh.count       = 0;
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

  // Copy the live-layer body instances into the historyMesh buffer as a frozen
  // layer. Uses a single typed-array set() — no per-instance JS overhead.
  private _flushCap(): void {
    const n = this.liveMesh.count;
    if (n === 0) return;
    if (this.historyInstanceCount + n > this.maxHistoryInstances) return;

    const src = this.liveMesh.instanceMatrix.array as Float32Array;
    const dst = this.historyMesh.instanceMatrix.array as Float32Array;
    dst.set(src.subarray(0, n * 16), this.historyInstanceCount * 16);

    this.layerInstanceCounts.push(n);
    this.historyInstanceCount += n;
  }

  // Write instance matrices for every non-dead cell in grid into liveMesh
  // (dark body cube) and capMesh (accent plane on its top face).
  // makeTranslation is faster than Object3D.updateMatrix (no quaternion path).
  private _buildCap(grid: Grid): void {
    const { rows, cols, data } = grid;
    const layerY = this.totalCommits * 0.5 + 0.25;
    const capY   = layerY + 0.25 + 0.01; // top of the 0.5-tall box + z-fight epsilon
    let count = 0;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (data[r * cols + c] === 0) continue;
        const x = c - cols / 2 + 0.5;
        const z = r - rows / 2 + 0.5;
        this._mat.makeTranslation(x, layerY, z);
        this.liveMesh.setMatrixAt(count, this._mat);
        this._mat.makeTranslation(x, capY, z);
        this.capMesh.setMatrixAt(count, this._mat);
        count++;
      }
    }
    this.liveMesh.count = count;
    this.liveMesh.instanceMatrix.needsUpdate = true;
    this.capMesh.count = count;
    this.capMesh.instanceMatrix.needsUpdate = true;
  }

  // Keep the top layer at ~35 % from the top of the viewport by moving the
  // camera pivot — the (1,1,1) look direction is always preserved.
  private _trackCamera(): void {
    const fh     = this.frustumH;
    const topY   = (this.totalCommits - 1) * 0.5 + 0.25;
    const pivotY = topY - fh * 0.12;
    this._camPivot.set(0, pivotY, 0);
    this.camera.position.copy(this._camPivot).addScaledVector(this._isoDir, fh * 2);
    this.camera.lookAt(this._camPivot);

    // Sun rides along with the pivot so the shadow frustum always covers the
    // visible portion of the tower.
    this.sun.position.set(fh * 0.55, pivotY + fh * 1.1, fh * 0.3);
    this.sun.target.position.copy(this._camPivot);
    this.sun.target.updateMatrixWorld();
  }
}
