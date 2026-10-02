/**
 * Lost planes: rare old aircraft crossing the sky, as if from another time.
 * Bermuda Triangle Easter egg — translucent WWII silhouettes that sometimes vanish mid-flight.
 */
import * as THREE from 'three';
import type { SceneryFrame, SceneryLayer } from './types';
import { disposeObject3D, GeometryPool, hash01 } from './util';

interface Flight {
  group: THREE.Group;
  /** Seconds since spawn. */
  age: number;
  /** Total lifetime of this pass [s]. */
  duration: number;
  /** Path centre near the camera (Three.js). */
  origin: THREE.Vector3;
  heading: number;
  altitude: number;
  speed: number;
  span: number;
  /** 0–1 progress when the plane may dematerialise (Easter egg). */
  vanishAt: number;
  vanished: boolean;
  ghost: boolean;
}

export class PlaneLayer implements SceneryLayer {
  readonly object = new THREE.Group();
  private readonly pool = new GeometryPool();
  private readonly flights: Flight[] = [];
  private nextSpawnAt = 3;
  private spawnIndex = 0;
  private readonly fuselage = this.pool.share(new THREE.CylinderGeometry(0.35, 0.55, 4.2, 6));
  private readonly wing = this.pool.share(new THREE.BoxGeometry(7.5, 0.12, 1.1));
  private readonly stab = this.pool.share(new THREE.BoxGeometry(2.4, 0.08, 0.55));
  private readonly fin = this.pool.share(new THREE.BoxGeometry(0.12, 1.1, 0.7));
  private readonly nose = this.pool.share(new THREE.ConeGeometry(0.35, 1.1, 6));
  private readonly prop = this.pool.share(new THREE.CircleGeometry(0.85, 12));

  constructor() {
    this.object.name = 'planes';
    this.fuselage.rotateZ(Math.PI / 2);
    this.nose.rotateZ(-Math.PI / 2);
  }

  setEnabled(enabled: boolean): void {
    this.object.visible = enabled;
    if (!enabled) this.clearFlights();
  }

  update(frame: SceneryFrame): void {
    if (!this.object.visible) return;
    // Rare flyovers — first one comes quickly so the Easter egg is discoverable.
    const haunt = (1 - frame.daylight) * 0.55 + (1 - frame.calm) * 0.25 + 0.2;
    if (frame.wallT >= this.nextSpawnAt && this.flights.length < 2) {
      this.spawn(frame, haunt);
      const gap = 35 + hash01(this.spawnIndex * 97) * (140 - haunt * 70);
      this.nextSpawnAt = frame.wallT + gap;
    }
    for (let i = this.flights.length - 1; i >= 0; i--) {
      const f = this.flights[i]!;
      f.age += frame.dt;
      const u = f.age / f.duration;
      if (u >= 1) {
        this.removeFlight(i);
        continue;
      }
      if (!f.vanished && u >= f.vanishAt) {
        f.vanished = true;
        // Dematerialise: the Easter egg — Flight 19 never lands.
        this.fadeOut(f, 0);
      }
      const along = (u - 0.5) * f.span;
      const x = f.origin.x + Math.cos(f.heading) * along;
      const z = f.origin.z + Math.sin(f.heading) * along;
      // Gentle banked arc.
      const bank = Math.sin(u * Math.PI) * 0.12;
      const y = f.altitude + Math.sin(u * Math.PI) * 18;
      f.group.position.set(x, y, z);
      f.group.rotation.order = 'YXZ';
      f.group.rotation.y = -f.heading;
      f.group.rotation.z = bank;
      f.group.rotation.x = -0.04;
      // Prop spin (visual only).
      const prop = f.group.getObjectByName('prop');
      if (prop) prop.rotation.x += frame.dt * 28;
      if (!f.vanished) {
        const edge = Math.min(u, 1 - u) * 8;
        const opacity = f.ghost ? 0.22 + 0.28 * Math.min(1, edge) : 0.55 + 0.35 * Math.min(1, edge);
        this.setOpacity(f, opacity * (0.55 + 0.45 * frame.daylight + (f.ghost ? 0.35 : 0)));
      } else {
        const fade = Math.max(0, 1 - (u - f.vanishAt) / 0.12);
        this.setOpacity(f, fade * 0.35);
        if (fade <= 0) this.removeFlight(i);
      }
    }
  }

  private spawn(frame: SceneryFrame, haunt: number): void {
    this.spawnIndex += 1;
    const seed = this.spawnIndex * 7919;
    const ghost = this.spawnIndex === 1 ? true : hash01(seed) < 0.55 + haunt * 0.35;
    const heading = this.spawnIndex === 1 ? 0.35 : hash01(seed + 1) * Math.PI * 2;
    const cam = frame.camera.position;
    // First sighting: fly straight over the camera look area so demos catch it.
    const side = this.spawnIndex === 1 ? 40 : (hash01(seed + 2) - 0.5) * 380;
    const origin = new THREE.Vector3(
      cam.x + Math.cos(heading + Math.PI / 2) * side,
      0,
      cam.z + Math.sin(heading + Math.PI / 2) * side,
    );
    const altitude = this.spawnIndex === 1 ? 90 : 120 + hash01(seed + 3) * 220;
    const span = this.spawnIndex === 1 ? 900 : 1400 + hash01(seed + 4) * 900;
    const speed = this.spawnIndex === 1 ? 70 : 55 + hash01(seed + 5) * 40;
    const duration = span / speed;
    // First pass completes; later ghost flights often dematerialise.
    const willVanish =
      this.spawnIndex === 1 ? false : ghost ? hash01(seed + 6) < 0.72 : hash01(seed + 6) < 0.12;
    const group = this.buildPlane(ghost, seed);
    if (this.spawnIndex === 1) group.scale.multiplyScalar(1.6);
    const flight: Flight = {
      group,
      age: 0,
      duration,
      origin,
      heading,
      altitude,
      speed,
      span,
      vanishAt: willVanish ? 0.35 + hash01(seed + 7) * 0.4 : 2,
      vanished: false,
      ghost,
    };
    this.object.add(group);
    this.flights.push(flight);
  }

  private buildPlane(ghost: boolean, seed: number): THREE.Group {
    const g = new THREE.Group();
    g.name = ghost ? 'lost-plane' : 'sighting-plane';
    const paint = ghost ? 0x9ad7e3 : 0x6b7280;
    const opacity = ghost ? 0.35 : 0.85;
    const mat = new THREE.MeshStandardMaterial({
      color: paint,
      roughness: ghost ? 0.35 : 0.55,
      metalness: ghost ? 0.4 : 0.25,
      transparent: true,
      opacity,
      depthWrite: !ghost,
      emissive: ghost ? new THREE.Color(0x4fd1c5) : new THREE.Color(0x000000),
      emissiveIntensity: ghost ? 0.45 : 0,
      side: THREE.DoubleSide,
    });
    const fuselage = new THREE.Mesh(this.fuselage, mat);
    const wing = new THREE.Mesh(this.wing, mat);
    wing.position.set(0.2, -0.1, 0);
    const stab = new THREE.Mesh(this.stab, mat);
    stab.position.set(-1.7, 0.15, 0);
    const fin = new THREE.Mesh(this.fin, mat);
    fin.position.set(-1.85, 0.65, 0);
    const nose = new THREE.Mesh(this.nose, mat);
    nose.position.set(2.4, 0, 0);
    const propMat = mat.clone();
    propMat.opacity = opacity * 0.45;
    propMat.emissiveIntensity = ghost ? 0.7 : 0;
    const prop = new THREE.Mesh(this.prop, propMat);
    prop.name = 'prop';
    prop.position.set(2.95, 0, 0);
    prop.rotation.y = Math.PI / 2;
    g.add(fuselage, wing, stab, fin, nose, prop);
    // Scale: roughly Avenger-sized (~12 m) with a little variety.
    const s = 2.2 + hash01(seed + 8) * 0.8;
    g.scale.setScalar(s);
    g.userData.mats = [mat, propMat];
    return g;
  }

  private setOpacity(f: Flight, opacity: number): void {
    const mats = f.group.userData.mats as THREE.MeshStandardMaterial[];
    for (const m of mats) {
      m.opacity = Math.max(0, Math.min(1, opacity));
      m.transparent = true;
    }
  }

  private fadeOut(f: Flight, opacity: number): void {
    this.setOpacity(f, opacity);
  }

  private removeFlight(index: number): void {
    const f = this.flights[index];
    if (!f) return;
    this.object.remove(f.group);
    const mats = f.group.userData.mats as THREE.Material[] | undefined;
    if (mats) for (const m of mats) m.dispose();
    this.flights.splice(index, 1);
  }

  private clearFlights(): void {
    for (let i = this.flights.length - 1; i >= 0; i--) this.removeFlight(i);
  }

  dispose(): void {
    this.clearFlights();
    this.pool.dispose();
    disposeObject3D(this.object, { shared: true });
  }
}
