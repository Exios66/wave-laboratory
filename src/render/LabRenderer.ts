/**
 * WebGL 2 view of the lab: GPU FFT ocean, vessels, gauges and cameras.
 * World space is z-up; the Three.js scene is y-up via (x, y, z) → (x, z, −y).
 */
import * as THREE from 'three';
import { rotate, type Quat, type Vec3 } from '../core/vec';
import type { GpuOceanData } from '../ocean/gpuData';
import type { Environment, ProbeConfig } from '../schema/experiment';
import type { SimFrame } from '../sim/types';
import type { VesselDefinition } from '../vessel/api';
import type { CameraMode, LabRendererApi, OverlayMode, PickResult, RendererStats } from './api';
import { GpuOcean } from './ocean/GpuOcean';
import { OCEAN_FRAG, OCEAN_VERT, SKY_FRAG, SKY_VERT } from './ocean/shaders';

export interface LabRendererOptions {
  onContextLost?: () => void;
  onContextRestored?: () => void;
}

const Q_WORLD_TO_THREE = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(1, 0, 0),
  -Math.PI / 2,
);
const Q_THREE_TO_WORLD = Q_WORLD_TO_THREE.clone().invert();

const HULL_COLORS: Record<string, number> = {
  hull: 0xffffff,
  deck: 0x4b5568,
  superstructure: 0xe8eef6,
  glass: 0x9bd7f5,
  cargo: 0xb45309,
  accent: 0xd97706,
};

const PAINT_BOTTOM = new THREE.Color(0x7f1d1d);
const PAINT_BOOT = new THREE.Color(0x1c1917);
const PAINT_TOP = new THREE.Color(0x1e3a5f);

interface VesselView {
  id: string;
  definition: VesselDefinition;
  group: THREE.Group;
  materials: THREE.MeshStandardMaterial[];
}

function worldToThree(v: Vec3, out: THREE.Vector3): THREE.Vector3 {
  return out.set(v.x, v.z, -v.y);
}

function attitudeToThree(q: Quat, out: THREE.Quaternion): THREE.Quaternion {
  out.set(q.x, q.y, q.z, q.w);
  return out.premultiply(Q_WORLD_TO_THREE).multiply(Q_THREE_TO_WORLD);
}

/** Grid in the XZ plane, dense near the camera and stretched out to the horizon. */
function createOceanGeometry(segments: number, extent: number): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(2, 2, segments, segments);
  const pos = geo.getAttribute('position');
  const half = extent / 2;
  // Keep a linear term so the centre cells stay finite, then pack the rest of the
  // vertices toward the middle. The mesh is recentred on the camera every frame.
  const warp = (u: number) => {
    const a = Math.abs(u);
    return Math.sign(u) * a * (0.42 + 0.58 * a);
  };
  if (pos instanceof THREE.BufferAttribute) {
    for (let i = 0; i < pos.count; i++) {
      pos.setX(i, warp(pos.getX(i)) * half);
      pos.setY(i, warp(pos.getY(i)) * half);
    }
    pos.needsUpdate = true;
  }
  geo.rotateX(-Math.PI / 2);
  geo.computeBoundingSphere();
  const du = 2 / segments;
  geo.userData.cell = Math.abs(warp(du)) * half;
  return geo;
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

export class LabRenderer implements LabRendererApi {
  readonly stats: RendererStats = { fps: 0, frameMs: 0, drawCalls: 0, triangles: 0 };

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly ocean: GpuOcean;
  private readonly oceanMesh: THREE.Mesh;
  private readonly sky: THREE.Mesh;
  private readonly sun: THREE.DirectionalLight;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly vessels = new Map<string, VesselView>();
  private readonly probes = new Map<string, THREE.Object3D>();
  private readonly pickables: THREE.Object3D[] = [];
  private readonly tmp = new THREE.Vector3();
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
  private userMoved = false;
  private dragging = false;
  private dragged = false;
  private lastX = 0;
  private lastY = 0;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;
  private fpsFrames = 0;
  private fpsElapsed = 0;
  private disposed = false;

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

    const segments = tier === 'light' ? 160 : 420;
    const extent = tier === 'light' ? 2200 : 2800;
    const geo = createOceanGeometry(segments, extent);
    this.oceanMesh = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({
        uniforms: this.ocean.uniforms,
        vertexShader: OCEAN_VERT,
        fragmentShader: OCEAN_FRAG,
        side: THREE.DoubleSide,
        precision: 'highp',
      }),
    );
    this.oceanMesh.frustumCulled = false;
    this.oceanMesh.userData.cell = geo.userData.cell;
    this.scene.add(this.oceanMesh);

    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(8000, 24, 16),
      new THREE.ShaderMaterial({
        uniforms: { uSunDir: this.ocean.uniforms.uSunDir! },
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

    this.scene.add(new THREE.HemisphereLight(0xc5ddf2, 0x1c3344, 0.9));
    this.sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
    this.sun.position.set(400, 800, 200);
    this.scene.add(this.sun);

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
          this.radius = THREE.MathUtils.clamp(this.radius * (this.pinchDist / dist), 6, 4000);
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
      this.yaw -= dx * 0.005;
      this.polar = THREE.MathUtils.clamp(this.polar + dy * 0.004, 0.12, 1.42);
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
      const factor = Math.exp(ev.deltaY * 0.0012);
      this.radius = THREE.MathUtils.clamp(this.radius * factor, 6, 4000);
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
  }

  setEnvironment(env: Environment): void {
    this.ocean.setWaveParams(env.choppiness, env.depth);
    const elev = THREE.MathUtils.degToRad(env.sunElevationDeg);
    const az = THREE.MathUtils.degToRad(env.sunAzimuthDeg);
    const horiz = Math.cos(elev);
    // Azimuth is a compass bearing toward the sun: 0 north (+world y), clockwise.
    const sun = new THREE.Vector3(Math.sin(az) * horiz, Math.sin(elev), -Math.cos(az) * horiz);
    if (sun.lengthSq() < 1e-6) sun.set(0, 1, 0);
    sun.normalize();
    (this.ocean.uniforms.uSunDir!.value as THREE.Vector3).copy(sun);
    (this.ocean.uniforms.uWind!.value as number) = env.windSpeed;
    this.sun.position.copy(sun).multiplyScalar(2000);
    this.sun.intensity = THREE.MathUtils.clamp(0.35 + env.sunElevationDeg / 28, 0.25, 2.6);
    this.sun.color.set(env.sunElevationDeg < 8 ? 0xffb27a : 0xfff4e0);
  }

  setVessels(vessels: readonly { id: string; definition: VesselDefinition }[]): void {
    for (const view of this.vessels.values()) this.disposeVessel(view);
    this.vessels.clear();
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
    const spray = view.group.getObjectByName('spray');
    if (spray) {
      const kn = Math.max(0, state.speedKn);
      const amount = Math.min(1, kn / 12);
      spray.visible = kn > 0.4;
      spray.scale.set(
        view.definition.beam * (0.12 + 0.28 * amount),
        view.definition.draft * (0.2 + 0.45 * amount),
        view.definition.beam * (0.16 + 0.3 * amount),
      );
      const mat = (spray as THREE.Mesh).material;
      if (!Array.isArray(mat) && mat instanceof THREE.MeshStandardMaterial) {
        mat.opacity = 0.12 + 0.55 * amount;
      }
    }
  }

  setOverlay(mode: OverlayMode): void {
    const value = mode === 'height' ? 1 : mode === 'steepness' ? 2 : mode === 'foam' ? 3 : 0;
    this.ocean.uniforms.uOverlay!.value = value;
  }

  setCamera(mode: CameraMode, targetId?: string | null): void {
    this.mode = mode;
    if (targetId !== undefined) this.cameraTarget = targetId ?? null;
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
    this.renderer.info.reset();
    const t = this.shownT || this.frame?.t || 0;
    this.poseAt(t);
    this.updateWakes();
    this.ocean.update(t);
    this.updateCamera();
    this.sky.position.copy(this.camera.position);
    const cell = this.oceanMesh.userData.cell as number;
    this.oceanMesh.position.set(
      Math.round(this.camera.position.x / cell) * cell,
      0,
      Math.round(this.camera.position.z / cell) * cell,
    );
    this.renderer.render(this.scene, this.camera);
    const now = performance.now();
    this.stats.frameMs = now - t0;
    this.stats.drawCalls = this.renderer.info.render.calls;
    this.stats.triangles = this.renderer.info.render.triangles;
    this.fpsFrames += 1;
    this.fpsElapsed += now - t0;
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

  /** Visual Kelvin-ish foam. It does not feed back into the hull forces. */
  private updateWakes(): void {
    const A = this.ocean.uniforms.uWakeA!.value as THREE.Vector4[];
    const B = this.ocean.uniforms.uWakeB!.value as THREE.Vector4[];
    let n = 0;
    for (const state of this.frame?.vessels ?? []) {
      if (n >= 4) break;
      const view = this.vessels.get(state.id);
      if (!view) continue;
      const stern = rotate(state.attitude, {
        x: view.definition.points.propeller.x,
        y: 0,
        z: 0,
      });
      const fwd = rotate(state.attitude, { x: 1, y: 0, z: 0 });
      const speed = Math.max(0, state.speedKn) * (1852 / 3600);
      A[n]!.set(
        state.position.x + stern.x,
        state.position.y + stern.y,
        speed,
        view.definition.length,
      );
      B[n]!.set(fwd.x, fwd.y, view.definition.beam, 0);
      n++;
    }
    this.ocean.uniforms.uWakeCount!.value = n;
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
      this.yaw = 0.65;
      this.polar = 0.95;
      this.radius = 180;
      this.userMoved = false;
      return;
    }
    if (action === 'left') this.yaw -= 0.08;
    if (action === 'right') this.yaw += 0.08;
    if (action === 'up') this.polar = THREE.MathUtils.clamp(this.polar - 0.05, 0.12, 1.42);
    if (action === 'down') this.polar = THREE.MathUtils.clamp(this.polar + 0.05, 0.12, 1.42);
    if (action === 'in') this.radius = THREE.MathUtils.clamp(this.radius * 0.9, 6, 4000);
    if (action === 'out') this.radius = THREE.MathUtils.clamp(this.radius * 1.11, 6, 4000);
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
    for (const view of this.vessels.values()) this.disposeVessel(view);
    this.setProbes([]);
    this.ocean.dispose();
    this.oceanMesh.geometry.dispose();
    (this.oceanMesh.material as THREE.Material).dispose();
    this.sky.geometry.dispose();
    (this.sky.material as THREE.Material).dispose();
    this.renderer.dispose();
  }

  private buildVessel(id: string, definition: VesselDefinition): VesselView {
    const group = new THREE.Group();
    group.userData.pickKind = 'vessel';
    group.userData.pickId = id;
    const materials: THREE.MeshStandardMaterial[] = [];
    const hullMat = this.material('hull');
    hullMat.vertexColors = true;
    hullMat.roughness = 0.42;
    hullMat.metalness = 0.12;
    materials.push(hullMat);
    group.add(
      this.meshFromHull(
        definition.renderHull.positions,
        definition.renderHull.indices,
        hullMat,
        id,
        definition.draft - definition.kg,
      ),
    );
    const sprayMat = new THREE.MeshStandardMaterial({
      color: 0xf8fafc,
      transparent: true,
      opacity: 0.2,
      roughness: 0.15,
      metalness: 0,
      depthWrite: false,
    });
    materials.push(sprayMat);
    const spray = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), sprayMat);
    spray.name = 'spray';
    const bow = definition.points.bow;
    spray.position.set(bow.x + definition.length * 0.02, bow.z, -bow.y);
    spray.scale.set(definition.beam * 0.22, definition.draft * 0.35, definition.beam * 0.28);
    group.add(spray);

    for (const box of definition.superstructure) {
      const mat = this.material(box.material);
      materials.push(mat);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(box.size.x, box.size.z, box.size.y), mat);
      mesh.position.set(box.center.x, box.center.z, -box.center.y);
      mesh.userData.pickKind = 'vessel';
      mesh.userData.pickId = id;
      if (box.material === 'glass') {
        mat.transparent = true;
        mat.opacity = 0.45;
        mat.roughness = 0.05;
      }
      group.add(mesh);
    }

    const prop = definition.points.propeller;
    const propMat = this.material('accent');
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

    return { id, definition, group, materials };
  }

  private meshFromHull(
    src: Float32Array,
    indices: Uint32Array,
    material: THREE.Material,
    id: string,
    waterlineZ: number,
  ): THREE.Mesh {
    const positions = new Float32Array(src.length);
    const colors = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
      positions[i] = src[i]!;
      positions[i + 1] = src[i + 2]!;
      positions[i + 2] = -src[i + 1]!;
      const z = src[i + 2]!;
      const paint =
        z < waterlineZ - 0.15 ? PAINT_BOTTOM : z < waterlineZ + 0.35 ? PAINT_BOOT : PAINT_TOP;
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

  private material(kind: string): THREE.MeshStandardMaterial {
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
      color: HULL_COLORS[kind] ?? HULL_COLORS.hull,
      roughness: kind === 'superstructure' ? 0.45 : 0.62,
      metalness: kind === 'accent' ? 0.35 : 0.04,
    });
  }

  private disposeVessel(view: VesselView): void {
    this.scene.remove(view.group);
    view.group.traverse((child) => {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    });
    for (const mat of view.materials) mat.dispose();
  }

  private applySelection(): void {
    for (const view of this.vessels.values()) {
      const selected = view.id === this.selection;
      const capsized = view.group.userData.capsized === true;
      for (const mat of view.materials) {
        mat.emissive.set(selected ? 0xfbbf24 : capsized ? 0x7f1d1d : 0x000000);
        mat.emissiveIntensity = selected ? 0.45 : capsized ? 0.3 : 0;
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
    const focus = this.focusVessel();
    const target = this.tmp;
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
    const lookAt = {
      x:
        eye.x +
        (bow.x * Math.cos(yaw) + side.x * Math.sin(yaw)) * 40 +
        up.x * (0.95 - this.polar) * 20,
      y:
        eye.y +
        (bow.y * Math.cos(yaw) + side.y * Math.sin(yaw)) * 40 +
        up.y * (0.95 - this.polar) * 20,
      z:
        eye.z +
        (bow.z * Math.cos(yaw) + side.z * Math.sin(yaw)) * 40 +
        up.z * (0.95 - this.polar) * 20,
    };
    this.camera.up.set(up.x, up.z, -up.y);
    this.camera.position.set(eye.x, eye.z, -eye.y);
    this.camera.lookAt(lookAt.x, lookAt.z, -lookAt.y);
  }

  private placeOrbit(target: THREE.Vector3, azimuth: number, polar: number, radius: number): void {
    this.camera.up.set(0, 1, 0);
    this.camera.position.set(
      target.x + radius * Math.sin(polar) * Math.sin(azimuth),
      target.y + radius * Math.cos(polar),
      target.z + radius * Math.sin(polar) * Math.cos(azimuth),
    );
    this.camera.lookAt(target);
  }
}
