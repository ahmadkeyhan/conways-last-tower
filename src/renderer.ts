import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Grid } from './engine';
import type { Skin } from './skin';
import type { ShapeKind } from './rarity';

// ── Public config ─────────────────────────────────────────────────────────────

export type RendererConfig = {
  canvas: HTMLCanvasElement;
  skin: Skin;
  tileWidth: number;
  rows: number;
  cols: number;
  historyDepth: number;
  shape: ShapeKind;
};

// ── Per-cube noise coloring ───────────────────────────────────────────────────
//
// Every cube is one solid color, but a NOISE_RATIO fraction of them use the
// skin's noise color instead of the main color — the tower reads as speckled
// blocks rather than a solid mass.
//
// The choice is a deterministic position hash, not an rng: a cell's color
// must be stable across rebuilds (paint strokes rebuild the live layer, the
// scrubber rebuilds whole towers — an rng would reshuffle colors and shimmer).

const NOISE_RATIO = 0.35; // fraction of cubes tinted with the noise color

function cellNoise(row: number, col: number, layer: number, salt: number): boolean {
  let h = (row * 73856093) ^ (col * 19349663) ^ (layer * 83492791) ^ salt;
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  return ((h ^ (h >>> 15)) >>> 0) / 0xffffffff < NOISE_RATIO;
}

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
  private rows: number;
  private cols: number;
  // Rendered history is capped at `rows` layers (independent of historyDepth)
  // so the tower always reads as a perfect cube: rows × cols × rows.
  private visibleLayers: number;

  private gl: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.OrthographicCamera;
  private historyMesh: THREE.InstancedMesh;
  private liveMesh: THREE.InstancedMesh;
  private capMesh: THREE.InstancedMesh;
  private ghostMesh: THREE.InstancedMesh;
  private ground: THREE.Mesh;
  private editGrid: THREE.GridHelper;
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

  // Pre-parsed skin colors for per-cube noise coloring
  private readonly _towerMain:   THREE.Color;
  private readonly _towerNoise:  THREE.Color;
  private readonly _accentMain:  THREE.Color;
  private readonly _accentNoise: THREE.Color;
  // Brian's Brain dying cells (state 2) — a dim, desaturated tone that's
  // distinct from both the tower body and the bright accent caps. The cap gets
  // the brighter base tone; the cube a darkened version (fading embers).
  private readonly _dyingColor:  THREE.Color; // cube body
  private readonly _dyingCap:    THREE.Color; // top-face cap

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
  // While paused, the orbit eases to this angle instead of advancing
  private _angleTarget: number | null = null;
  // Paused framing (portrait only): eases 0→1 on pause, 1→0 on resume.
  // At 1 the view is zoomed out ~18 % and slid left to clear the scrubber.
  private _pausedAmt = 0;
  private _pausedTarget = 0;
  private _aspect = 1;
  // Edit view: eases 0→1 entering edit mode (camera rises to top-down), back
  // to 0 on resume. Interpolated inside _positionCamera.
  private _editAmt = 0;
  private _editTarget = 0;

  // Per-cell noise / prismatic scratch — reused across cells (no per-cell alloc)
  private readonly _hsl = { h: 0, s: 0, l: 0 };
  private readonly _bodyScratch = new THREE.Color();
  private readonly _capScratch  = new THREE.Color();
  private readonly _white = new THREE.Color(1, 0.84, 0); // chrome caps: PBR does the work
  // Sphere caps enclose the body sphere (concentric) rather than sit on top.
  private readonly _capAtCenter: boolean;

  // Picking scratch objects (pickCell) — reused across calls
  private readonly _raycaster = new THREE.Raycaster();
  private readonly _ndc       = new THREE.Vector2();
  private readonly _pickPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly _hitV3     = new THREE.Vector3();

  constructor(config: RendererConfig) {
    const { canvas, skin, tileWidth, rows, cols } = config;
    this.canvas        = canvas;
    this.skin          = skin;
    this.tileW         = tileWidth;
    this.rows          = rows;
    this.cols          = cols;
    this.visibleLayers = rows;

    this._towerMain   = new THREE.Color(skin.towerColor);
    this._towerNoise  = new THREE.Color(skin.towerNoiseColor);
    this._accentMain  = new THREE.Color(skin.accentColor);
    this._accentNoise = new THREE.Color(skin.accentNoiseColor);
    // Dying cells (Brian's Brain) use the skin's triadic dying hue — unrelated
    // to tower or accent. Cap uses it as-is; the cube is darkened (fading embers).
    const dying = new THREE.Color(skin.dyingColor);
    this._dyingCap    = dying;
    this._dyingColor  = dying.clone().multiplyScalar(0.7);

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
    this.scene.add(new THREE.HemisphereLight(0xbfbfbf, 0x161616, 0.55));

    // Warm key light from the upper right — casts the soft cube shadows.
    // Position and target follow the tower top (see _trackCamera).
    const sun = new THREE.DirectionalLight(0xffffff, 1.7);
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
    // Unit voxel by Shape trait — kept low-poly for the millions-of-instances
    // budget. `rows` stacked layers form a rows × cols × rows tower.
    const shape = config.shape;
    const box =
      shape === 'cylinder' ? new THREE.CylinderGeometry(0.5, 0.5, 1, 12)
      : shape === 'sphere'  ? new THREE.IcosahedronGeometry(0.5, 1)
      : new THREE.BoxGeometry(1, 1, 1);
    // Sphere: the cap is a slightly larger concentric accent shell (the newest
    // layer's spheres glow accent), not a plate on top.
    this._capAtCenter = shape === 'sphere';

    // Worst case: every cell alive on every visible layer (64 B per Matrix4)
    this.maxHistoryInstances = Math.min(
      this.visibleLayers * rows * cols,
      Math.floor((192 * 1024 * 1024) / 64),
    );

    // Tower body — white base color so per-instance colors show true
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.82,
      metalness: 0.08,
    });
    // Distance fog reads view depth, which in an iso view varies diagonally
    // across the footprint instead of down the tower. Rewrite the fog input
    // to "distance below the tower top" so layers fade uniformly to the base.
    this._patchHeightFog(bodyMat, true);

    this.historyMesh = new THREE.InstancedMesh(box, bodyMat, this.maxHistoryInstances);
    this.historyMesh.count = 0;
    this.historyMesh.castShadow    = true;
    this.historyMesh.receiveShadow = true;
    // Allocate instance colors up front so the shader compiles with
    // instance-color support from the first frame.
    this.historyMesh.instanceColor =
      new THREE.InstancedBufferAttribute(new Float32Array(this.maxHistoryInstances * 3), 3);

    // Live layer body — identical cubes; flushed into historyMesh on commit
    this.liveMesh = new THREE.InstancedMesh(box, bodyMat, rows * cols);
    this.liveMesh.count = 0;
    this.liveMesh.castShadow    = true;
    this.liveMesh.receiveShadow = true;
    this.liveMesh.instanceColor =
      new THREE.InstancedBufferAttribute(new Float32Array(rows * cols * 3), 3);

    // Accent cap — geometry follows the Shape trait:
    //   cube     → square plane on the top face
    //   cylinder → circle plane on the top face (matches the round top)
    //   sphere   → concentric shell, slightly larger than the body sphere, so the
    //              newest layer reads as accent-colored spheres
    let capPlane: THREE.BufferGeometry;
    if (shape === 'cylinder') {
      capPlane = new THREE.CircleGeometry(0.5, 24).rotateX(-Math.PI / 2);
    } else if (shape === 'sphere') {
      capPlane = new THREE.IcosahedronGeometry(0.52, 1);
    } else {
      capPlane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2); // lie flat, facing +Y
    }
    // Chrome accent → reflective PBR caps (need an env map to reflect something);
    // every other accent → flat unlit caps carrying per-instance colors.
    // fog: false — caps sit at the tower top and must stay full-bright.
    let capMat: THREE.Material;
    if (skin.accentMode === 'metallic') {
      const pmrem = new THREE.PMREMGenerator(this.gl);
      const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      pmrem.dispose();
      capMat = new THREE.MeshStandardMaterial({
        color: 0xffffff, metalness: 1.0, roughness: 0.16,
        envMap: envTex, envMapIntensity: 1.5, fog: false,
      });
    } else {
      // White base color — per-instance colors carry the accent/noise mix.
      capMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.82,
      metalness: 0.08,
      fog: false
    });
    }
    this.capMesh = new THREE.InstancedMesh(capPlane, capMat, rows * cols);
    this.capMesh.count = 0;
    this.capMesh.instanceColor =
      new THREE.InstancedBufferAttribute(new Float32Array(rows * cols * 3), 3);

    // Stamp ghost — translucent accent planes previewing a stamp placement
    // (edit mode). Flat square regardless of Shape — it's a placement indicator.
    const ghostPlane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.ghostMesh = new THREE.InstancedMesh(
      ghostPlane,
      // Flat translucent accent — it's a placement preview, no texture
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(skin.accentColor),
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
        fog: false,
      }),
      rows * cols,
    );
    this.ghostMesh.count = 0;

    // Edit-mode grid — cell boundaries on the canvas plane. Fades in with the
    // top-down glide (opacity tracks _editAmt in render); rides the live
    // layer's top face via _trackCamera.
    this.editGrid = new THREE.GridHelper(
      rows, rows, new THREE.Color(skin.gridColor), new THREE.Color(skin.gridColor),
    );
    {
      const mat = this.editGrid.material as THREE.LineBasicMaterial;
      mat.transparent = true;
      mat.opacity     = 0;
      // Not fog-patched (see capMesh note) — default depth fog would hide it
      mat.fog         = false;
    }
    this.editGrid.visible = false;

    // ── Ground plane ──────────────────────────────────────────────────────
    // A flat slab at y = 0, twice the grid footprint, so the tower reads as
    // rising out of solid ground. Shares the height-fog patch (non-instanced
    // variant): as the tower grows, the ground sinks below the fog band and
    // dissolves into the cloud-colored haze — the tower climbs past the clouds.
    const groundGeo = new THREE.BoxGeometry(cols * 1.37, rows * 1.37,cols*2);
    groundGeo.rotateX(-Math.PI / 2); // lie flat, facing +Y
    const groundMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(skin.groundColor),
      roughness: 0.95,
      metalness: 0.0,
    });
    this._patchHeightFog(groundMat, false);
    this.ground = new THREE.Mesh(groundGeo, groundMat);
    this.ground.position.y = -1 * cols;
    this.ground.receiveShadow = true;
    this.ground.frustumCulled = false;

    // Bounding spheres are computed once from initial instance positions and
    // go stale as the tower grows — the camera rises past them and Three.js
    // culls the entire mesh. The camera always faces the tower, so skip culling.
    this.historyMesh.frustumCulled = false;
    this.liveMesh.frustumCulled    = false;
    this.capMesh.frustumCulled     = false;
    this.ghostMesh.frustumCulled   = false;
    this.editGrid.frustumCulled    = false;

    this.scene.add(
      this.ground,
      this.historyMesh, this.liveMesh, this.capMesh, this.ghostMesh, this.editGrid,
    );
  }

  // Rewrite a material's fog input to "distance below the tower top" so the
  // scene fades uniformly down the tower (not diagonally by view depth).
  // instanced=true multiplies by instanceMatrix (InstancedMesh); false uses
  // the plain model matrix (the ground plane).
  private _patchHeightFog(material: THREE.Material, instanced: boolean): void {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTowerTopY = this._towerTopY;
      const worldPos = instanced
        ? 'modelMatrix * instanceMatrix * vec4( transformed, 1.0 )'
        : 'modelMatrix * vec4( transformed, 1.0 )';
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uTowerTopY;',
        )
        .replace(
          '#include <fog_vertex>',
          `#ifdef USE_FOG
            vec4 twp = ${worldPos};
            vFogDepth = uTowerTopY - twp.y;
          #endif`,
        );
    };
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
      const carr = this.historyMesh.instanceColor!.array as Float32Array;
      carr.copyWithin(0, removed * 3);
      this.historyInstanceCount -= removed;
    }

    this.historyMesh.count = this.historyInstanceCount;
    // Upload only the used region — the buffer is sized for the worst case
    // and a full bufferSubData per commit would move hundreds of MB/s.
    const histAttr = this.historyMesh.instanceMatrix;
    histAttr.clearUpdateRanges();
    histAttr.addUpdateRange(0, this.historyInstanceCount * 16);
    histAttr.needsUpdate = true;
    const histColor = this.historyMesh.instanceColor!;
    histColor.clearUpdateRanges();
    histColor.addUpdateRange(0, this.historyInstanceCount * 3);
    histColor.needsUpdate = true;

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
    const dt  = this._lastFrameT >= 0 ? (now - this._lastFrameT) / 1000 : 0;
    this._lastFrameT = now;

    if (this._angleTarget === null) {
      this._camAngle += dt * Renderer.ORBIT_SPEED;
    } else {
      // Paused: ease into the nearest iso corner with exponential damping
      const diff = this._angleTarget - this._camAngle;
      this._camAngle = Math.abs(diff) < 0.0005
        ? this._angleTarget
        : this._camAngle + diff * Math.min(1, dt * 5);
    }
    this._positionCamera();

    // Ease the paused framing (portrait zoom-out + slide) with the same damping
    const fDiff = this._pausedTarget - this._pausedAmt;
    if (fDiff !== 0) {
      this._pausedAmt = Math.abs(fDiff) < 0.001
        ? this._pausedTarget
        : this._pausedAmt + fDiff * Math.min(1, dt * 5);
      this._applyProjection();
    }

    // Ease the edit view elevation (iso orbit ↔ top-down); _positionCamera
    // above already consumed the updated value on the next frame.
    const eDiff = this._editTarget - this._editAmt;
    if (eDiff !== 0) {
      this._editAmt = Math.abs(eDiff) < 0.001
        ? this._editTarget
        : this._editAmt + eDiff * Math.min(1, dt * 5);
      // Edit grid fades in/out with the glide
      this.editGrid.visible = this._editAmt > 0.01;
      (this.editGrid.material as THREE.LineBasicMaterial).opacity =
        0.22 * this._editAmt;
    }

    this.gl.render(this.scene, this.camera);
  }

  // Pause the orbit and glide to the nearest isometric corner (45° + k·90°).
  // resumeOrbit continues the rotation from wherever the camera settled.
  pauseOrbit(): void {
    this._angleTarget =
      Math.round((this._camAngle - Math.PI / 4) / (Math.PI / 2)) * (Math.PI / 2)
      + Math.PI / 4;
    this._pausedTarget = 1;
  }

  resumeOrbit(): void {
    this._angleTarget  = null;
    this._pausedTarget = 0;
    this._editTarget   = 0;
  }

  // Static preview/capture frame: hide the ground, freeze the camera at the
  // classic isometric corner (no orbit, no edit/paused offsets), render once.
  renderCapture(): void {
    this.ground.visible = false;
    this._angleTarget = null;
    this._camAngle    = Math.PI / 4; // classic isometric corner
    this._editAmt = this._editTarget = 0;
    this._pausedAmt = this._pausedTarget = 0;
    this._applyProjection();
    this._trackCamera();
    this.gl.shadowMap.needsUpdate = true;
    this.gl.render(this.scene, this.camera);
  }

  // Edit mode camera: glide to a top-down view with the grid axis-aligned on
  // screen (angle snaps to k·90°, not the iso corner — squares, not diamonds).
  // Reuses the paused framing so the canvas clears the right-edge panel.
  // `instant` snaps the view (no glide) — used when a fresh renderer is built
  // after a grid-size change while already in edit mode.
  setEditView(active: boolean, instant = false): void {
    if (active) {
      this._editTarget   = 1;
      this._pausedTarget = 1;
      this._angleTarget  =
        Math.round(this._camAngle / (Math.PI / 2)) * (Math.PI / 2);
      if (instant) {
        this._editAmt   = 1;
        this._pausedAmt = 1;
        this._camAngle  = this._angleTarget;
        this.editGrid.visible = true;
        (this.editGrid.material as THREE.LineBasicMaterial).opacity = 0.22;
        this._applyProjection();
        this._trackCamera();
      }
    } else {
      this._editTarget = 0;
    }
  }

  // Release all GPU resources so a new Renderer can be built on the same canvas
  // (grid-size change). The WebGL context itself is reused by the next renderer.
  dispose(): void {
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = (mesh as { material?: THREE.Material | THREE.Material[] }).material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) mat.dispose();
    });
    this.gl.dispose();
  }

  // Single-layer preview (stamp preview / scrubber hover).
  drawLayer(grid: Grid, _z: number): void {
    this._buildCap(grid);
    this.gl.render(this.scene, this.camera);
  }

  resize(width: number, height: number): void {
    this.gl.setSize(width, height, false);
    const aspect = width / height;
    this._aspect = aspect;
    // The horizontal extent is viewH × aspect. frustumH is sized to the
    // tower's footprint width, so in landscape (aspect ≥ 1) it always fits.
    // In portrait the vertical frustum must grow so the horizontal extent
    // never shrinks below the footprint width (+8 % margin).
    this.viewH = aspect >= 1 ? this.frustumH : (this.frustumH * 1.08) / aspect;
    this._applyProjection();
    // Pivot placement depends on viewH — recenter on the current tower top
    this._trackCamera();
  }

  // Compute the orthographic bounds from viewH plus the paused framing:
  // in portrait while paused, zoom out slightly and shift the visible window
  // right (the tower slides left) so it clears the right-edge scrubber.
  private _applyProjection(): void {
    const aspect = this._aspect;
    const amt    = aspect < 1 ? this._pausedAmt : 0;
    const h      = this.viewH * (1 + 0.18 * amt);
    const w      = h * aspect;
    // Gentle nudge — the zoom-out already frees ~9 % on each side; more than
    // a few percent pushes the tower past the left edge.
    const shift  = w * 0.06 * amt;
    this.camera.left   = -w / 2 + shift;
    this.camera.right  =  w / 2 + shift;
    this.camera.top    =  h / 2;
    this.camera.bottom = -h / 2;
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

    // Carry the per-cube colors along with the matrices
    const csrc = this.liveMesh.instanceColor!.array as Float32Array;
    const cdst = this.historyMesh.instanceColor!.array as Float32Array;
    cdst.set(csrc.subarray(0, n * 3), this.historyInstanceCount * 3);

    this.layerInstanceCounts.push(n);
    this.historyInstanceCount += n;
  }

  // Write instance matrices for every non-dead cell in grid into liveMesh
  // (dark body cube) and capMesh (accent plane on its top face).
  // makeTranslation is faster than Object3D.updateMatrix (no quaternion path).
  private _buildCap(grid: Grid, layerIndex = this.totalCommits): void {
    const { rows, cols, data } = grid;
    const layerY = layerIndex + 0.5;    // unit cube: layer i spans y ∈ [i, i+1]
    const capY   = layerY + 0.5 + 0.01; // top face + z-fight epsilon
    let count = 0;

    // Rarity variant flags (read once per build)
    const pal       = this.skin.paletteMode;
    const noisy     = pal === 'noisy';
    const rainbow   = pal === 'rainbow';
    const nmap      = this.skin.noiseMap;
    const prismatic = this.skin.accentMode === 'prismatic';
    const metallic  = this.skin.accentMode === 'metallic';
    const denom     = rows + cols;
    // Sphere caps are concentric shells (body center); cube/cylinder sit on top.
    const capYpos   = this._capAtCenter ? layerY : capY;
    // Rainbow uses the token's tower lightness so it sits in the same tonal range.
    this._towerMain.getHSL(this._hsl);
    const towerL = this._hsl.l;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const state = data[r * cols + c];
        if (state === 0) continue;
        const x = c - cols / 2 + 0.5;
        const z = r - rows / 2 + 0.5;
        this._mat.makeTranslation(x, layerY, z);
        this.liveMesh.setMatrixAt(count, this._mat);
        this._mat.makeTranslation(x, capYpos, z);
        this.capMesh.setMatrixAt(count, this._mat);

        // ── Body color ──────────────────────────────────────────────────────
        // Dying cells (Brian's Brain state 2) get the flat dying tone; living
        // cells use the speckled tower colors (hash-picked main vs noise).
        let body: THREE.Color;
        if (state === 2) {
          body = this._dyingColor;
        } else if (rainbow) {
          // Unsaturated rainbow across the body — pastel hue by diagonal position.
          this._bodyScratch.setHSL(((r + c) / denom) % 1, 0.30, towerL);
          body = this._bodyScratch;
        } else {
          body = cellNoise(r, c, layerIndex, 0x9e3779b9) ? this._towerNoise : this._towerMain;
          // Noisy: per-cell hue + lightness offset on top of the speckle.
          if (noisy && nmap) {
            const v = nmap[r * cols + c];
            body.getHSL(this._hsl);
            const h = ((this._hsl.h + v * 0.04) % 1 + 1) % 1;
            const l = Math.min(1, Math.max(0, this._hsl.l + v * 0.10));
            this._bodyScratch.setHSL(h, this._hsl.s, l);
            body = this._bodyScratch;
          }
        }
        this.liveMesh.setColorAt(count, body);

        // ── Cap color ───────────────────────────────────────────────────────
        let cap: THREE.Color;
        if (state === 2) {
          cap = this._dyingCap;
        } else if (metallic) {
          // White instance tint — the PBR material's metalness + env reflection
          // gives the chrome look; per-cell color would only mute it.
          cap = this._white;
        } else if (prismatic) {
          // Rainbow gradient across the top face (visible in the static capture).
          this._capScratch.setHSL(((r + c) / denom) % 1, 0.7, 0.6);
          cap = this._capScratch;
        } else {
          cap = cellNoise(r, c, layerIndex, 0x517cc1b7) ? this._accentNoise : this._accentMain;
        }
        this.capMesh.setColorAt(count, cap);
        count++;
      }
    }
    this.liveMesh.count = count;
    this.liveMesh.instanceMatrix.needsUpdate = true;
    this.liveMesh.instanceColor!.needsUpdate = true;
    this.capMesh.count = count;
    this.capMesh.instanceMatrix.needsUpdate = true;
    this.capMesh.instanceColor!.needsUpdate = true;
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
    // Edit grid rides the canvas plane (epsilon above the caps)
    this.editGrid.position.y = this.totalCommits + 0.02;
    this._camPivot.set(0, pivotY, 0);
    this._positionCamera();

    // Sun rides along with the pivot so the shadow frustum always covers the
    // visible portion of the tower.
    this.sun.position.set(fh * 0.55, pivotY + fh * 1.1, fh * 0.3);
    this.sun.target.position.copy(this._camPivot);
    this.sun.target.updateMatrixWorld();
  }

  // Place the camera on the orbit circle around the current pivot. Elevation
  // interpolates between the classic (1,1,1) iso view (vertical D/√3,
  // horizontal radius D·√(2/3)) and top-down for edit mode (_editAmt → 1).
  // A small residual radius keeps lookAt's up-vector well defined overhead.
  private _positionCamera(): void {
    const D = this.frustumH * 2;
    const e = this._editAmt;
    const R = D * Math.sqrt(2 / 3) * (1 - e) + D * 0.02 * e;
    const Y = (D / Math.sqrt(3)) * (1 - e) + D * e;
    this.camera.position.set(
      this._camPivot.x + R * Math.cos(this._camAngle),
      this._camPivot.y + Y,
      this._camPivot.z + R * Math.sin(this._camAngle),
    );
    this.camera.lookAt(this._camPivot);
  }

  // ── Edit mode support ────────────────────────────────────────────────────────

  // Re-render the live (top) layer in place after a paint/stamp edit.
  updateLiveLayer(grid: Grid): void {
    this._buildCap(grid, this.totalCommits - 1);
    this.gl.shadowMap.needsUpdate = true;
  }

  // Pixel → grid cell on the live layer's top face. Null outside the grid.
  pickCell(clientX: number, clientY: number): { row: number; col: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    this._ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this._raycaster.setFromCamera(this._ndc, this.camera);

    // Plane y = totalCommits (live layer top face): normal·p + constant = 0
    this._pickPlane.constant = -this.totalCommits;
    const hit = this._raycaster.ray.intersectPlane(this._pickPlane, this._hitV3);
    if (!hit) return null;

    const col = Math.floor(hit.x + this.cols / 2);
    const row = Math.floor(hit.z + this.rows / 2);
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) return null;
    return { row, col };
  }

  // Stamp placement preview — translucent accent planes above the live caps.
  setGhost(cells: { row: number; col: number }[] | null): void {
    const n = cells ? cells.length : 0;
    if (cells) {
      const y = this.totalCommits + 0.03;
      for (let i = 0; i < n; i++) {
        this._mat.makeTranslation(
          cells[i].col - this.cols / 2 + 0.5,
          y,
          cells[i].row - this.rows / 2 + 0.5,
        );
        this.ghostMesh.setMatrixAt(i, this._mat);
      }
      this.ghostMesh.instanceMatrix.needsUpdate = true;
    }
    this.ghostMesh.count = n;
  }
}
