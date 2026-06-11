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
  // Rendered history is capped at `rows` layers (independent of historyDepth)
  // so the tower always reads as a perfect cube: rows × cols × rows.
  private visibleLayers: number;

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
  // Effective vertical frustum after aspect correction — equals frustumH in
  // landscape, grows in portrait so the tower width never gets clipped.
  private viewH: number;

  // Reusable scratch objects — avoid per-frame allocations
  private readonly _mat  = new THREE.Matrix4();
  private readonly _camPivot = new THREE.Vector3();
  // World Y of the live layer's top face — drives the height fog (see bodyMat)
  private readonly _towerTopY = { value: 1 };

  // Camera orbit — one full revolution every 90 s, same elevation as the
  // classic (1,1,1) iso view. The sun stays fixed in world space, so the
  // lit and shadowed sides drift past as the camera circles the tower.
  private static readonly ORBIT_SPEED = (2 * Math.PI) / 90; // rad/s
  private _camAngle = Math.PI / 4; // start at the classic iso corner
  private _lastFrameT = -1;        // performance.now() of the previous frame

  constructor(config: RendererConfig) {
    const { canvas, skin, tileWidth, rows, cols } = config;
    this.canvas        = canvas;
    this.skin          = skin;
    this.tileW         = tileWidth;
    this.visibleLayers = rows;

    // World units visible vertically — grid footprint fills ~60 % of height
    this.frustumH = (rows + cols) * 0.7;
    this.viewH    = this.frustumH; // corrected per-aspect in resize()

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
    // Height fog: the body material rewrites the fog input to "distance below
    // the tower top" (see bodyMat.onBeforeCompile), so near/far are in world-Y
    // units. Fade starts 30% down the cube and bottoms out just past its base.
    const towerH = rows; // visible tower = `rows` layers of unit cubes
    this.scene.fog = new THREE.Fog(
      new THREE.Color(skin.backgroundColor), towerH * 0.3 , towerH * 1.2 ,
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
    // Unit voxel — `rows` stacked layers form a rows × cols × rows cube
    const box = new THREE.BoxGeometry(1, 1, 1);

    // Worst case: every cell alive on every visible layer (64 B per Matrix4)
    this.maxHistoryInstances = Math.min(
      this.visibleLayers * rows * cols,
      Math.floor((192 * 1024 * 1024) / 64),
    );

    const bodyMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(skin.historyPalette.topFace),
      roughness: 0.82,
      metalness: 0.08,
    });
    // Distance fog reads view depth, which in an iso view varies diagonally
    // across the footprint instead of down the tower. Rewrite the fog input
    // to "distance below the tower top" so layers fade uniformly to the base.
    bodyMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTowerTopY = this._towerTopY;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uTowerTopY;',
        )
        .replace(
          '#include <fog_vertex>',
          `#ifdef USE_FOG
            vec4 twp = modelMatrix * instanceMatrix * vec4( transformed, 1.0 );
            vFogDepth = uTowerTopY - twp.y;
          #endif`,
        );
    };

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
      // fog: false — caps sit at the tower top and must stay full-bright;
      // the basic material isn't fog-patched, so default fog would wash it out.
      new THREE.MeshBasicMaterial({ color: new THREE.Color(skin.accent), fog: false }),
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

    // Trim the oldest layer once the cube is full — rendered history never
    // exceeds `rows` layers even when engine historyDepth is larger.
    if (this.layerInstanceCounts.length >= this.visibleLayers) {
      const removed = this.layerInstanceCounts.shift()!;
      const arr = this.historyMesh.instanceMatrix.array as Float32Array;
      arr.copyWithin(0, removed * 16);
      this.historyInstanceCount -= removed;
    }

    this.historyMesh.count = this.historyInstanceCount;
    // Upload only the used region — the buffer is sized for the worst case
    // and a full bufferSubData per commit would move hundreds of MB/s.
    const histAttr = this.historyMesh.instanceMatrix;
    histAttr.clearUpdateRanges();
    histAttr.addUpdateRange(0, this.historyInstanceCount * 16);
    histAttr.needsUpdate = true;

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
    // Advance the orbit by wall-clock time so speed is framerate-independent
    const now = performance.now();
    if (this._lastFrameT >= 0) {
      this._camAngle += ((now - this._lastFrameT) / 1000) * Renderer.ORBIT_SPEED;
    }
    this._lastFrameT = now;
    this._positionCamera();

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
    // The horizontal extent is viewH × aspect. frustumH is sized to the
    // tower's footprint width, so in landscape (aspect ≥ 1) it always fits.
    // In portrait the vertical frustum must grow so the horizontal extent
    // never shrinks below the footprint width (+8 % margin).
    const vh = aspect >= 1 ? this.frustumH : (this.frustumH * 1.08) / aspect;
    this.viewH = vh;
    this.camera.left   = -vh * aspect / 2;
    this.camera.right  =  vh * aspect / 2;
    this.camera.top    =  vh / 2;
    this.camera.bottom = -vh / 2;
    this.camera.updateProjectionMatrix();
    // Pivot placement depends on viewH — recenter on the current tower top
    this._trackCamera();
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
    const layerY = this.totalCommits + 0.5; // unit cube: layer i spans y ∈ [i, i+1]
    const capY   = layerY + 0.5 + 0.01;     // top face + z-fight epsilon
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
    const topY   = (this.totalCommits - 1) + 0.5; // live layer's cube center
    // Offset uses the aspect-corrected frustum so the tower top sits at the
    // same screen fraction in portrait and landscape alike.
    const pivotY = topY - this.viewH * 0.12;

    // Height-fog reference: world Y of the live layer's top face
    this._towerTopY.value = this.totalCommits;
    this._camPivot.set(0, pivotY, 0);
    this._positionCamera();

    // Sun rides along with the pivot so the shadow frustum always covers the
    // visible portion of the tower.
    this.sun.position.set(fh * 0.55, pivotY + fh * 1.1, fh * 0.3);
    this.sun.target.position.copy(this._camPivot);
    this.sun.target.updateMatrixWorld();
  }

  // Place the camera on the orbit circle around the current pivot, keeping
  // the elevation of the classic (1,1,1) iso view: for distance D the
  // vertical offset is D/√3 and the horizontal radius D·√(2/3).
  private _positionCamera(): void {
    const D = this.frustumH * 2;
    const R = D * Math.sqrt(2 / 3);
    this.camera.position.set(
      this._camPivot.x + R * Math.cos(this._camAngle),
      this._camPivot.y + D / Math.sqrt(3),
      this._camPivot.z + R * Math.sin(this._camAngle),
    );
    this.camera.lookAt(this._camPivot);
  }
}
