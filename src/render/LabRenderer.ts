/**
 * Wave Laboratory renderer (three.js WebGL2): GPU spectral ocean, sky, vessels, probes, overlays,
 * cameras and picking. Implements the public contract in api.ts.
 */
import {
  ACESFilmicToneMapping,
  Color,
  DataTexture,
  Group,
  HalfFloatType,
  type Mesh,
  type Texture,
  Plane,
  Raycaster,
  RGBAFormat,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  type IUniform,
  type Object3D,
} from 'three';
import type { GpuOceanData } from '../ocean/gpuData';
import type { Environment, ProbeConfig } from '../schema/experiment';
import type { SimFrame } from '../sim/types';
import type { VesselDefinition } from '../vessel/api';
import type {
  CameraMode,
  LabRendererApi,
  OverlayLegend,
  OverlayMode,
  PickResult,
  RendererStats,
} from './api';
import { CameraRig, type CameraSubject } from './cameras/CameraRig';
import { threeToWorld } from './coords';
import {
  DIVERGING_BLUE_ORANGE,
  SEQUENTIAL_CIVIDIS,
  SEQUENTIAL_VIRIDIS,
} from './materials/colorMaps';
import { computeOceanStats, niceCeil, type OceanStats } from './ocean/oceanStats';
import {
  OceanSimulationGpu,
  detectFloatSupport,
  type FloatSupport,
} from './ocean/OceanSimulationGpu';
import { DENSITY_HIGH, DENSITY_LOW, OceanSurface } from './ocean/OceanSurface';
import {
  bindOceanData,
  createOceanUniforms,
  updateOceanUniforms,
  type OceanUniforms,
} from './ocean/oceanUniforms';
import { Probes } from './scene/Probes';
import { SkyEnvironment } from './scene/SkyEnvironment';
import { installTapPicking, type TapPickHandler, type TapPickingOptions } from './tapPicking';
import {
  createVesselEntry,
  disposeVesselEntry,
  placeVessel,
  type VesselEntry,
} from './scene/VesselMeshes';

export interface LabRendererOptions {
  onContextLost?: () => void;
  onContextRestored?: () => void;
  /** Use the RGBA16F path even when RGBA32F is available (testing). */
  forceHalfFloat?: boolean;
  /** Keep the drawing buffer for screenshots/readback (testing). */
  preserveDrawingBuffer?: boolean;
}

const OVERLAY_INDEX: Record<OverlayMode, number> = { none: 0, height: 1, steepness: 2, foam: 3 };
const UNDERWATER_COLOR = new Color('#0a3346');
const EXPOSURE = 0.55;

interface VesselRuntime {
  entry: VesselEntry;
  subject: CameraSubject;
}

export class LabRenderer implements LabRendererApi {
  private readonly canvas: HTMLCanvasElement;
  private readonly options: LabRendererOptions;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly skyEnv: SkyEnvironment;
  private readonly rig: CameraRig;
  private readonly probes = new Probes();
  private readonly vesselRoot = new Group();
  private readonly vessels = new Map<string, VesselRuntime>();
  /** Same entries as `vessels`, for allocation-free iteration in render(). */
  private readonly vesselList: VesselRuntime[] = [];
  private readonly floatSupport: FloatSupport;
  private readonly shading: Record<string, IUniform>;

  private oceanData: GpuOceanData | null = null;
  private oceanStats: OceanStats | null = null;
  private sim: OceanSimulationGpu | null = null;
  private surface: OceanSurface | null = null;
  private oceanUniforms: OceanUniforms | null = null;
  private env: Environment | null = null;
  private frame: SimFrame | null = null;
  private overlay: OverlayMode = 'none';
  private selection: string | null = null;
  private needsFraming = true;
  private contextLost = false;
  private disposed = false;

  private lastRenderAt = 0;
  private readonly statsData: RendererStats = { fps: 0, frameMs: 0, drawCalls: 0, triangles: 0 };

  private readonly raycaster = new Raycaster();
  private readonly ndc = new Vector2();
  private readonly waterPlane = new Plane(new Vector3(0, 1, 0), 0);
  private readonly tmpV = new Vector3();
  private readonly tmpW = { x: 0, y: 0, z: 0 };
  private readonly pickList: Object3D[] = [];
  private readonly tapCleanups = new Set<() => void>();
  /** Zero displacement used when float render targets are unavailable (flat sea). */
  private flatTexture: DataTexture | null = null;

  constructor(canvas: HTMLCanvasElement, options: LabRendererOptions = {}) {
    this.canvas = canvas;
    this.options = options;
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      depth: true,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
    });
    if (!gl) {
      throw new Error(
        'WebGL 2 is not available in this browser or on this GPU. Wave Laboratory needs WebGL 2 ' +
          '(try an up-to-date Chrome, Edge, Firefox or Safari, and enable hardware acceleration).',
      );
    }
    this.renderer = new WebGLRenderer({ canvas, context: gl, antialias: true });
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = EXPOSURE;
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.autoClear = false;
    this.renderer.info.autoReset = false;
    this.floatSupport = detectFloatSupport(this.renderer, options.forceHalfFloat ?? false);

    this.skyEnv = new SkyEnvironment(this.renderer);
    this.scene.add(this.skyEnv.sky);
    this.scene.add(this.skyEnv.sunLight);
    this.vesselRoot.name = 'Vessels';
    this.scene.add(this.vesselRoot);
    this.scene.add(this.probes.group);
    this.rig = new CameraRig(canvas);

    this.shading = {
      uSkyCube: { value: this.skyEnv.cubeTarget.texture },
      uSkyMaxMip: { value: this.skyEnv.maxMip },
      uSunDir: { value: this.skyEnv.sunDirection },
      uSunIrradiance: { value: this.skyEnv.sunIrradiance },
      // Deep, clear ocean water (Jerlov I-like): R∞ ≈ b_b / (a + b_b) per channel.
      uWaterReflectance: { value: new Color(0.004, 0.018, 0.032) },
      uSssColor: { value: new Color(0.05, 0.23, 0.2) },
      uSssScale: { value: 1 },
      uBaseMss: { value: 0.01 },
      uFoamThreshold: { value: 0.6 },
      uWhitecap: { value: 0.5 },
      uFogDistance: { value: 14000 },
      uOverlay: { value: 0 },
      uOverlayRange: { value: new Vector2(-1, 1) },
      uMaxAniso: { value: this.floatSupport.maxAnisotropy },
    };

    canvas.addEventListener('webglcontextlost', this.onLost, false);
    canvas.addEventListener('webglcontextrestored', this.onRestored, false);
  }

  // ------------------------------------------------------------------ public API

  setOcean(data: GpuOceanData): void {
    this.oceanData = data;
    this.oceanStats = computeOceanStats(data);
    this.buildOcean();
  }

  setEnvironment(env: Environment): void {
    this.env = env;
    this.skyEnv.setEnvironment(env);
    this.rig.setSunDirection(this.skyEnv.sunDirection);
    const u = env.windSpeed;
    // Capillary/short-gravity slope variance not represented by the cascades (fraction of the
    // Cox & Munk 1954 clean-surface mean-square slope 0.003 + 5.12·10⁻³ U).
    this.shading.uBaseMss!.value = 0.0015 + 0.0012 * u;
    this.shading.uWhitecap!.value = Math.min(1, Math.max(0, (u - 4) / 10));
    const w = Math.min(1, 3.84e-6 * Math.pow(Math.max(0, u), 3.41));
    this.shading.uFoamThreshold!.value = Math.min(0.95, 0.6 + 0.6 * Math.sqrt(w));
    this.sim?.setWind(u);
  }

  setVessels(vessels: readonly { id: string; definition: VesselDefinition }[]): void {
    for (const v of this.vessels.values()) disposeVesselEntry(v.entry);
    this.vessels.clear();
    this.vesselList.length = 0;
    for (const { id, definition } of vessels) {
      const entry = createVesselEntry(id, definition);
      entry.group.visible = false; // until the first frame places it
      this.vesselRoot.add(entry.group);
      const runtime: VesselRuntime = {
        entry,
        subject: {
          object: entry.group,
          length: definition.length,
          bridgeEye: bridgeEye(definition),
        },
      };
      this.vessels.set(id, runtime);
      this.vesselList.push(runtime);
    }
    this.applySelection();
    this.needsFraming = true;
  }

  setProbes(probes: readonly ProbeConfig[]): void {
    this.probes.setProbes(probes);
    this.needsFraming = true;
  }

  setFrame(frame: SimFrame): void {
    this.frame = frame;
  }

  setOverlay(mode: OverlayMode): void {
    if (mode === this.overlay) return;
    this.overlay = mode;
    this.applyOverlay();
  }

  setCamera(mode: CameraMode, targetId?: string | null): void {
    const target = targetId ?? this.selection ?? this.vessels.keys().next().value ?? null;
    this.rig.setMode(mode, target);
  }

  setSelection(id: string | null): void {
    this.selection = id;
    this.applySelection();
  }

  get overlayLegend(): OverlayLegend | null {
    return this.overlay === 'none' ? null : this.getOverlayLegend(this.overlay);
  }

  /** Colour scale used for a given overlay mode with the current sea. */
  getOverlayLegend(mode: Exclude<OverlayMode, 'none'>): OverlayLegend | null {
    const st = this.oceanStats;
    if (!st) return null;
    switch (mode) {
      case 'height': {
        // ±2σ_η = ±H_s/2 rounded to a nice number.
        const r = niceCeil(Math.max(0.05, 2 * Math.sqrt(st.etaVariance)));
        return {
          mode,
          label: 'Surface elevation η',
          unit: 'm',
          min: -r,
          max: r,
          stops: DIVERGING_BLUE_ORANGE,
        };
      }
      case 'steepness':
        return {
          mode,
          label: 'Surface slope |∇η|',
          unit: '–',
          min: 0,
          max: niceCeil(Math.max(0.05, 2.5 * Math.sqrt(st.meanSquareSlope))),
          stops: SEQUENTIAL_VIRIDIS,
        };
      case 'foam':
        return {
          mode,
          label: 'Foam / whitecap coverage',
          unit: '–',
          min: 0,
          max: 1,
          stops: SEQUENTIAL_CIVIDIS,
        };
    }
  }

  /** Which float render path the GPU ocean uses. */
  get floatPath(): FloatSupport['path'] {
    return this.floatSupport.path;
  }

  get stats(): RendererStats {
    return this.statsData;
  }

  render(): void {
    if (this.contextLost || this.disposed) return;
    const t0 = performance.now();
    const dt = this.lastRenderAt > 0 ? Math.min(0.1, (t0 - this.lastRenderAt) / 1000) : 1 / 60;
    if (this.lastRenderAt > 0 && t0 > this.lastRenderAt) {
      const inst = 1000 / (t0 - this.lastRenderAt);
      this.statsData.fps = this.statsData.fps > 0 ? this.statsData.fps * 0.9 + inst * 0.1 : inst;
    }
    this.lastRenderAt = t0;
    const renderer = this.renderer;
    renderer.info.reset();

    const frame = this.frame;
    const t = frame?.t ?? 0;
    if (frame) this.applyFrame(frame);

    // Sky capture (only when the environment changed).
    this.skyEnv.setTime(t);
    if (this.skyEnv.update(renderer)) this.scene.environment = this.skyEnv.environment;

    // Spectral ocean at the physics time.
    if (this.oceanData && this.oceanUniforms) {
      this.sim?.update(t);
      updateOceanUniforms(this.oceanUniforms, this.sim, this.oceanData, t);
    }

    // Cameras.
    const subjectId = this.rig.currentTarget;
    const subject = subjectId ? this.subjectFor(subjectId) : null;
    this.rig.update(dt, subject);
    // Hide the outline of the vessel the bridge camera sits on (we would be inside its shell).
    const list = this.vesselList;
    for (let i = 0; i < list.length; i++) {
      const v = list[i]!;
      v.entry.outline.visible =
        v.entry.id === this.selection &&
        !(this.rig.currentMode === 'bridge' && v.entry.id === subjectId);
    }
    const camera = this.rig.camera;
    camera.updateMatrixWorld();
    this.surface?.update(camera.position);

    // Below the mean surface: hide the sky, show the water body colour.
    const underwater = camera.position.y < 0;
    this.skyEnv.sky.visible = !underwater;
    this.scene.background = underwater ? UNDERWATER_COLOR : null;

    renderer.setRenderTarget(null);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, false);
    renderer.render(this.scene, camera);

    const info = renderer.info.render;
    this.statsData.drawCalls = info.calls;
    this.statsData.triangles = info.triangles;
    this.statsData.frameMs = performance.now() - t0;
  }

  resize(width: number, height: number, pixelRatio: number): void {
    if (this.disposed) return;
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(Math.max(1, width), Math.max(1, height), false);
    this.rig.resize(Math.max(1, width) / Math.max(1, height));
  }

  pick(x: number, y: number): PickResult | null {
    const w = this.canvas.clientWidth || this.canvas.width;
    const h = this.canvas.clientHeight || this.canvas.height;
    if (w <= 0 || h <= 0) return null;
    this.ndc.set((x / w) * 2 - 1, -(y / h) * 2 + 1);
    const camera = this.rig.camera;
    camera.updateMatrixWorld();
    this.scene.updateMatrixWorld();
    this.raycaster.setFromCamera(this.ndc, camera);
    const list = this.pickList;
    list.length = 0;
    for (const v of this.vessels.values()) {
      if (v.entry.group.visible) for (const p of v.entry.pickables) list.push(p);
    }
    for (const p of this.probes.pickables) list.push(p);
    const hits = this.raycaster.intersectObjects(list, false);
    const hit = hits[0];
    if (hit) {
      const id = hit.object.userData.pickId as string | undefined;
      const kind = id !== undefined && this.vessels.has(id) ? 'vessel' : 'probe';
      const p = threeToWorld(hit.point, this.tmpW);
      return { kind, ...(id !== undefined ? { id } : {}), point: { x: p.x, y: p.y, z: p.z } };
    }
    const pt = this.raycaster.ray.intersectPlane(this.waterPlane, this.tmpV);
    if (!pt) return null;
    const p = threeToWorld(pt, this.tmpW);
    return { kind: 'water', point: { x: p.x, y: p.y, z: 0 } };
  }

  nudgeCamera(action: 'left' | 'right' | 'up' | 'down' | 'in' | 'out' | 'reset'): void {
    this.rig.nudge(action);
  }

  /**
   * Select by tapping/clicking: `onPick` receives `pick()` at the tap position. Drags (> 6 CSS px,
   * e.g. orbiting or pinching) and multi-touch gestures are ignored. Returns an unsubscribe
   * function; all handlers are removed by dispose().
   */
  enableTapPicking(onPick: TapPickHandler, options?: TapPickingOptions): () => void {
    const off = installTapPicking(this.canvas, (x, y) => this.pick(x, y), onPick, options);
    const cleanup = () => {
      off();
      this.tapCleanups.delete(cleanup);
    };
    this.tapCleanups.add(cleanup);
    return cleanup;
  }

  /** GPU resource counters (diagnostics/tests). */
  debugInfo(): { geometries: number; textures: number; programs: number; floatPath: string } {
    const info = this.renderer.info;
    return {
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
      floatPath: this.floatSupport.path,
    };
  }

  /** Camera pose in world coordinates (z-up): position and unit view direction. */
  cameraPose(): {
    position: { x: number; y: number; z: number };
    forward: { x: number; y: number; z: number };
  } {
    const cam = this.rig.camera;
    const p = threeToWorld(cam.position, { x: 0, y: 0, z: 0 });
    const f = threeToWorld(cam.getWorldDirection(new Vector3()), { x: 0, y: 0, z: 0 });
    return { position: p, forward: f };
  }

  /** The underlying WebGL2 context (diagnostics/tests). */
  get gl(): WebGL2RenderingContext {
    return this.renderer.getContext() as WebGL2RenderingContext;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of [...this.tapCleanups]) off();
    this.canvas.removeEventListener('webglcontextlost', this.onLost, false);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored, false);
    this.disposeOcean();
    this.flatTexture?.dispose();
    this.flatTexture = null;
    this.disposeSharedLuts();
    for (const v of this.vessels.values()) disposeVesselEntry(v.entry);
    this.vessels.clear();
    this.vesselList.length = 0;
    this.probes.dispose();
    this.skyEnv.dispose();
    this.rig.dispose();
    this.scene.environment = null;
    this.scene.clear();
    this.renderer.renderLists.dispose();
    this.renderer.dispose();
  }

  // ------------------------------------------------------------------ internals

  private buildOcean(): void {
    this.disposeOcean();
    const data = this.oceanData;
    const stats = this.oceanStats;
    if (!data || !stats || data.cascades.length === 0) return;
    if (this.floatSupport.path !== 'none') {
      this.sim = new OceanSimulationGpu(this.renderer, data, this.floatSupport);
      if (this.env) this.sim.setWind(this.env.windSpeed);
    } else {
      console.warn(
        'Wave Laboratory: float render targets unavailable; rendering a flat sea with regular ' +
          'waves only.',
      );
    }
    const uniforms = createOceanUniforms(data.cascades.length);
    this.oceanUniforms = uniforms;
    bindOceanData(uniforms, data, stats);
    if (!this.sim) {
      this.flatTexture ??= flatTexture();
      for (let i = 0; i < data.cascades.length; i++) {
        uniforms[`uDisp${i}`]!.value = this.flatTexture;
        uniforms[`uDeriv${i}`]!.value = this.flatTexture;
        uniforms[`uFoam${i}`]!.value = this.flatTexture;
      }
    }
    // SSS crest scale ~ significant amplitude.
    this.shading.uSssScale!.value = Math.max(0.2, data.hs / 2);
    // Coarser mesh for the mobile-oriented quality levels (N ≤ 128).
    const density = (data.cascades[0]?.n ?? 256) <= 128 ? DENSITY_LOW : DENSITY_HIGH;
    this.surface = new OceanSurface(
      data.cascades.length,
      { ...uniforms, ...this.shading },
      density,
    );
    this.scene.add(this.surface.group);
    this.applyOverlay();
  }

  private disposeOcean(): void {
    this.surface?.dispose();
    this.surface = null;
    this.sim?.dispose();
    this.sim = null;
    this.oceanUniforms = null;
  }

  private applyOverlay(): void {
    const mode = this.overlay;
    this.shading.uOverlay!.value = OVERLAY_INDEX[mode];
    const legend = mode === 'none' ? null : this.getOverlayLegend(mode);
    if (legend) (this.shading.uOverlayRange!.value as Vector2).set(legend.min, legend.max);
    if (this.surface) {
      for (const m of this.surface.allMaterials) {
        // Overlay colours must match the legend exactly → no tone mapping.
        const toneMapped = mode === 'none';
        if (m.toneMapped !== toneMapped) {
          m.toneMapped = toneMapped;
          m.needsUpdate = true;
        }
      }
    }
  }

  private applySelection(): void {
    for (const [id, v] of this.vessels) v.entry.outline.visible = id === this.selection;
  }

  private applyFrame(frame: SimFrame): void {
    const vs = frame.vessels;
    for (let i = 0; i < vs.length; i++) {
      const s = vs[i]!;
      const v = this.vessels.get(s.id);
      if (!v) continue;
      placeVessel(v.entry, s);
      v.entry.group.visible = true;
    }
    this.probes.update(frame.probes);
    if (this.needsFraming) {
      this.needsFraming = false;
      this.frameScene();
    }
  }

  /** Default orbit framing around the vessels (or probes / origin). */
  private frameScene(): void {
    const center = this.tmpV.set(0, 0, 0);
    let n = 0;
    let size = 30;
    for (const v of this.vessels.values()) {
      center.add(v.entry.group.position);
      size = Math.max(size, v.subject.length);
      n++;
    }
    if (n > 0) center.multiplyScalar(1 / n);
    let spread = 0;
    for (const v of this.vessels.values()) {
      spread = Math.max(spread, v.entry.group.position.distanceTo(center));
    }
    center.y = 0;
    this.rig.setHome(center, 1.6 * size + 1.2 * spread + 25);
    if (this.rig.currentMode === 'orbit') this.rig.resetOrbit();
  }

  private subjectFor(id: string): CameraSubject | null {
    const v = this.vessels.get(id);
    if (v) return v.entry.group.visible ? v.subject : null;
    const probe = this.probes.positionOf(id);
    if (probe) return { object: probe, length: 8, bridgeEye: new Vector3(0, 3.2, 0) };
    return null;
  }

  private readonly onLost = (e: Event): void => {
    e.preventDefault();
    this.contextLost = true;
    this.releaseGpuObjects();
    this.options.onContextLost?.();
  };

  /**
   * Free every GPU object while the context is lost (deletes are silent then). three.js objects
   * stay usable and are re-uploaded lazily on the restored context; our own GPU pipeline is
   * rebuilt in onRestored. Releasing now avoids deleting stale handles on the new context.
   */
  /**
   * three.js binds a module-global DFG lookup texture to physically based materials; it is never
   * freed by the renderer. Disposing it only drops this renderer's GPU copy (other renderers
   * re-upload it lazily), so dispose() really releases everything.
   */
  private disposeSharedLuts(): void {
    const seen = new Set<Texture>();
    this.scene.traverse((obj) => {
      const mat = (obj as Partial<Mesh>).material;
      for (const m of Array.isArray(mat) ? mat : mat ? [mat] : []) {
        const props = this.renderer.properties.get(m) as
          { uniforms?: Record<string, IUniform | undefined> } | undefined;
        const lut = props?.uniforms?.dfgLUT?.value as Texture | null | undefined;
        if (lut && !seen.has(lut)) {
          seen.add(lut);
          lut.dispose();
        }
      }
    });
  }

  private releaseGpuObjects(): void {
    this.disposeOcean();
    this.flatTexture?.dispose();
    this.flatTexture = null;
    this.skyEnv.releaseGpu();
    this.scene.environment = null;
    this.scene.traverse((obj) => {
      const mesh = obj as Partial<Mesh>;
      mesh.geometry?.dispose();
      const mat = mesh.material;
      if (Array.isArray(mat)) for (const m of mat) m.dispose();
      else mat?.dispose();
    });
    this.renderer.renderLists.dispose();
  }

  private readonly onRestored = (): void => {
    if (this.disposed) return;
    // three.js re-creates its GL state; our GPU objects are rebuilt from the stored inputs.
    this.contextLost = false;
    this.buildOcean();
    this.skyEnv.markDirty();
    this.options.onContextRestored?.();
  };
}

function flatTexture(): DataTexture {
  // Half-float zeros: filterable on every WebGL2 implementation.
  const tex = new DataTexture(new Uint16Array(4), 1, 1, RGBAFormat, HalfFloatType);
  tex.needsUpdate = true;
  return tex;
}

/** Bridge eye point (three-oriented body frame) just ahead of the highest deckhouse front. */
function bridgeEye(def: VesselDefinition): Vector3 {
  let house: VesselDefinition['superstructure'][number] | null = null;
  let bestTop = -Infinity;
  for (const b of def.superstructure) {
    if (b.material !== 'superstructure' && b.material !== 'glass') continue;
    const top = b.center.z + b.size.z / 2;
    if (top > bestTop) {
      bestTop = top;
      house = b;
    }
  }
  if (!house) return new Vector3(0.25 * def.length, def.depth - def.kg + 2.5, 0);
  // Eye ~1.2 m below the roof, on the centreline…
  const z = Math.max(house.center.z, bestTop - Math.min(1.2, house.size.z * 0.4));
  // …and in front of every box at that height (windows, bridge wings), so nothing blocks the view.
  let x = house.center.x + house.size.x / 2;
  for (let pass = 0; pass < 3; pass++) {
    for (const b of def.superstructure) {
      const inYZ = Math.abs(b.center.y) <= b.size.y / 2 && Math.abs(z - b.center.z) <= b.size.z / 2;
      const front = b.center.x + b.size.x / 2;
      const back = b.center.x - b.size.x / 2;
      if (inYZ && back <= x + 0.5 && front > x) x = front;
    }
  }
  return new Vector3(x + 0.4, z, 0);
}
