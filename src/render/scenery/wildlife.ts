/** Dolphins, whales, turtles and leaping fish, seen in fair weather. */
import * as THREE from 'three';
import type { SceneryFrame, SceneryLayer } from './types';
import { disposeObject3D, GeometryPool, hash01, hash2, makeMat } from './util';

interface Dolphin {
  mesh: THREE.Group;
  phase: number;
  speed: number;
  radius: number;
  angle: number;
  center: THREE.Vector3;
  vesselIndex: number;
}

interface Turtle {
  mesh: THREE.Group;
  angle: number;
  radius: number;
  bob: number;
  center: THREE.Vector3;
}

interface Whale {
  mesh: THREE.Group;
  phase: number;
  heading: number;
  origin: THREE.Vector3;
  active: boolean;
  nextAt: number;
}

export class WildlifeLayer implements SceneryLayer {
  readonly object = new THREE.Group();
  private readonly pool = new GeometryPool();
  private readonly dolphins: Dolphin[] = [];
  private readonly turtles: Turtle[] = [];
  private whale: Whale | null = null;
  private readonly dolphinBody = this.pool.share(new THREE.SphereGeometry(0.55, 8, 6));
  private readonly dolphinNose = this.pool.share(new THREE.ConeGeometry(0.22, 0.7, 5));
  private readonly finGeo = this.pool.share(new THREE.ConeGeometry(0.18, 0.45, 4));
  private readonly turtleShell = this.pool.share(new THREE.SphereGeometry(0.55, 8, 6));
  private readonly whaleBody = this.pool.share(new THREE.SphereGeometry(1.8, 10, 7));
  private readonly spoutGeo = this.pool.share(new THREE.CylinderGeometry(0.15, 0.35, 6, 6));
  private readonly dolphinMat = makeMat(0x64748b, { roughness: 0.45, metalness: 0.05 });
  private readonly turtleMat = makeMat(0x3f6212, { roughness: 0.7 });
  private readonly whaleMat = makeMat(0x334155, { roughness: 0.55 });
  private readonly spoutMat = new THREE.MeshStandardMaterial({
    color: 0xe2e8f0,
    transparent: true,
    opacity: 0.45,
    roughness: 0.3,
    depthWrite: false,
  });
  private readonly mats = [this.dolphinMat, this.turtleMat, this.whaleMat, this.spoutMat];
  private primed = false;

  constructor() {
    this.object.name = 'wildlife';
  }

  setEnabled(enabled: boolean): void {
    this.object.visible = enabled;
  }

  update(frame: SceneryFrame): void {
    if (!this.object.visible) return;
    if (!this.primed) {
      this.seedStatic();
      this.primed = true;
    }
    const show = frame.calm > 0.35;
    const opacity = THREE.MathUtils.smoothstep(frame.calm, 0.35, 0.75);

    this.ensureDolphins(frame);
    for (const d of this.dolphins) {
      d.mesh.visible = show && frame.vessels.length > 0;
      if (!d.mesh.visible) continue;
      const pos = frame.vesselPositions[d.vesselIndex];
      if (pos) d.center.copy(pos);
      d.angle += frame.dt * d.speed;
      d.phase += frame.dt * 1.6;
      const leap = Math.max(0, Math.sin(d.phase)) * 2.8;
      const x = d.center.x + Math.cos(d.angle) * d.radius;
      const z = d.center.z + Math.sin(d.angle) * d.radius;
      d.mesh.position.set(x, leap - 0.4, z);
      d.mesh.rotation.y = -d.angle + Math.PI / 2;
      d.mesh.rotation.z = Math.sin(d.phase) * 0.45;
      this.setGroupOpacity(d.mesh, opacity);
    }

    for (const t of this.turtles) {
      t.mesh.visible = show;
      if (!t.mesh.visible) continue;
      t.center.set(frame.camera.position.x, 0, frame.camera.position.z);
      t.angle += frame.dt * 0.12;
      t.bob += frame.dt;
      const x = t.center.x + Math.cos(t.angle) * t.radius;
      const z = t.center.z + Math.sin(t.angle) * t.radius;
      t.mesh.position.set(x, 0.15 + Math.sin(t.bob * 0.7) * 0.12, z);
      t.mesh.rotation.y = -t.angle + Math.PI / 2;
      this.setGroupOpacity(t.mesh, opacity * 0.85);
    }

    this.updateWhale(frame, show, opacity);
  }

  private ensureDolphins(frame: SceneryFrame): void {
    const want = frame.vessels.length > 0 ? Math.min(3, frame.vessels.length) * 3 : 0;
    while (this.dolphins.length > want) {
      const d = this.dolphins.pop()!;
      this.object.remove(d.mesh);
    }
    while (this.dolphins.length < want) {
      const i = this.dolphins.length;
      const vesselIndex = Math.floor(i / 3) % Math.max(1, frame.vessels.length);
      const mesh = this.makeDolphin();
      this.object.add(mesh);
      this.dolphins.push({
        mesh,
        phase: hash01(i * 13) * Math.PI * 2,
        speed: 0.55 + hash01(i * 17) * 0.35,
        radius: 18 + hash01(i * 19) * 22,
        angle: hash01(i * 23) * Math.PI * 2,
        center: new THREE.Vector3(),
        vesselIndex,
      });
    }
    for (let i = 0; i < this.dolphins.length; i++) {
      this.dolphins[i]!.vesselIndex = Math.floor(i / 3) % Math.max(1, frame.vessels.length);
    }
  }

  private seedStatic(): void {
    for (let i = 0; i < 4; i++) {
      const mesh = this.makeTurtle();
      this.object.add(mesh);
      this.turtles.push({
        mesh,
        angle: hash2(i, 4) * Math.PI * 2,
        radius: 40 + hash2(i, 5) * 70,
        bob: hash2(i, 6) * 10,
        center: new THREE.Vector3(),
      });
    }
    const whaleMesh = new THREE.Group();
    const body = new THREE.Mesh(this.whaleBody, this.whaleMat);
    body.scale.set(2.4, 1, 1.1);
    const spout = new THREE.Mesh(this.spoutGeo, this.spoutMat);
    spout.name = 'spout';
    spout.position.y = 4;
    spout.visible = false;
    whaleMesh.add(body, spout);
    whaleMesh.visible = false;
    this.object.add(whaleMesh);
    this.whale = {
      mesh: whaleMesh,
      phase: 0,
      heading: 0,
      origin: new THREE.Vector3(),
      active: false,
      nextAt: 20,
    };
  }

  private updateWhale(frame: SceneryFrame, show: boolean, opacity: number): void {
    const w = this.whale;
    if (!w) return;
    if (!w.active) {
      w.mesh.visible = false;
      if (show && frame.calm > 0.55 && frame.wallT >= w.nextAt) {
        w.active = true;
        w.phase = 0;
        w.heading = hash01(Math.floor(frame.wallT * 10)) * Math.PI * 2;
        const cam = frame.camera.position;
        w.origin.set(cam.x + Math.cos(w.heading) * 220, 0, cam.z + Math.sin(w.heading) * 220);
      }
      return;
    }
    w.phase += frame.dt;
    const u = w.phase / 14;
    if (u >= 1) {
      w.active = false;
      w.nextAt = frame.wallT + 40 + hash01(Math.floor(frame.wallT)) * 80;
      w.mesh.visible = false;
      return;
    }
    w.mesh.visible = show;
    const along = u * 160;
    const breach = Math.sin(u * Math.PI) * 3.5;
    w.mesh.position.set(
      w.origin.x + Math.cos(w.heading) * along,
      breach - 1.2,
      w.origin.z + Math.sin(w.heading) * along,
    );
    w.mesh.rotation.y = -w.heading;
    const spout = w.mesh.getObjectByName('spout');
    if (spout) spout.visible = u > 0.35 && u < 0.55 && breach > 1.5;
    this.setGroupOpacity(w.mesh, opacity);
  }

  private makeDolphin(): THREE.Group {
    const g = new THREE.Group();
    const body = new THREE.Mesh(this.dolphinBody, this.dolphinMat);
    body.scale.set(1.6, 0.7, 0.7);
    const nose = new THREE.Mesh(this.dolphinNose, this.dolphinMat);
    nose.rotation.z = -Math.PI / 2;
    nose.position.set(1.1, 0, 0);
    const fin = new THREE.Mesh(this.finGeo, this.dolphinMat);
    fin.position.set(0, 0.55, 0);
    g.add(body, nose, fin);
    return g;
  }

  private makeTurtle(): THREE.Group {
    const g = new THREE.Group();
    const shell = new THREE.Mesh(this.turtleShell, this.turtleMat);
    shell.scale.set(1.2, 0.45, 1);
    g.add(shell);
    return g;
  }

  private setGroupOpacity(g: THREE.Object3D, opacity: number): void {
    g.traverse((c) => {
      if (c instanceof THREE.Mesh) {
        const m = c.material;
        if (!Array.isArray(m) && 'opacity' in m) {
          m.transparent = opacity < 0.99;
          (m as THREE.MeshStandardMaterial).opacity = opacity;
        }
      }
    });
  }

  dispose(): void {
    this.dolphins.length = 0;
    this.turtles.length = 0;
    this.whale = null;
    disposeObject3D(this.object, { shared: true });
    this.pool.dispose();
    for (const m of this.mats) m.dispose();
  }
}
