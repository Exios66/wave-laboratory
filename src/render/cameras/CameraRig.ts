/**
 * Camera modes: orbit (OrbitControls, damped, kept above the water), follow (smoothed chase cam),
 * bridge (rigidly mounted on the vessel) and top (high, north-up plan view). `nudge` offers
 * keyboard-equivalent control in every mode.
 */
import { MathUtils, PerspectiveCamera, Quaternion, Spherical, Vector3, type Object3D } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { CameraMode } from '../api';

export type NudgeAction = 'left' | 'right' | 'up' | 'down' | 'in' | 'out' | 'reset';

/** What the rig needs to know about a vessel (three.js frame). */
export interface CameraSubject {
  object: Object3D;
  /** Characteristic size (length overall) [m]. */
  length: number;
  /** Bridge eye point in the object's local (three-oriented body) frame. */
  bridgeEye: Vector3;
}

const UP = new Vector3(0, 1, 0);
const NORTH_UP = new Vector3(0, 0, -1);
/** Rotates the camera's −Z (view) onto the body's +x (forward): R_y(−90°). */
const BRIDGE_OFFSET = new Quaternion().setFromAxisAngle(UP, -Math.PI / 2);
const MIN_ORBIT_HEIGHT = 1.5;

export class CameraRig {
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;
  private mode: CameraMode = 'orbit';
  private targetId: string | null = null;
  private readonly sunDir = new Vector3(0, 0.5, -1).normalize();
  private readonly home = new Vector3();
  private homeRadius = 60;
  // follow state
  private followYaw = 0;
  private followPitch = 0;
  private followScale = 1;
  private readonly followPos = new Vector3();
  private readonly followLook = new Vector3();
  private followInit = false;
  // bridge state
  private bridgeYaw = 0;
  private bridgePitch = 0;
  private bridgeFov = 60;
  // top state
  private topHeight = 300;
  private readonly topPan = new Vector3();
  // scratch
  private readonly v1 = new Vector3();
  private readonly v2 = new Vector3();
  private readonly v3 = new Vector3();
  private readonly q1 = new Quaternion();
  private readonly q2 = new Quaternion();
  private readonly sph = new Spherical();

  constructor(domElement: HTMLElement) {
    this.camera = new PerspectiveCamera(50, 1, 0.5, 6e5);
    this.camera.name = 'LabCamera';
    this.controls = new OrbitControls(this.camera, domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 5000;
    this.controls.maxPolarAngle = MathUtils.degToRad(88);
    this.controls.screenSpacePanning = false;
    this.resetOrbit();
  }

  get currentMode(): CameraMode {
    return this.mode;
  }

  get currentTarget(): string | null {
    return this.targetId;
  }

  setSunDirection(dir: Vector3): void {
    this.sunDir.copy(dir);
  }

  /** Default orbit framing: centre and radius of the interesting part of the scene. */
  setHome(center: Vector3, radius: number): void {
    this.home.copy(center);
    this.homeRadius = Math.max(20, radius);
  }

  setMode(mode: CameraMode, targetId: string | null): void {
    const prev = this.mode;
    this.mode = mode;
    this.targetId = targetId;
    this.controls.enabled = mode === 'orbit';
    this.camera.up.copy(mode === 'top' ? NORTH_UP : UP);
    this.camera.near = mode === 'bridge' ? 0.1 : 0.5;
    this.camera.fov = mode === 'bridge' ? this.bridgeFov : 50;
    this.camera.updateProjectionMatrix();
    this.followInit = false;
    if (mode === 'orbit' && prev !== 'orbit') {
      // Continue orbiting around whatever we were looking at.
      this.camera.getWorldDirection(this.v1);
      const t = this.v1.y < -0.05 ? -this.camera.position.y / this.v1.y : 80;
      this.controls.target.copy(this.camera.position).addScaledVector(this.v1, Math.min(t, 500));
      this.controls.target.y = 0;
      this.controls.update();
    }
    if (mode === 'top') this.topPan.set(0, 0, 0);
  }

  resetOrbit(): void {
    // Look roughly towards the sun (35° off) so the glitter path is in view.
    const sunAz = Math.atan2(this.sunDir.x, -this.sunDir.z);
    const az = sunAz + Math.PI + MathUtils.degToRad(35);
    const elev = MathUtils.degToRad(13);
    const r = this.homeRadius;
    this.controls.target.copy(this.home);
    this.camera.position.set(
      this.home.x + Math.sin(az) * Math.cos(elev) * r,
      this.home.y + Math.sin(elev) * r,
      this.home.z - Math.cos(az) * Math.cos(elev) * r,
    );
    this.camera.lookAt(this.controls.target);
    this.controls.update();
  }

  nudge(action: NudgeAction): void {
    const step = MathUtils.degToRad(7.5);
    switch (this.mode) {
      case 'orbit': {
        if (action === 'reset') {
          this.resetOrbit();
          return;
        }
        const offset = this.v1.copy(this.camera.position).sub(this.controls.target);
        this.sph.setFromVector3(offset);
        if (action === 'left') this.sph.theta -= step;
        if (action === 'right') this.sph.theta += step;
        if (action === 'up') this.sph.phi -= step;
        if (action === 'down') this.sph.phi += step;
        if (action === 'in') this.sph.radius *= 0.85;
        if (action === 'out') this.sph.radius /= 0.85;
        this.sph.phi = MathUtils.clamp(this.sph.phi, 0.05, this.controls.maxPolarAngle);
        this.sph.radius = MathUtils.clamp(
          this.sph.radius,
          this.controls.minDistance,
          this.controls.maxDistance,
        );
        offset.setFromSpherical(this.sph);
        this.camera.position.copy(this.controls.target).add(offset);
        this.camera.lookAt(this.controls.target);
        this.controls.update();
        return;
      }
      case 'follow':
        if (action === 'left') this.followYaw -= step * 2;
        if (action === 'right') this.followYaw += step * 2;
        if (action === 'up') this.followPitch = Math.min(1.2, this.followPitch + step);
        if (action === 'down') this.followPitch = Math.max(-0.25, this.followPitch - step);
        if (action === 'in') this.followScale = Math.max(0.3, this.followScale * 0.85);
        if (action === 'out') this.followScale = Math.min(6, this.followScale / 0.85);
        if (action === 'reset') {
          this.followYaw = 0;
          this.followPitch = 0;
          this.followScale = 1;
        }
        return;
      case 'bridge':
        if (action === 'left') this.bridgeYaw += step * 2;
        if (action === 'right') this.bridgeYaw -= step * 2;
        if (action === 'up') this.bridgePitch = Math.min(1.2, this.bridgePitch + step);
        if (action === 'down') this.bridgePitch = Math.max(-1.2, this.bridgePitch - step);
        if (action === 'in') this.bridgeFov = Math.max(15, this.bridgeFov * 0.85);
        if (action === 'out') this.bridgeFov = Math.min(90, this.bridgeFov / 0.85);
        if (action === 'reset') {
          this.bridgeYaw = 0;
          this.bridgePitch = 0;
          this.bridgeFov = 60;
        }
        this.camera.fov = this.bridgeFov;
        this.camera.updateProjectionMatrix();
        return;
      case 'top': {
        const pan = this.topHeight * 0.1;
        if (action === 'left') this.topPan.x -= pan;
        if (action === 'right') this.topPan.x += pan;
        if (action === 'up') this.topPan.z -= pan; // north
        if (action === 'down') this.topPan.z += pan;
        if (action === 'in') this.topHeight = Math.max(30, this.topHeight * 0.85);
        if (action === 'out') this.topHeight = Math.min(8000, this.topHeight / 0.85);
        if (action === 'reset') {
          this.topPan.set(0, 0, 0);
          this.topHeight = 300;
        }
        return;
      }
    }
  }

  /** Advance the camera (dt = wall-clock seconds since the last frame). */
  update(dt: number, subject: CameraSubject | null): void {
    const cam = this.camera;
    switch (this.mode) {
      case 'orbit':
        this.controls.update(dt);
        this.clampAboveWater();
        return;
      case 'follow': {
        if (!subject) {
          this.controls.update(dt);
          return;
        }
        const obj = subject.object;
        const L = subject.length;
        // Heading-only forward vector (roll/pitch must not swing the chase cam around).
        const fwd = this.v1.set(1, 0, 0).applyQuaternion(obj.quaternion);
        fwd.y = 0;
        if (fwd.lengthSq() < 1e-8) fwd.set(1, 0, 0);
        fwd.normalize().applyAxisAngle(UP, this.followYaw);
        const dist = (1.6 * L + 18) * this.followScale;
        const height = (0.35 * L + 6) * this.followScale + Math.sin(this.followPitch) * dist;
        const desired = this.v2
          .copy(obj.position)
          .addScaledVector(fwd, -dist * Math.cos(this.followPitch));
        desired.y = Math.max(obj.position.y, 0) + height;
        const look = this.v3.copy(obj.position);
        look.y += 0.15 * L;
        if (!this.followInit) {
          this.followPos.copy(desired);
          this.followLook.copy(look);
          this.followInit = true;
        }
        const a = 1 - Math.exp(-3 * dt);
        this.followPos.lerp(desired, a);
        this.followLook.lerp(look, 1 - Math.exp(-8 * dt));
        cam.position.copy(this.followPos);
        cam.position.y = Math.max(cam.position.y, MIN_ORBIT_HEIGHT);
        cam.lookAt(this.followLook);
        this.controls.target.copy(this.followLook);
        return;
      }
      case 'bridge': {
        if (!subject) {
          this.controls.update(dt);
          return;
        }
        const obj = subject.object;
        obj.updateMatrixWorld();
        cam.position.copy(subject.bridgeEye).applyMatrix4(obj.matrixWorld);
        // Body frame: look along +x, up along body z; then the user's look-around offsets.
        this.q1.setFromAxisAngle(UP, this.bridgeYaw);
        this.q2.setFromAxisAngle(this.v1.set(0, 0, 1), this.bridgePitch);
        cam.quaternion
          .copy(obj.quaternion)
          .multiply(this.q1)
          .multiply(this.q2)
          .multiply(BRIDGE_OFFSET);
        return;
      }
      case 'top': {
        const center = this.v1.copy(subject ? subject.object.position : this.controls.target);
        center.y = 0;
        center.add(this.topPan);
        cam.position.set(center.x, this.topHeight, center.z);
        cam.lookAt(center);
        return;
      }
    }
  }

  private clampAboveWater(): void {
    const cam = this.camera;
    const minY = Math.max(MIN_ORBIT_HEIGHT, this.controls.target.y + 0.5);
    if (cam.position.y < minY) cam.position.y = minY;
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.controls.dispose();
  }
}
