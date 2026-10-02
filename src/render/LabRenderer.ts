/**
 * WebGL 2 view of the lab: GPU FFT ocean, vessels, gauges and cameras.
 * World space is z-up; the Three.js scene is y-up via (x, y, z) → (x, z, −y).
 */
import * as THREE from 'three';
import { rotate, type Quat, type Vec3 } from '../core/vec';
import type { GpuOceanData } from '../ocean/gpuData';
import { currentVelocity } from '../ocean/oceanField';
import {
  DEFAULT_WEATHER,
  type Environment,
  type OceanQuality,
  type ProbeConfig,
  type Weather,
} from '../schema/experiment';
import type { SimFrame } from '../sim/types';
import type { VesselDefinition, VisualMaterial } from '../vessel/api';
import {
  GUST_MODES,
  rainVisibilityKm,
  WeatherField,
  whitecapFraction,
  type WindSample,
} from '../weather/weather';
import type {
  CameraMode,
  LabRendererApi,
  MapIsland,
  NavigationView,
  OverlayMode,
  PickResult,
  RendererStats,
} from './api';
import { buildDuck } from './effects/duck';
import { GpuOcean } from './ocean/GpuOcean';
import { OCEAN_FRAG, OCEAN_VERT, SKY_FRAG, SKY_VERT } from './ocean/shaders';
import { cameraNavigation, chartIslands } from './navigation';
import { calmFromConditions, ease } from './scenery/ambience';
import { SeabirdLayer } from './scenery/birds';
import { IslandLayer } from './scenery/islands';
import { SkyLighting, type LightingState } from './scenery/lighting';
import { PlaneLayer, type PlanePose } from './scenery/planes';
import { SailorLayer } from './scenery/sailors';
import {
  DEFAULT_AMBIENCE,
  type AmbienceSettings,
  type SceneryFrame,
  type SceneryLayer,
} from './scenery/types';
import { WildlifeLayer } from './scenery/wildlife';
import { createRadialOceanGeometry, OCEAN_DENSITY, OCEAN_SLICES } from './scene/oceanMesh';
import { RainField, SMOKE_STYLE, SprayPool } from './scene/particles';
import { RigView } from './scene/rig';
import { WakeField, type WakeSource } from './scene/wakes';
import { flightDeckTexture, jollyRogerTexture } from './scene/textures';

export interface LabRendererOptions {
  onContextLost?: () => void;
  onContextRestored?: () => void;
}

const Q_WORLD_TO_THREE = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(1, 0, 0),
  -Math.PI / 2,
);
const Q_THREE_TO_WORLD = Q_WORLD_TO_THREE.clone().invert();

const HULL_COLORS: Record<VisualMaterial, number> = {
  hull: 0xffffff,
  deck: 0x4b5568,
  superstructure: 0xe8eef6,
  glass: 0x9bd7f5,
  cargo: 0xb45309,
  accent: 0xd97706,
  wood: 0x5a3b22,
  gold: 0xd4a72c,
  flightdeck: 0x3b4047,
  sail: 0xe6dcc3,
  flag: 0x0b0b0b,
};

/** Per-quality budgets for the effects. */
const BUDGET: Record<
  OceanQuality,
  { rain: number; spray: number; octaves: number; detail: number }
> = {
  low: { rain: 1200, spray: 500, octaves: 3, detail: 3 },
  medium: { rain: 3500, spray: 1400, octaves: 4, detail: 4 },
  high: { rain: 7000, spray: 2600, octaves: 5, detail: 4 },
  ultra: { rain: 11000, spray: 4000, octaves: 6, detail: 4 },
};

/** Rendering never looks further than this through the haze [m]. */
const MAX_VIEW = 14_000;

interface VesselView {
  id: string;
  definition: VesselDefinition;
  group: THREE.Group;
  materials: THREE.MeshStandardMaterial[];
  textures: THREE.Texture[];
  rig: RigView | null;
  /** Paint colours as built, darkened toward soot as the ship is damaged. */
  baseColors: THREE.Color[];
  /** Health the paint was last drawn for. */
  shownHealth: number;
  /** Body-frame point smoke rises from (funnel or top of the superstructure). */
  smokeFrom: Vec3;
  /** Bounds of hull and superstructure in the group's (Three.js body) axes. */
  bounds: THREE.Box3;
}

/** Hull and superstructure bounds of a vessel, in its group's Three.js body axes. */
function vesselBounds(def: VesselDefinition): THREE.Box3 {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  const p = def.renderHull.positions;
  for (let i = 0; i < p.length; i += 3) box.expandByPoint(v.set(p[i]!, p[i + 2]!, -p[i + 1]!));
  for (const b of def.superstructure) {
    const c = b.center;
    const h = b.size;
    const r = Math.hypot(h.x, h.y) / 2;
    const half = b.yawDeg ? { x: r, y: r } : { x: h.x / 2, y: h.y / 2 };
    box.expandByPoint(v.set(c.x - half.x, c.z - h.z / 2, -(c.y - half.y)));
    box.expandByPoint(v.set(c.x + half.x, c.z + h.z / 2, -(c.y + half.y)));
  }
  return box;
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

const smooth = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

const HORIZON_CLEAR = [0.78, 0.84, 0.9].map(srgbToLinear);
const HORIZON_DUSK = [0.95, 0.66, 0.46].map(srgbToLinear);
const HORIZON_NIGHT = [0.15, 0.2, 0.3].map(srgbToLinear);
const OVERCAST_GREY = [0.62, 0.66, 0.7].map(srgbToLinear);
const OVERCAST_STORM = [0.36, 0.39, 0.42].map(srgbToLinear);
const FLASH_RGB = [0.55, 0.6, 0.75];

/**
 * Horizon colour (linear RGB): a direct port of `horizonColor()` / `overcastBase()` in the sky
 * shader, so fogged vessels and the clear colour fade to the same grey as the sky and water.
 */
function horizonColor(
  cloud: number,
  daylight: number,
  flash: number,
  out: THREE.Color,
  night = 0,
  dusk = 0,
) {
  const mix = (a: number, b: number, t: number) => a + (b - a) * t;
  const overcast = smooth(0.2, 0.85, cloud);
  const storm = smooth(0.75, 1, cloud);
  const ch = (i: number) => {
    const base = mix(OVERCAST_GREY[i]!, OVERCAST_STORM[i]!, storm);
    const clear = mix(HORIZON_CLEAR[i]!, HORIZON_DUSK[i]!, dusk * 0.45);
    const day = mix(clear, base * 0.62, overcast) * daylight;
    return mix(day, HORIZON_NIGHT[i]! * (1 - 0.5 * overcast), night) + FLASH_RGB[i]! * flash * 0.6;
  };
  return out.setRGB(ch(0), ch(1), ch(2));
}

function worldToThree(v: Vec3, out: THREE.Vector3): THREE.Vector3 {
  return out.set(v.x, v.z, -v.y);
}

function attitudeToThree(q: Quat, out: THREE.Quaternion): THREE.Quaternion {
  out.set(q.x, q.y, q.z, q.w);
  return out.premultiply(Q_WORLD_TO_THREE).multiply(Q_THREE_TO_WORLD);
}

function rendererTier(gl: WebGL2RenderingContext): 'light' | 'full' {
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
  const software = /swiftshader|llvmpipe|softpipe|software/i.test(name);
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const small = Math.min(window.screen?.width ?? 1400, window.screen?.height ?? 900) < 900;
  return software || (coarse && small) ? 'light' : 'full';
}

function oceanTextureType(gl: WebGL2RenderingContext): THREE.TextureDataType {
  if (gl.getExtension('EXT_color_buffer_float')) return THREE.FloatType;
  if (gl.getExtension('EXT_color_buffer_half_float')) return THREE.HalfFloatType;
  throw new Error('This browser cannot render the ocean (missing floating-point colour buffers).');
}

/** Plane camera: default and limits of the seat behind the ridden aircraft. */
const PLANE_LOOK = {
  /** Gaze below level [rad]: about 22° down, the fleet a little above mid-frame from the circuit. */
  dip: 0.38,
  minDip: -0.3,
  /** Nearly straight down. */
  maxDip: 1.52,
  /** Distance behind the aircraft along the gaze [m]. */
  chase: 110,
  minChase: 30,
  maxChase: 1500,
  /** Seat height above the gaze line through the aircraft, per metre of chase. */
  lift: 0.24,
} as const;

export class LabRenderer implements LabRendererApi {
  readonly stats: RendererStats = { fps: 0, frameMs: 0, drawCalls: 0, triangles: 0 };

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly ocean: GpuOcean;
  private readonly oceanMesh: THREE.Mesh;
  private readonly sky: THREE.Mesh;
  private readonly sun: THREE.DirectionalLight;
  private readonly hemi: THREE.HemisphereLight;
  private readonly lighting: SkyLighting;
  private readonly islands = new IslandLayer();
  private readonly wildlife = new WildlifeLayer();
  private readonly birds = new SeabirdLayer();
  private readonly sailors = new SailorLayer();
  private readonly planes = new PlaneLayer();
  private readonly layers: SceneryLayer[] = [
    this.islands,
    this.wildlife,
    this.birds,
    this.sailors,
    this.planes,
  ];
  private readonly fog = new THREE.FogExp2(0xc8d6e5, 1e-4);
  private quality: OceanQuality = 'high';
  private rain: RainField;
  private spray: SprayPool;
  private smoke: SprayPool;
  /** Collisions already turned into spray (keyed by time and pair). */
  private readonly seenCollisions = new Set<string>();
  private weather: Weather = DEFAULT_WEATHER;
  private env: Environment | null = null;
  private weatherField: WeatherField | null = null;
  private readonly windSample: WindSample = { u: 0, v: 0, speed: 0, squall: 0 };
  private readonly windThree = new THREE.Vector3();
  private readonly fogColor = new THREE.Color();
  private sunBase = 2.4;
  private lastRenderT = Number.NaN;
  private daylight = 1;
  /** Vessels that slammed or shipped green water since the last drawn frame. */
  private readonly sprayBursts = new Set<string>();
  private duckMode = false;
  /** Time-of-day factors from SkyLighting (night, dusk, exposure and hemisphere tint). */
  private lightState: LightingState | null = null;
  /** Last frame's weather at the camera, as 0–1 storm intensity and wind [m/s]. */
  private weatherStorm = 0;
  private localWind = 0;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly vessels = new Map<string, VesselView>();
  private readonly probes = new Map<string, THREE.Object3D>();
  private readonly pickables: THREE.Object3D[] = [];
  private readonly tmp = new THREE.Vector3();
  private readonly tmpV = new THREE.Vector3();
  private readonly wakes = new WakeField();
  private readonly wakeSources: WakeSource[] = [];
  private readonly look = new THREE.Vector3();
  private readonly onLost: (ev: Event) => void;
  private readonly onRestored: () => void;
  private readonly onPointerDown: (ev: PointerEvent) => void;
  private readonly onPointerMove: (ev: PointerEvent) => void;
  private readonly onPointerUp: (ev: PointerEvent) => void;
  private readonly onWheel: (ev: WheelEvent) => void;

  private frame: SimFrame | null = null;
  private prevFrame: SimFrame | null = null;
  private shownT = 0;
  private readonly quatA = new THREE.Quaternion();
  private readonly quatB = new THREE.Quaternion();
  private mode: CameraMode = 'orbit';
  private cameraTarget: string | null = null;
  private selection: string | null = null;
  private yaw = 0.65;
  private polar = 0.95;
  private radius = 180;
  /** Plane view: gaze turned from "toward the fleet" [rad], dip below level [rad], seat [m]. */
  private planeYaw = 0;
  private planeDip: number = PLANE_LOOK.dip;
  private planeChase: number = PLANE_LOOK.chase;
  private readonly ridePose: PlanePose = { x: 0, y: 0, z: 0, heading: 0, bank: 0 };
  private readonly rideCentre = { x: 0, z: 0 };
  private wallDt = 0;
  private userMoved = false;
  private dragging = false;
  private dragged = false;
  private lastX = 0;
  private lastY = 0;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;
  private fpsFrames = 0;
  private fpsElapsed = 0;
  private lastFrameAt = 0;
  private disposed = false;
  private hs = 1;
  private hasOcean = false;
  private ambience: AmbienceSettings = { ...DEFAULT_AMBIENCE };
  private timeOfDay: number | null = null;
  private storminess: number | null = null;
  private calm = 1;
  private calmPrimed = false;
  private wallT = 0;
  private lastRenderAt = 0;
  private readonly vesselPositions: THREE.Vector3[] = [];
  /** Map-chosen point the orbit camera glides to (Three.js axes), or null to follow the fleet. */
  private explore: THREE.Vector3 | null = null;
  private readonly exploreFrom = new THREE.Vector3();
  private exploreGlide = 1;
  private readonly orbitCentre = new THREE.Vector3();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    opts: LabRendererOptions = {},
  ) {
    const probe = document.createElement('canvas');
    const probeGl = probe.getContext('webgl2');
    const tier = probeGl ? rendererTier(probeGl) : 'light';
    probeGl?.getExtension('WEBGL_lose_context')?.loseContext();
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: tier === 'full',
      depth: true,
      stencil: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL 2 is not available in this browser.');
    const texType = oceanTextureType(gl);
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      context: gl,
      // A reversed (1 → 0) depth buffer keeps float precision all the way to the horizon, so
      // decks, superstructure and hull paint no longer shimmer (z-fight) on distant ships.
      reversedDepthBuffer: gl.getExtension('EXT_clip_control') !== null,
      antialias: tier === 'full',
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setClearColor(0x8aa4b8, 1);
    this.renderer.info.autoReset = false;

    this.camera = new THREE.PerspectiveCamera(48, 1, 0.2, 40000);
    this.ocean = new GpuOcean(this.renderer, texType);
    this.quality = tier === 'light' ? 'medium' : 'high';
    Object.assign(this.ocean.uniforms, {
      uMeshScale: { value: 1 },
      uDetailCascades: { value: 4 },
      uCloud: { value: 0.25 },
      uFlash: { value: 0 },
      uSkyTime: { value: 0 },
      uCloudDrift: { value: new THREE.Vector2() },
      uCloudOctaves: { value: 5 },
      uWhitecap: { value: 0 },
      uWindDir: { value: new THREE.Vector2(1, 0) },
      uRain: { value: 0 },
      uAdvect: { value: 8 },
      uGust: { value: Array.from({ length: GUST_MODES }, () => new THREE.Vector4()) },
      uGustCount: { value: 0 },
      uSquall: { value: new THREE.Vector4(-1e9, -1e9, -1e9, 0) },
      uSquallOn: { value: 0 },
      uSquallDur: { value: 240 },
      uWakeTex: { value: this.wakes.texture },
      uWakeShip: { value: this.wakes.ship },
      uWakeInfo: { value: this.wakes.info },
      uWakeBox: { value: this.wakes.box },
    });

    this.oceanMesh = new THREE.Mesh(
      createRadialOceanGeometry(OCEAN_SLICES[this.quality]),
      new THREE.ShaderMaterial({
        uniforms: this.ocean.uniforms,
        vertexShader: OCEAN_VERT,
        fragmentShader: OCEAN_FRAG,
        side: THREE.DoubleSide,
        precision: 'highp',
      }),
    );
    this.oceanMesh.frustumCulled = false;
    this.scene.add(this.oceanMesh);

    const u = this.ocean.uniforms;
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(8000, 32, 20),
      new THREE.ShaderMaterial({
        uniforms: {
          uSunDir: u.uSunDir!,
          uCloud: u.uCloud!,
          uFlash: u.uFlash!,
          uSkyTime: u.uSkyTime!,
          uCloudDrift: u.uCloudDrift!,
          uCloudOctaves: u.uCloudOctaves!,
          uFogDensity: u.uFogDensity!,
        },
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        side: THREE.BackSide,
        depthTest: false,
        depthWrite: false,
        precision: 'highp',
      }),
    );
    this.sky.renderOrder = -1;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
    this.scene.fog = this.fog;

    this.hemi = new THREE.HemisphereLight(0xc5ddf2, 0x1c3344, 0.9);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
    this.sun.position.set(400, 800, 200);
    this.scene.add(this.sun);
    this.lighting = new SkyLighting({
      renderer: this.renderer,
      scene: this.scene,
      sun: this.sun,
      hemi: this.hemi,
      skyMaterial: this.sky.material as THREE.ShaderMaterial,
      oceanUniforms: this.ocean.uniforms,
    });
    for (const layer of this.layers) this.scene.add(layer.object);
    this.applyAmbience();

    const budget = BUDGET[this.quality];
    this.rain = new RainField(budget.rain);
    this.spray = new SprayPool(budget.spray);
    this.smoke = new SprayPool(Math.round(budget.spray / 3), SMOKE_STYLE);
    this.scene.add(this.rain.object, this.spray.object, this.smoke.object);
    this.applyQualityUniforms();

    this.onLost = (ev: Event) => {
      ev.preventDefault();
      opts.onContextLost?.();
    };
    this.onRestored = () => {
      this.ocean.restore();
      opts.onContextRestored?.();
    };
    this.onPointerDown = (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      this.canvas.setPointerCapture(ev.pointerId);
      if (this.pointers.size === 1) {
        this.dragging = true;
        this.dragged = false;
        this.lastX = ev.clientX;
        this.lastY = ev.clientY;
      } else {
        this.dragged = true;
        this.pinchDist = this.pointerSpan();
      }
    };
    this.onPointerMove = (ev: PointerEvent) => {
      if (!this.pointers.has(ev.pointerId)) return;
      this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (this.pointers.size >= 2) {
        const dist = this.pointerSpan();
        if (this.pinchDist > 8 && dist > 8) {
          this.userMoved = true;
          this.dragged = true;
          this.zoom(this.pinchDist / dist);
        }
        this.pinchDist = dist;
        return;
      }
      if (!this.dragging) return;
      const dx = ev.clientX - this.lastX;
      const dy = ev.clientY - this.lastY;
      this.lastX = ev.clientX;
      this.lastY = ev.clientY;
      if (dx * dx + dy * dy > 9) this.dragged = true;
      this.userMoved = true;
      this.turn(-dx * 0.005, dy * 0.004);
    };
    this.onPointerUp = (ev: PointerEvent) => {
      this.pointers.delete(ev.pointerId);
      if (this.pointers.size < 2) this.pinchDist = 0;
      if (this.pointers.size === 0) this.dragging = false;
      if (this.canvas.hasPointerCapture(ev.pointerId))
        this.canvas.releasePointerCapture(ev.pointerId);
    };
    this.onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      this.userMoved = true;
      this.zoom(Math.exp(ev.deltaY * 0.0012));
    };
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  setOcean(data: GpuOceanData): void {
    this.ocean.setData(data);
    this.hs = data.hs;
    this.hasOcean = true;
  }

  setEnvironment(env: Environment): void {
    this.env = env;
    this.weatherField = new WeatherField(this.weather, env);
    this.uploadGusts();
    this.ocean.setWaveParams(env.choppiness, env.depth);
    const current = currentVelocity(env);
    this.ocean.setCurrent(current.x, current.y);
    (this.ocean.uniforms.uWind!.value as number) = env.windSpeed;
    this.updateLighting(0);
  }

  setAmbience(settings: AmbienceSettings): void {
    this.ambience = { ...settings };
    this.applyAmbience();
  }

  setTimeOfDay(hours: number | null): void {
    this.timeOfDay = hours;
  }

  setStorminess(storminess: number | null): void {
    this.storminess = storminess;
  }

  private applyAmbience(): void {
    this.islands.setEnabled(this.ambience.islands);
    this.wildlife.setEnabled(this.ambience.wildlife);
    this.birds.setEnabled(this.ambience.wildlife);
    // Rubber ducks have no crew.
    this.sailors.setEnabled(this.ambience.sailors && !this.duckMode);
    this.planes.setEnabled(this.ambience.planes);
  }

  private updateLighting(dt: number) {
    if (!this.env) return null;
    const state = this.lighting.update({
      env: this.env,
      timeOfDay: this.ambience.dayNight ? this.timeOfDay : null,
      calm: this.calm,
      dt,
    });
    // updateWeather() dims these for cloud each frame, so hand it the clear-sky values.
    this.sunBase = this.sun.intensity;
    this.daylight = state.skyLight;
    this.lightState = state;
    return state;
  }

  setWeather(weather: Weather): void {
    this.weather = weather;
    if (this.env) {
      this.weatherField = new WeatherField(weather, this.env);
      this.uploadGusts();
    }
  }

  setQuality(quality: OceanQuality): void {
    if (quality === this.quality) return;
    this.quality = quality;
    this.oceanMesh.geometry.dispose();
    this.oceanMesh.geometry = createRadialOceanGeometry(OCEAN_SLICES[quality]);
    const budget = BUDGET[quality];
    this.scene.remove(this.rain.object, this.spray.object, this.smoke.object);
    this.rain.dispose();
    this.spray.dispose();
    this.smoke.dispose();
    this.rain = new RainField(budget.rain);
    this.spray = new SprayPool(budget.spray);
    this.smoke = new SprayPool(Math.round(budget.spray / 3), SMOKE_STYLE);
    this.scene.add(this.rain.object, this.spray.object, this.smoke.object);
    this.applyQualityUniforms();
    // The water's gust patches are switched off on low quality.
    this.uploadGusts();
  }

  private applyQualityUniforms(): void {
    const b = BUDGET[this.quality];
    this.ocean.uniforms.uCloudOctaves!.value = b.octaves;
    this.ocean.uniforms.uDetailCascades!.value = b.detail;
  }

  /** Gust modes for the water's cat's paws (same Fourier modes the vessels feel). */
  private uploadGusts(): void {
    const wf = this.weatherField;
    const u = this.ocean.uniforms;
    const slots = u.uGust!.value as THREE.Vector4[];
    const modes = wf?.modes ?? [];
    for (let i = 0; i < GUST_MODES; i++) {
      const m = modes[i];
      slots[i]!.set(m ? 2 * Math.PI * m.f : 0, m?.au ?? 0, m?.phaseU ?? 0, m?.cross ?? 0);
    }
    const lowEnd = this.quality === 'low';
    u.uGustCount!.value = lowEnd ? 0 : modes.length;
    u.uAdvect!.value = wf?.advection ?? 8;
    if (wf) (u.uWindDir!.value as THREE.Vector2).set(wf.dirX, wf.dirY);
    u.uSquallOn!.value = wf?.weather.squalls.enabled ? 1 : 0;
    u.uSquallDur!.value = (wf?.weather.squalls.durationMin ?? 4) * 60;
  }

  /** Per-frame weather at the camera: lights, sky, fog, rain, lightning and spindrift. */
  private updateWeather(t: number, dt: number): void {
    const wf = this.weatherField;
    const u = this.ocean.uniforms;
    const cam = this.camera.position;
    const wx = cam.x;
    const wy = -cam.z;
    let cloud = this.weather.cloudCover;
    let rain = this.weather.rainMmH;
    let flash = 0;
    let wind = this.env?.windSpeed ?? 0;
    if (wf) {
      wf.windAt(wx, wy, t, this.windSample);
      wind = this.windSample.speed;
      cloud = wf.cloudAt(wx, wy, t);
      rain = wf.rainAt(wx, wy, t);
      flash = wf.lightning(t, this.windSample.squall, rain);
      this.windThree.set(this.windSample.u, 0, -this.windSample.v);
      // The three squall fronts nearest the camera's local front time (the shader evaluates
      // them per pixel at τ = t − along/advection, like WeatherField.squall).
      const sq = this.weather.squalls;
      if (sq.enabled) {
        const interval = sq.intervalMin * 60;
        const tau = t - (wx * wf.dirX + wy * wf.dirY) / wf.advection;
        const k0 = Math.floor(tau / interval);
        const v = u.uSquall!.value as THREE.Vector4;
        const tk = (k: number) => (k < 0 ? -1e9 : wf.squallTime(k));
        v.set(tk(k0 - 1), tk(k0), tk(k0 + 1), 0);
      }
    } else {
      this.windThree.set(0, 0, 0);
    }
    u.uCloud!.value = cloud;
    u.uFlash!.value = flash;
    u.uRain!.value = rain;
    u.uWind!.value = wind;
    u.uWhitecap!.value = whitecapFraction(wind);
    u.uSkyTime!.value = t;
    const drift = u.uCloudDrift!.value as THREE.Vector2;
    // Cloud deck coordinates are in km; it drifts at ~1.5× the surface wind.
    const mean = wf ? wf.meanSpeed : 0;
    // The shader samples the deck at (position + drift), so features move by −drift: the
    // offset points upwind for the clouds to travel downwind with the gusts and squalls.
    drift.set(-(wf?.dirX ?? 0) * mean * 1.5 * t * 1e-3, (wf?.dirY ?? 0) * mean * 1.5 * t * 1e-3);
    const visibility = rainVisibilityKm(this.weather.visibilityKm, rain) * 1000;
    const density = 1.98 / Math.min(visibility, MAX_VIEW);
    u.uFogDensity!.value = density;
    this.fog.density = density;
    const light = this.daylight * (1 - 0.55 * cloud);
    this.localWind = wind;
    this.weatherStorm = Math.max(
      smooth(0.55, 1, cloud),
      Math.min(1, rain / 6),
      this.windSample.squall,
    );
    const ls = this.lightState;
    horizonColor(cloud, this.daylight, flash, this.fogColor, ls?.night ?? 0, ls?.dusk ?? 0);
    this.fog.color.copy(this.fogColor);
    this.renderer.setClearColor(this.fogColor, 1);
    this.sun.intensity = this.sunBase * (1 - 0.85 * smooth(0.3, 1, cloud));
    this.hemi.intensity = 0.9 * (0.45 + 0.55 * light) + flash * 2.5;
    this.renderer.toneMappingExposure = 1.05 * (1 + 0.35 * cloud) * (ls?.exposureScale ?? 1);
    if (ls) {
      this.hemi.color.copy(ls.hemiSky);
      this.hemi.groundColor.copy(ls.hemiGround);
    }

    const camDt = Number.isFinite(dt) ? Math.min(0.1, Math.max(0, dt)) : 0;
    this.rain.update(t, rain, this.windThree, light);
    this.emitSpray(camDt, wind);
    this.emitDamage(camDt);
    const pixelScale =
      this.renderer.getDrawingBufferSize(this.tmp2).y /
      (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    this.spray.update(camDt, this.windThree, light, pixelScale);
    this.smoke.update(camDt, this.windThree, light, pixelScale);
  }

  private readonly tmp2 = new THREE.Vector2();

  /** Bow spray from the vessels and spindrift off the crests in a gale. */
  private emitSpray(dt: number, wind: number): void {
    if (dt <= 0) return;
    const frame = this.frame;
    const budget = this.spray.capacity / 2600;
    for (const state of frame?.vessels ?? []) {
      const view = this.vessels.get(state.id);
      if (!view) continue;
      const def = view.definition;
      const kn = Math.max(0, state.speedKn);
      const heave = Math.min(1, Math.abs(state.bowAccel) / 9.81);
      const intensity =
        Math.min(1, kn / 18) * 0.5 +
        heave * 0.6 +
        (state.slamming || this.sprayBursts.has(state.id) ? 1.2 : 0) +
        (state.greenWater ? 0.8 : 0);
      if (intensity < 0.05) continue;
      const rate = intensity * 700 * budget * Math.sqrt(def.beam / 10);
      const n = Math.min(200, Math.floor(rate * dt + Math.random()));
      if (n <= 0) continue;
      const bow = rotate(state.attitude, {
        x: def.points.bow.x - def.length * 0.04,
        y: 0,
        z: def.points.bow.z - def.depth * 0.6,
      });
      const fwd = rotate(state.attitude, { x: 1, y: 0, z: 0 });
      const port = rotate(state.attitude, { x: 0, y: 1, z: 0 });
      const v = state.velocity;
      const up = 3 + 9 * intensity;
      for (const side of [1, -1]) {
        const out = 2 + 5 * intensity;
        this.spray.emit(
          {
            x: state.position.x + bow.x + port.x * side * def.beam * 0.3,
            y: state.position.z + bow.z,
            z: -(state.position.y + bow.y + port.y * side * def.beam * 0.3),
            vx: v.x * 0.6 + port.x * side * out + fwd.x * 1.5,
            vy: up,
            vz: -(v.y * 0.6 + port.y * side * out + fwd.y * 1.5),
            spread: 1.2 + 2 * intensity,
            size: (0.18 + def.beam * 0.012) * (1 + intensity),
            life: 0.9 + 0.8 * intensity,
          },
          Math.ceil(n / 2),
        );
      }
    }
    this.sprayBursts.clear();
    // Spindrift: from Beaufort 8 the wind tears spray off the breaking crests.
    if (wind > 16 && this.frame) {
      const strength = Math.min(1, (wind - 16) / 14);
      const n = Math.floor(strength * 500 * budget * dt + Math.random());
      const focus = this.tmp;
      const hs = this.ocean.uniforms.uHs!.value as number;
      for (let i = 0; i < n; i++) {
        const r = 30 + Math.random() * 220;
        const a = Math.random() * Math.PI * 2;
        this.spray.emit(
          {
            x: focus.x + r * Math.cos(a),
            y: Math.random() * hs * 0.5,
            z: focus.z + r * Math.sin(a),
            vx: this.windThree.x * 0.5,
            vy: 1 + Math.random() * 3,
            vz: this.windThree.z * 0.5,
            spread: 1.5,
            size: 0.4 + strength * 0.6,
            life: 1.5 + strength,
          },
          1,
        );
      }
    }
  }

  /** Darken the paint toward soot and scorch as health falls (1 intact, 0 wrecked). */
  private applyDamageLook(view: VesselView, health: number): void {
    const h = Number.isFinite(health) ? Math.min(1, Math.max(0, health)) : 1;
    if (Math.abs(h - view.shownHealth) < 0.01) return;
    view.shownHealth = h;
    const k = 1 - 0.55 * (1 - h) ** 1.3;
    view.materials.forEach((mat, i) => {
      const base = view.baseColors[i];
      if (!base) return;
      // Soot is warm and dark: blue fades first.
      mat.color.setRGB(base.r * k, base.g * k * (0.97 + 0.03 * h), base.b * k * (0.9 + 0.1 * h));
    });
  }

  /** Smoke from damaged ships and a burst of spray where hulls collide. */
  private emitDamage(dt: number): void {
    if (dt <= 0 || !this.frame) return;
    const budget = this.smoke.capacity / 860;
    for (const state of this.frame.vessels) {
      const view = this.vessels.get(state.id);
      if (!view || !view.group.visible || state.capsized) continue;
      const loss = 1 - (Number.isFinite(state.health) ? state.health : 1);
      // Smoke from about a fifth of the health gone, thickening until the ship is wrecked.
      const level = Math.max(0, (loss - 0.2) / 0.8) + (state.disabled ? 0.4 : 0);
      if (level <= 0) continue;
      const def = view.definition;
      const scale = Math.sqrt(Math.max(def.beam, 2) / 10);
      const n = Math.min(40, Math.floor(level * 45 * budget * scale * dt + Math.random()));
      if (n <= 0) continue;
      const at = rotate(state.attitude, view.smokeFrom);
      const v = state.velocity;
      this.smoke.emit(
        {
          x: state.position.x + at.x,
          y: state.position.z + at.z,
          z: -(state.position.y + at.y),
          vx: v.x,
          vy: 2 + 3 * level,
          vz: -v.y,
          spread: 0.6 + 0.4 * scale,
          size: (0.8 + def.beam * 0.06) * (0.7 + 0.6 * level),
          life: 4 + 4 * level,
        },
        n,
      );
    }
    const seen = this.seenCollisions;
    for (const hit of this.frame.collisions ?? []) {
      const key = `${hit.t.toFixed(3)}:${hit.a}:${hit.b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const sev = Math.min(1, Math.max(0.05, hit.severity));
      const a = this.vessels.get(hit.a)?.definition;
      const size = a ? 0.3 + a.beam * 0.02 : 0.5;
      this.spray.emit(
        {
          x: hit.x,
          y: 1,
          z: -hit.y,
          vx: 0,
          vy: 5 + 9 * sev,
          vz: 0,
          spread: 3 + 5 * sev,
          size: size * (1 + sev),
          life: 1.2 + sev,
        },
        Math.round(40 + 160 * sev),
      );
      this.smoke.emit(
        {
          x: hit.x,
          y: 2,
          z: -hit.y,
          vx: 0,
          vy: 2,
          vz: 0,
          spread: 1.5,
          size: 1.5 + 2 * sev,
          life: 3 + 3 * sev,
        },
        Math.round(6 + 24 * sev),
      );
    }
    if (seen.size > 256) seen.clear();
  }

  setVessels(vessels: readonly { id: string; definition: VesselDefinition }[]): void {
    for (const layer of this.layers) layer.setVessels?.([]);
    for (const view of this.vessels.values()) this.disposeVessel(view);
    this.vessels.clear();
    this.wakes.clear();
    const probes = this.pickables.filter((obj) => obj.userData.pickKind === 'probe');
    this.pickables.length = 0;
    this.pickables.push(...probes);
    let maxLength = 30;
    for (const { id, definition } of vessels) {
      const view = this.buildVessel(id, definition);
      this.vessels.set(id, view);
      this.scene.add(view.group);
      this.pickables.push(view.group);
      maxLength = Math.max(maxLength, definition.length);
    }
    if (!this.userMoved) this.radius = THREE.MathUtils.clamp(maxLength * 2.4, 28, 700);
    const views = [...this.vessels.values()];
    for (const layer of this.layers) layer.setVessels?.(views);
    this.applySelection();
  }

  setProbes(probes: readonly ProbeConfig[]): void {
    for (let i = this.pickables.length - 1; i >= 0; i--) {
      if (this.pickables[i]?.userData.pickKind === 'probe') this.pickables.splice(i, 1);
    }
    for (const obj of this.probes.values()) {
      this.scene.remove(obj);
      obj.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          const mat = child.material;
          if (!Array.isArray(mat)) mat.dispose();
        }
      });
    }
    this.probes.clear();
    for (const probe of probes) {
      const group = new THREE.Group();
      group.userData.pickKind = 'probe';
      group.userData.pickId = probe.id;
      const buoy = new THREE.Mesh(
        new THREE.SphereGeometry(0.55, 16, 12),
        new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.45, metalness: 0.05 }),
      );
      buoy.position.y = 0.4;
      buoy.userData.pickKind = 'probe';
      buoy.userData.pickId = probe.id;
      const mast = new THREE.Mesh(
        new THREE.CylinderGeometry(0.06, 0.06, 2.2, 8),
        new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.6 }),
      );
      mast.position.y = 1.5;
      mast.userData.pickKind = 'probe';
      mast.userData.pickId = probe.id;
      group.add(buoy, mast);
      group.position.set(probe.x, 0, -probe.y);
      this.scene.add(group);
      this.probes.set(probe.id, group);
      this.pickables.push(group);
    }
  }

  setFrame(frame: SimFrame): void {
    if (this.frame && frame.t > this.frame.t + 1e-6) this.prevFrame = this.frame;
    else if (!this.frame || frame.t + 1e-4 < this.frame.t) this.prevFrame = null;
    this.frame = frame;
    this.poseAt(frame.t);
    for (const state of frame.vessels) {
      const view = this.vessels.get(state.id);
      if (view) this.applyDamageLook(view, state.health);
    }
    this.applySelection();
  }

  /** Draw the sea and ships at a time that moves every animation frame. */
  setVisualTime(t: number): void {
    this.shownT = t;
  }

  private poseAt(t: number): void {
    const latest = this.frame;
    if (!latest) return;
    const previous = this.prevFrame;
    const span = previous && latest.t > previous.t ? latest.t - previous.t : 0;
    const blend = previous && span > 0 ? Math.min(1, Math.max(0, (t - previous.t) / span)) : 1;
    for (const state of latest.vessels) {
      const before =
        blend < 1 && previous ? previous.vessels.find((v) => v.id === state.id) : undefined;
      this.applyVessel(state, before, blend);
    }
    for (const reading of latest.probes) {
      const probe = this.probes.get(reading.id);
      if (!probe) continue;
      const earlier = previous?.probes.find((p) => p.id === reading.id);
      const eta =
        earlier && blend < 1 ? earlier.eta + (reading.eta - earlier.eta) * blend : reading.eta;
      probe.position.y = eta;
    }
  }

  private applyVessel(
    state: SimFrame['vessels'][number],
    before: SimFrame['vessels'][number] | undefined,
    blend: number,
  ): void {
    const view = this.vessels.get(state.id);
    if (!view) return;
    const u = before ? blend : 1;
    const px = before
      ? before.position.x + (state.position.x - before.position.x) * u
      : state.position.x;
    const py = before
      ? before.position.y + (state.position.y - before.position.y) * u
      : state.position.y;
    const pz = before
      ? before.position.z + (state.position.z - before.position.z) * u
      : state.position.z;
    view.group.position.set(px, pz, -py);
    if (before) {
      attitudeToThree(before.attitude, this.quatA);
      attitudeToThree(state.attitude, this.quatB);
      this.quatA.slerp(this.quatB, u);
      view.group.quaternion.copy(this.quatA);
    } else {
      attitudeToThree(state.attitude, view.group.quaternion);
    }
    view.group.userData.capsized = state.capsized;
    view.rig?.update(state.sailSet, state.braceDeg, state.apparentWindAngleDeg, state.apparentWind);
  }

  setOverlay(mode: OverlayMode): void {
    const value = mode === 'height' ? 1 : mode === 'steepness' ? 2 : mode === 'foam' ? 3 : 0;
    this.ocean.uniforms.uOverlay!.value = value;
  }

  setCamera(mode: CameraMode, targetId?: string | null): void {
    this.mode = mode;
    if (mode === 'follow' || mode === 'bridge') this.explore = null;
    if (targetId !== undefined) this.cameraTarget = targetId ?? null;
  }

  planeRide(): string | null {
    return this.mode === 'plane' ? this.planes.rideLabel : null;
  }

  getNavigation(): NavigationView {
    return cameraNavigation(this.camera, this.explore);
  }

  mapIslands(x: number, y: number, radius: number): MapIsland[] {
    return this.ambience.islands ? chartIslands(x, y, radius) : [];
  }

  setExplorePoint(point: { x: number; y: number } | null): void {
    if (!point) {
      this.explore = null;
      return;
    }
    this.exploreFrom.copy(this.orbitCentre);
    this.explore = new THREE.Vector3(point.x, 0, -point.y);
    this.exploreGlide = 0;
  }

  setSelection(id: string | null): void {
    this.selection = id;
    this.applySelection();
  }

  render(): void {
    if (this.disposed) return;
    const gl = this.renderer.getContext();
    if (gl.isContextLost()) return;
    const t0 = performance.now();
    const t = this.shownT || this.frame?.t || 0;
    this.poseAt(t);
    this.updateWakes(t);
    this.ocean.update(t);
    // Count only the scene draw, not the FFT passes, so the numbers are steady frame to frame.
    this.renderer.info.reset();
    this.tickWall(t0);
    this.updateCamera();
    this.fitNearPlane();
    this.updateScenery(t);
    this.sky.position.copy(this.camera.position);
    // The radial mesh follows the camera and is scaled with its height above the water, so
    // the triangles stay about the same size on screen from any view (no top-down blockiness).
    const height = Math.max(1, Math.abs(this.camera.position.y));
    const scale = THREE.MathUtils.clamp(height * OCEAN_DENSITY[this.quality], 0.05, 10);
    this.oceanMesh.scale.setScalar(scale);
    this.oceanMesh.position.set(this.camera.position.x, 0, this.camera.position.z);
    this.ocean.uniforms.uMeshScale!.value = scale;
    const dt = t - this.lastRenderT;
    this.lastRenderT = t;
    this.updateWeather(t, dt);
    this.renderer.render(this.scene, this.camera);
    const now = performance.now();
    this.stats.frameMs = now - t0;
    this.stats.drawCalls = this.renderer.info.render.calls;
    this.stats.triangles = this.renderer.info.render.triangles;
    // Frame rate from the interval between frames, not the time spent inside render().
    if (this.lastFrameAt > 0) {
      this.fpsFrames += 1;
      this.fpsElapsed += now - this.lastFrameAt;
    }
    this.lastFrameAt = now;
    if (this.fpsElapsed >= 500) {
      this.stats.fps = (this.fpsFrames / this.fpsElapsed) * 1000;
      this.fpsFrames = 0;
      this.fpsElapsed = 0;
    }
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
  }

  setDuckMode(on: boolean): void {
    this.duckMode = on;
    this.applyAmbience();
    for (const view of this.vessels.values()) this.applyDuck(view);
  }

  private applyDuck(view: VesselView): void {
    for (const child of view.group.children) {
      child.visible = child.name === 'duck' ? this.duckMode : !this.duckMode;
    }
  }

  pick(x: number, y: number): PickResult | null {
    if (this.dragged) {
      this.dragged = false;
      return null;
    }
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    this.pointer.set((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    this.scene.updateMatrixWorld(true);
    const hits = this.raycaster.intersectObjects(this.pickables, true);
    for (const hit of hits) {
      let obj: THREE.Object3D | null = hit.object;
      while (obj) {
        const kind = obj.userData.pickKind as string | undefined;
        const id = obj.userData.pickId as string | undefined;
        if ((kind === 'vessel' || kind === 'probe') && id) {
          const p = hit.point;
          return { kind, id, point: { x: p.x, y: -p.z, z: p.y } };
        }
        obj = obj.parent;
      }
    }
    const planeHit = new THREE.Vector3();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    if (!this.raycaster.ray.intersectPlane(plane, planeHit)) return null;
    return { kind: 'water', point: { x: planeHit.x, y: -planeHit.z, z: planeHit.y } };
  }

  /** Advance the wall clock the scenery runs on (before the camera, which may ride a plane). */
  private tickWall(now: number): void {
    const dt =
      this.lastRenderAt > 0 ? Math.min(0.1, Math.max(0, (now - this.lastRenderAt) / 1000)) : 0;
    this.lastRenderAt = now;
    this.wallT += dt;
    this.wallDt = dt;
  }

  private updateScenery(t: number): void {
    const dt = this.wallDt;
    const windSpeed = this.weatherField ? this.localWind : (this.env?.windSpeed ?? 0);
    const storm = Math.max(this.weatherStorm, this.storminess ?? 0);
    const target = calmFromConditions(this.hs, windSpeed, storm);
    // Until the sea is known, report no calm (nothing spawns), then start from the real value.
    const known = this.env !== null && this.hasOcean;
    this.calm = !known ? 0 : this.calmPrimed ? ease(this.calm, target, dt, 6) : target;
    this.calmPrimed = known;
    const light = this.updateLighting(dt);
    const vessels = this.frame?.vessels ?? [];
    while (this.vesselPositions.length < vessels.length)
      this.vesselPositions.push(new THREE.Vector3());
    this.vesselPositions.length = vessels.length;
    vessels.forEach((v, i) => {
      const view = this.vessels.get(v.id);
      if (view) this.vesselPositions[i]!.copy(view.group.position);
      else worldToThree(v.position, this.vesselPositions[i]!);
    });
    const frame: SceneryFrame = {
      t,
      dt,
      wallT: this.wallT,
      camera: this.camera,
      bridgeView: this.mode === 'bridge',
      calm: this.calm,
      daylight: light?.daylight ?? 1,
      timeOfDay: light?.timeOfDay ?? 12,
      sunDir: light?.sunDir ?? (this.ocean.uniforms.uSunDir!.value as THREE.Vector3),
      windSpeed,
      windDirectionDeg: this.env?.windDirectionDeg ?? 0,
      hs: this.hs,
      vessels,
      vesselPositions: this.vesselPositions,
    };
    for (const layer of this.layers) layer.update(frame);
  }

  /** Ship wakes along each hull's track (visual only; see scene/wakes.ts). */
  private updateWakes(t: number): void {
    const sources = this.wakeSources;
    sources.length = 0;
    const env = this.env;
    const current = env ? currentVelocity(env) : { x: 0, y: 0 };
    for (const state of this.frame?.vessels ?? []) {
      const view = this.vessels.get(state.id);
      if (!view || view.group.userData.capsized === true) continue;
      const def = view.definition;
      // Drawn pose (interpolated between physics frames), so the wake meets the hull exactly.
      const p = view.group.position;
      const fwd = this.tmpV.set(1, 0, 0).applyQuaternion(view.group.quaternion);
      const fx = fwd.x;
      const fy = -fwd.z;
      const norm = Math.hypot(fx, fy) || 1;
      const bowX = def.points.bow.x;
      const sternX = def.points.propeller.x;
      sources.push({
        id: state.id,
        length: def.length,
        beam: def.beam,
        bow: { x: p.x + (fx / norm) * bowX, y: -p.z + (fy / norm) * bowX },
        stern: { x: p.x + (fx / norm) * sternX, y: -p.z + (fy / norm) * sternX },
        speed: Math.hypot(state.velocity.x - current.x, state.velocity.y - current.y),
      });
    }
    this.wakes.update(t, sources, { x: current.x * t, y: current.y * t });
    this.ocean.uniforms.uWakeCount!.value = this.wakes.count;
  }

  private pointerSpan(): number {
    const pts = [...this.pointers.values()];
    const a = pts[0];
    const b = pts[1];
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  nudgeCamera(action: 'left' | 'right' | 'up' | 'down' | 'in' | 'out' | 'reset'): void {
    this.userMoved = action !== 'reset';
    if (action === 'reset') {
      if (this.mode === 'plane') {
        this.planeYaw = 0;
        this.planeDip = PLANE_LOOK.dip;
        this.planeChase = PLANE_LOOK.chase;
        return;
      }
      this.yaw = 0.65;
      this.polar = 0.95;
      this.radius = 180;
      this.userMoved = false;
      return;
    }
    if (action === 'left') this.turn(-0.08, 0);
    if (action === 'right') this.turn(0.08, 0);
    if (action === 'up') this.turn(0, -0.05);
    if (action === 'down') this.turn(0, 0.05);
    if (action === 'in') this.zoom(0.9);
    if (action === 'out') this.zoom(1.11);
  }

  /**
   * Drag or arrow keys. The orbit cameras swing round their target; from a plane the gaze
   * turns (dragging up looks further down, like the orbit camera rising).
   */
  private turn(yaw: number, polar: number): void {
    if (this.mode === 'plane') {
      this.planeYaw += yaw;
      this.planeDip = THREE.MathUtils.clamp(
        this.planeDip - polar,
        PLANE_LOOK.minDip,
        PLANE_LOOK.maxDip,
      );
      return;
    }
    this.yaw += yaw;
    this.polar = THREE.MathUtils.clamp(this.polar + polar, 0.12, 1.42);
  }

  /** Wheel, pinch or +/−: orbit distance, or how far behind the aircraft the plane view sits. */
  private zoom(factor: number): void {
    if (this.mode === 'plane') {
      this.planeChase = THREE.MathUtils.clamp(
        this.planeChase * factor,
        PLANE_LOOK.minChase,
        PLANE_LOOK.maxChase,
      );
      return;
    }
    this.radius = THREE.MathUtils.clamp(this.radius * factor, 6, 4000);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    for (const layer of this.layers) layer.setVessels?.([]);
    for (const view of this.vessels.values()) this.disposeVessel(view);
    for (const layer of this.layers) {
      this.scene.remove(layer.object);
      layer.dispose();
    }
    this.lighting.dispose();
    this.setProbes([]);
    this.ocean.dispose();
    this.oceanMesh.geometry.dispose();
    (this.oceanMesh.material as THREE.Material).dispose();
    this.sky.geometry.dispose();
    (this.sky.material as THREE.Material).dispose();
    this.rain.dispose();
    this.spray.dispose();
    this.smoke.dispose();
    this.wakes.dispose();
    this.renderer.dispose();
  }

  private buildVessel(id: string, definition: VesselDefinition): VesselView {
    const group = new THREE.Group();
    group.userData.pickKind = 'vessel';
    group.userData.pickId = id;
    const materials: THREE.MeshStandardMaterial[] = [];
    const textures: THREE.Texture[] = [];
    const palette = definition.palette;
    const hullMat = this.material('hull', palette);
    hullMat.vertexColors = true;
    hullMat.roughness = definition.sails ? 0.75 : 0.42;
    hullMat.metalness = definition.sails ? 0 : 0.12;
    materials.push(hullMat);
    group.add(
      this.meshFromHull(
        definition.renderHull.positions,
        definition.renderHull.indices,
        hullMat,
        id,
        definition.designDraft - definition.kg,
        definition.paint,
      ),
    );
    const duck = buildDuck(definition.length, definition.draft - definition.kg, id);
    materials.push(...duck.materials);
    group.add(duck.group);

    const shared = new Map<string, THREE.MeshStandardMaterial>();
    // Top of the hull (sheer) in the body frame, so overhanging decks can be closed down to it.
    let hullTop = -Infinity;
    const hullPos = definition.renderHull.positions;
    for (let i = 2; i < hullPos.length; i += 3) hullTop = Math.max(hullTop, hullPos[i]!);
    let deckSides: THREE.MeshStandardMaterial | null = null;
    let order = 0;
    let decks = 0;
    for (const box of definition.superstructure) {
      // Masts of a rigged ship are drawn round by the rig; their boxes only count as windage.
      if (definition.sails && box.material === 'wood' && box.size.x < 1 && box.size.y < 1) continue;
      let mat = shared.get(box.material);
      if (!mat) {
        mat = this.material(box.material, palette);
        if (box.material === 'glass') {
          mat.userData.glass = true;
          mat.transparent = true;
          mat.opacity = 0.45;
          mat.roughness = 0.05;
        }
        if (box.material === 'flag') {
          const tex = jollyRogerTexture();
          textures.push(tex);
          mat.map = tex;
          mat.color.set(0xffffff);
          mat.side = THREE.DoubleSide;
        }
        if (box.material === 'flightdeck') {
          const tex = flightDeckTexture();
          textures.push(tex);
          mat.map = tex;
          mat.color.set(0xffffff);
        }
        materials.push(mat);
        shared.set(box.material, mat);
      }
      // Boxes overlap freely (decks over decks, containers in stacks). Grow each one by a few
      // millimetres more than the one before so coincident faces have a fixed winner instead
      // of flickering between the two every frame.
      const grow = 0.004 * ++order;
      let sz = box.size.z + grow;
      let cz = box.center.z;
      let boxMat: THREE.Material | THREE.Material[] = mat;
      if (box.material === 'flightdeck') {
        // Close the gap between an overhanging flight deck and the hull's sheer line.
        const bottom = Math.min(cz - box.size.z / 2, hullTop - 0.2);
        // Stacked deck surfaces (the angled landing deck over the main deck) step up 3 cm each:
        // invisible, but far above what any depth buffer resolves.
        const top = cz + box.size.z / 2 + 0.03 * decks++;
        sz = top - bottom;
        cz = (top + bottom) / 2;
        // Deck markings belong on the top face only; the edges are plain painted steel.
        if (!deckSides) {
          deckSides = this.material('superstructure', palette);
          deckSides.color.set(palette.flightdeck ?? HULL_COLORS.flightdeck).multiplyScalar(0.8);
          materials.push(deckSides);
        }
        boxMat = [deckSides, deckSides, mat, deckSides, deckSides, deckSides];
      }
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(box.size.x + grow, sz, box.size.y + grow),
        boxMat,
      );
      mesh.position.set(box.center.x, cz, -box.center.y);
      if (box.yawDeg) mesh.rotation.y = THREE.MathUtils.degToRad(box.yawDeg);
      mesh.userData.pickKind = 'vessel';
      mesh.userData.pickId = id;
      group.add(mesh);
    }

    let rig: RigView | null = null;
    if (definition.sails) {
      rig = new RigView(
        definition.sails,
        { wood: palette.wood ?? HULL_COLORS.wood, sail: palette.sail ?? HULL_COLORS.sail },
        id,
      );
      group.add(rig.group);
    } else {
      const prop = definition.points.propeller;
      const propMat = this.material('accent', {});
      materials.push(propMat);
      const disc = new THREE.Mesh(
        new THREE.CylinderGeometry(
          Math.max(0.15, definition.propulsion.propellerDiameter / 2),
          Math.max(0.15, definition.propulsion.propellerDiameter / 2),
          0.12,
          14,
        ),
        propMat,
      );
      disc.rotation.z = Math.PI / 2;
      disc.position.set(prop.x, prop.z, -prop.y);
      disc.userData.pickKind = 'vessel';
      disc.userData.pickId = id;
      group.add(disc);
    }

    // Smoke leaves from the top of the tallest deckhouse (the funnel on most ships).
    let smokeFrom: Vec3 = { x: definition.points.bridge.x, y: 0, z: hullTop + 1 };
    let topZ = -Infinity;
    for (const box of definition.superstructure) {
      if (box.material !== 'superstructure' && box.material !== 'accent') continue;
      const z = box.center.z + box.size.z / 2;
      if (z > topZ && box.size.x > 1 && box.size.y > 1) {
        topZ = z;
        smokeFrom = { x: box.center.x, y: box.center.y, z };
      }
    }
    const view: VesselView = {
      id,
      definition,
      group,
      materials,
      textures,
      rig,
      baseColors: materials.map((m) => m.color.clone()),
      shownHealth: 1,
      smokeFrom,
      bounds: vesselBounds(definition),
    };
    this.applyDuck(view);
    return view;
  }

  private meshFromHull(
    src: Float32Array,
    indices: Uint32Array,
    material: THREE.Material,
    id: string,
    waterlineZ: number,
    paint: VesselDefinition['paint'],
  ): THREE.Mesh {
    const bottom = new THREE.Color(paint.bottom);
    const boot = new THREE.Color(paint.boot);
    const top = new THREE.Color(paint.topside);
    const positions = new Float32Array(src.length);
    const colors = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
      positions[i] = src[i]!;
      positions[i + 1] = src[i + 2]!;
      positions[i + 2] = -src[i + 1]!;
      const z = src[i + 2]!;
      const paint = z < waterlineZ - 0.15 ? bottom : z < waterlineZ + 0.35 ? boot : top;
      colors[i] = paint.r;
      colors[i + 1] = paint.g;
      colors[i + 2] = paint.b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, material);
    mesh.userData.pickKind = 'vessel';
    mesh.userData.pickId = id;
    return mesh;
  }

  private material(
    kind: VisualMaterial,
    palette: Partial<Record<VisualMaterial, number>>,
  ): THREE.MeshStandardMaterial {
    if (kind === 'hull') {
      return new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        roughness: 0.32,
        metalness: 0.06,
        clearcoat: 0.55,
        clearcoatRoughness: 0.22,
      });
    }
    return new THREE.MeshStandardMaterial({
      color: palette[kind] ?? HULL_COLORS[kind],
      roughness:
        kind === 'superstructure' ? 0.45 : kind === 'gold' ? 0.35 : kind === 'wood' ? 0.8 : 0.62,
      metalness: kind === 'accent' ? 0.35 : kind === 'gold' ? 0.75 : 0.04,
    });
  }

  private disposeVessel(view: VesselView): void {
    this.scene.remove(view.group);
    view.group.traverse((child) => {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    });
    for (const mat of view.materials) mat.dispose();
    for (const tex of view.textures) tex.dispose();
    view.rig?.dispose();
  }

  private applySelection(): void {
    // A light amber hint, dimmer at night (emissive ignores lighting, so a strong tint glowed
    // in the dark), and none on the ship the Follow or Bridge camera is riding: there the
    // selection only says which ship to follow and washed it flat amber.
    const riding = this.mode === 'follow' || this.mode === 'bridge' ? this.focusVessel()?.id : null;
    const tint = 0.05 + 0.13 * Math.min(1, Math.max(0, this.daylight));
    for (const view of this.vessels.values()) {
      const selected = view.id === this.selection && view.id !== riding;
      const capsized = view.group.userData.capsized === true;
      const glassHidden = this.mode === 'bridge' && view.id === riding;
      for (const mat of view.materials) {
        mat.emissive.set(selected ? 0xfbbf24 : capsized ? 0x7f1d1d : 0x000000);
        mat.emissiveIntensity = selected ? tint : capsized ? 0.3 : 0;
        // From the bridge the wheelhouse windows are around the eye: drawing their tinted
        // slab over half the view hid the sea ahead.
        if (mat.userData.glass) mat.visible = !glassHidden;
      }
    }
    for (const [id, probe] of this.probes) {
      const selected = id === this.selection;
      probe.scale.setScalar(selected ? 1.45 : 1);
    }
  }

  private focusVessel(): VesselView | undefined {
    const id =
      this.cameraTarget ??
      (this.selection && this.vessels.has(this.selection) ? this.selection : undefined) ??
      this.vessels.keys().next().value;
    return id ? this.vessels.get(id) : undefined;
  }

  private updateCamera(): void {
    if (this.updateRide()) return;
    const focus = this.focusVessel();
    const target = this.tmp;
    if (this.explore && (this.mode === 'orbit' || this.mode === 'top')) {
      this.exploreGlide = Math.min(1, this.exploreGlide + 0.035);
      const k = this.exploreGlide * this.exploreGlide * (3 - 2 * this.exploreGlide);
      target.lerpVectors(this.exploreFrom, this.explore, k);
      this.placeOrbit(target, this.yaw, this.mode === 'top' ? 0.12 : this.polar, this.radius);
      return;
    }
    if (focus && this.frame) {
      const state = this.frame.vessels.find((v) => v.id === focus.id);
      if (state && (this.mode === 'follow' || this.mode === 'bridge' || this.mode === 'top')) {
        target.set(state.position.x, state.position.z, -state.position.y);
        if (this.mode === 'bridge') {
          this.placeBridgeCamera(state.position, state.attitude, focus.definition);
          return;
        }
        const bow = rotate(state.attitude, { x: 1, y: 0, z: 0 });
        const bowThree = worldToThree(bow, this.look);
        const behind = Math.atan2(bowThree.x, bowThree.z) + Math.PI;
        const azimuth = this.mode === 'follow' ? behind + this.yaw : this.yaw;
        const polar = this.mode === 'top' ? 0.12 : this.polar;
        this.placeOrbit(
          target,
          azimuth,
          polar,
          this.mode === 'top' ? Math.max(this.radius, focus.definition.length) : this.radius,
        );
        return;
      }
      if (state) target.set(state.position.x, state.position.z, -state.position.y);
      else target.set(0, 0, 0);
    } else {
      target.set(0, 0, 0);
    }
    const polar = this.mode === 'top' ? 0.12 : this.polar;
    this.placeOrbit(target, this.yaw, polar, this.radius);
  }

  /**
   * Keep (or let go of) the lost flight the Plane camera rides, circling over the fleet, and
   * put the camera aboard. False when the camera is not riding (or the flight is not there yet).
   */
  private updateRide(): boolean {
    const riding = this.mode === 'plane';
    const c = this.rideCentre;
    c.x = 0;
    c.z = 0;
    let n = 0;
    for (const view of this.vessels.values()) {
      if (!view.group.visible) continue;
      c.x += view.group.position.x;
      c.z += view.group.position.z;
      n++;
    }
    if (n > 0) {
      c.x /= n;
      c.z /= n;
    }
    // A point picked on the chart: the flight takes its circuit over there instead.
    if (this.explore) {
      c.x = this.explore.x;
      c.z = this.explore.z;
    }
    this.planes.updateRide(this.wallT, this.wallDt, riding, c, this.calm);
    if (!riding) return false;
    const p = this.planes.ridePose(this.wallT, this.ridePose);
    if (!p) return false;
    // Gaze toward the circuit's centre (the fleet), turned and dipped by the viewer.
    const az = Math.atan2(c.z - p.z, c.x - p.x) + this.planeYaw;
    const dip = this.planeDip;
    const gx = Math.cos(dip) * Math.cos(az);
    const gy = -Math.sin(dip);
    const gz = Math.cos(dip) * Math.sin(az);
    // Screen-up, square to the gaze: the seat is a little above it so the aircraft rides
    // low in the frame and the view past it stays clear.
    const ux = Math.sin(dip) * Math.cos(az);
    const uy = Math.cos(dip);
    const uz = Math.sin(dip) * Math.sin(az);
    const back = this.planeChase;
    const lift = back * PLANE_LOOK.lift;
    this.camera.up.set(ux, uy, uz);
    this.camera.position.set(
      p.x - gx * back + ux * lift,
      p.y - gy * back + uy * lift,
      p.z - gz * back + uz * lift,
    );
    this.camera.lookAt(
      this.camera.position.x + gx,
      this.camera.position.y + gy,
      this.camera.position.z + gz,
    );
    return true;
  }

  /**
   * Push the near plane out as far as the view allows. Depth precision scales with the near
   * distance, so a fixed 0.2 m near plane made decks and superstructure z-fight on ships a few
   * hundred metres away (the main cause of the "glitchy" vessel textures without reversed depth).
   */
  private fitNearPlane(): void {
    let near = 0.2;
    if (this.mode === 'plane') {
      near = THREE.MathUtils.clamp(this.planeChase * 0.05, 0.5, 6);
    } else if (this.mode !== 'bridge') {
      const hs = (this.ocean.uniforms.uHs?.value as number | undefined) ?? 0;
      // Never clip the nearest crest: stay well inside the camera's height above the waves.
      const clearance = Math.max(0.4, this.camera.position.y - Math.max(1, hs));
      near = THREE.MathUtils.clamp(Math.min(this.radius * 0.015, clearance * 0.5), 0.2, 6);
    }
    if (Math.abs(near - this.camera.near) > 0.02 * near) {
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }
  }

  private placeBridgeCamera(position: Vec3, attitude: Quat, definition: VesselDefinition): void {
    const bow = rotate(attitude, { x: 1, y: 0, z: 0 });
    const up = rotate(attitude, { x: 0, y: 0, z: 1 });
    const bridge = rotate(attitude, definition.points.bridge);
    const eye = {
      x: position.x + bridge.x + up.x * 0.8,
      y: position.y + bridge.y + up.y * 0.8,
      z: position.z + bridge.z + up.z * 0.8,
    };
    const side = rotate(attitude, { x: 0, y: 1, z: 0 });
    const yaw = this.yaw;
    // Up/down tilts the gaze from about 25° down to 65° up (to the stars at night).
    const pitch = THREE.MathUtils.clamp((0.95 - this.polar) * 1.4, -0.45, 1.15);
    const ahead = Math.cos(pitch) * 40;
    const rise = Math.sin(pitch) * 40;
    const lookAt = {
      x: eye.x + (bow.x * Math.cos(yaw) + side.x * Math.sin(yaw)) * ahead + up.x * rise,
      y: eye.y + (bow.y * Math.cos(yaw) + side.y * Math.sin(yaw)) * ahead + up.y * rise,
      z: eye.z + (bow.z * Math.cos(yaw) + side.z * Math.sin(yaw)) * ahead + up.z * rise,
    };
    this.orbitCentre.set(eye.x, 0, -eye.y);
    this.camera.up.set(up.x, up.z, -up.y);
    this.camera.position.set(eye.x, eye.z, -eye.y);
    this.camera.lookAt(lookAt.x, lookAt.z, -lookAt.y);
  }

  private placeOrbit(target: THREE.Vector3, azimuth: number, polar: number, radius: number): void {
    this.orbitCentre.copy(target);
    // Back the camera out along its ray until it is outside every hull, so zooming in on a
    // big ship never parks the lens inside it (a solid black frame).
    let r = radius;
    for (let i = 0; i < 40; i++) {
      this.setOrbit(target, azimuth, polar, r);
      if (!this.insideVessel(this.camera.position)) break;
      r *= 1.12;
    }
  }

  private insideVessel(p: THREE.Vector3): boolean {
    for (const view of this.vessels.values()) {
      if (!view.group.visible) continue;
      view.group.updateMatrixWorld();
      const local = this.tmpV.copy(p);
      view.group.worldToLocal(local);
      const b = view.bounds;
      const m = 1.5;
      if (
        local.x > b.min.x - m &&
        local.x < b.max.x + m &&
        local.y > b.min.y - m &&
        local.y < b.max.y + m &&
        local.z > b.min.z - m &&
        local.z < b.max.z + m
      )
        return true;
    }
    return false;
  }

  private setOrbit(target: THREE.Vector3, azimuth: number, polar: number, radius: number): void {
    this.camera.up.set(0, 1, 0);
    this.camera.position.set(
      target.x + radius * Math.sin(polar) * Math.sin(azimuth),
      target.y + radius * Math.cos(polar),
      target.z + radius * Math.sin(polar) * Math.cos(azimuth),
    );
    this.camera.lookAt(target);
  }
}
