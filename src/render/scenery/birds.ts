/** Gulls, terns and albatrosses, seen in fair weather. */
import * as THREE from 'three';
import type { SceneryFrame, SceneryLayer } from './types';
import { disposeObject3D, GeometryPool, hash01, makeMat } from './util';

interface Bird {
  mesh: THREE.Group;
  phase: number;
  speed: number;
  radius: number;
  height: number;
  angle: number;
  /** 0 = orbit camera, 1 = orbit nearest vessel. */
  mode: 0 | 1;
  wingL: THREE.Object3D;
  wingR: THREE.Object3D;
}

export class SeabirdLayer implements SceneryLayer {
  readonly object = new THREE.Group();
  private readonly pool = new GeometryPool();
  private readonly birds: Bird[] = [];
  private readonly bodyGeo = this.pool.share(new THREE.ConeGeometry(0.12, 0.55, 5));
  private readonly wingGeo = this.pool.share(new THREE.BoxGeometry(0.7, 0.04, 0.18));
  private readonly mat = makeMat(0xf8fafc, { roughness: 0.55, metalness: 0.02 });
  private primed = false;

  constructor() {
    this.object.name = 'birds';
  }

  setEnabled(enabled: boolean): void {
    this.object.visible = enabled;
  }

  update(frame: SceneryFrame): void {
    if (!this.object.visible) return;
    if (!this.primed) {
      this.spawnFlock(18);
      this.primed = true;
    }
    const show = frame.calm > 0.3;
    const opacity = THREE.MathUtils.smoothstep(frame.calm, 0.3, 0.7);
    this.mat.transparent = opacity < 0.99;
    this.mat.opacity = opacity;
    this.mat.emissiveIntensity = (1 - frame.daylight) * 0.08;

    const vessel = frame.vesselPositions[0];
    for (const b of this.birds) {
      b.mesh.visible = show;
      if (!show) continue;
      b.angle += frame.dt * b.speed;
      b.phase += frame.dt * 10;
      const flap = Math.sin(b.phase) * 0.55;
      b.wingL.rotation.z = flap;
      b.wingR.rotation.z = -flap;
      const cx = b.mode === 1 && vessel ? vessel.x : frame.camera.position.x;
      const cz = b.mode === 1 && vessel ? vessel.z : frame.camera.position.z;
      const x = cx + Math.cos(b.angle) * b.radius;
      const z = cz + Math.sin(b.angle) * b.radius;
      const y = b.height + Math.sin(b.angle * 2 + b.phase * 0.1) * 2.5;
      b.mesh.position.set(x, y, z);
      b.mesh.rotation.y = -b.angle + Math.PI / 2;
      b.mesh.scale.setScalar(0.85 + frame.daylight * 0.25);
    }
  }

  private spawnFlock(n: number): void {
    for (let i = 0; i < n; i++) {
      const mesh = this.makeBird();
      this.object.add(mesh);
      const wingL = mesh.getObjectByName('wingL')!;
      const wingR = mesh.getObjectByName('wingR')!;
      this.birds.push({
        mesh,
        phase: hash01(i * 3) * Math.PI * 2,
        speed: 0.35 + hash01(i * 5) * 0.45,
        radius: 25 + hash01(i * 7) * 90,
        height: 12 + hash01(i * 11) * 28,
        angle: hash01(i * 13) * Math.PI * 2,
        mode: hash01(i * 17) < 0.45 ? 1 : 0,
        wingL,
        wingR,
      });
    }
  }

  private makeBird(): THREE.Group {
    const g = new THREE.Group();
    const body = new THREE.Mesh(this.bodyGeo, this.mat);
    body.rotation.z = Math.PI / 2;
    const wingL = new THREE.Mesh(this.wingGeo, this.mat);
    wingL.name = 'wingL';
    wingL.position.set(0, 0, 0.25);
    const wingR = new THREE.Mesh(this.wingGeo, this.mat);
    wingR.name = 'wingR';
    wingR.position.set(0, 0, -0.25);
    g.add(body, wingL, wingR);
    return g;
  }

  dispose(): void {
    this.birds.length = 0;
    disposeObject3D(this.object, { shared: true });
    this.pool.dispose();
    this.mat.dispose();
  }
}
