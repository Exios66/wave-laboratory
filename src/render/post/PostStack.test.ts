import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DEFAULT_POST } from '../api';
import { PostStack } from './PostStack';

/** Just enough renderer for the stack's bookkeeping (no draw calls are made). */
function fakeRenderer(halfFloat = true): THREE.WebGLRenderer {
  return {
    getContext: () => ({ getExtension: () => (halfFloat ? {} : null) }),
  } as unknown as THREE.WebGLRenderer;
}

function setup(halfFloat = true) {
  const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.5, 5000);
  const post = new PostStack(fakeRenderer(halfFloat), new THREE.Scene(), camera, 'full');
  post.setSize(800, 450, 1);
  return { camera, post };
}

const UNDER = { kd: [0.1, 0.05, 0.03], inscatter: [0, 0.1, 0.2] } as const;

describe('PostStack temporal antialiasing', () => {
  it('runs only when asked for, above water and outside the Plane view', () => {
    const { post } = setup();
    expect(post.active).toBe(false);
    post.setSettings({ ...DEFAULT_POST, taa: true });
    expect(post.taaRunning).toBe(true);
    expect(post.active).toBe(true);
    post.setTaaAllowed(false);
    expect(post.taaRunning).toBe(false);
    expect(post.active).toBe(false);
    post.setTaaAllowed(true);
    post.setUnderwater(UNDER);
    expect(post.taaRunning).toBe(false);
    expect(post.active).toBe(true);
    post.setUnderwater(null);
    expect(post.taaRunning).toBe(true);
  });

  it('never runs without half-float targets', () => {
    const { post } = setup(false);
    post.setSettings({ ...DEFAULT_POST, taa: true });
    expect(post.taaRunning).toBe(false);
    expect(post.active).toBe(false);
  });

  it('jitters the camera by under half a pixel for one frame, then restores it exactly', () => {
    const { camera, post } = setup();
    const plain = camera.projectionMatrix.clone();
    post.setSettings({ ...DEFAULT_POST, taa: true });
    const offsets = new Set<string>();
    for (let f = 0; f < 8; f++) {
      post.beginJitter();
      const view = camera.view;
      expect(view?.enabled).toBe(true);
      expect(view!.fullWidth).toBe(800);
      expect(view!.fullHeight).toBe(450);
      expect(Math.abs(view!.offsetX)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(view!.offsetY)).toBeLessThanOrEqual(0.5);
      offsets.add(`${view!.offsetX},${view!.offsetY}`);
      expect(camera.projectionMatrix.equals(plain)).toBe(false);
      post.endJitter();
      expect(camera.view?.enabled ?? false).toBe(false);
      expect(camera.projectionMatrix.equals(plain)).toBe(true);
    }
    expect(offsets.size).toBe(8);
  });

  it('jitters in whole drawing-buffer pixels at a fractional pixel ratio', () => {
    // 428 × 0.85 = 363.8: the canvas and the render targets are 363 pixels wide.
    const { camera, post } = setup();
    camera.aspect = 428 / 330;
    camera.updateProjectionMatrix();
    const plain = camera.projectionMatrix.clone();
    post.setSize(428, 330, 0.85);
    post.setSettings({ ...DEFAULT_POST, taa: true });
    post.beginJitter();
    expect(camera.view!.fullWidth).toBe(363);
    expect(camera.view!.fullHeight).toBe(280);
    post.endJitter();
    // setViewOffset sets aspect = 363 / 280; the viewport's own aspect must come back.
    expect(camera.aspect).toBe(428 / 330);
    expect(camera.projectionMatrix.equals(plain)).toBe(true);
  });

  it('leaves the camera alone when TAA is not running', () => {
    const { camera, post } = setup();
    post.beginJitter();
    expect(camera.view).toBeNull();
    post.setSettings({ ...DEFAULT_POST, taa: true });
    post.setTaaAllowed(false);
    post.beginJitter();
    expect(camera.view).toBeNull();
    post.endJitter();
    expect(camera.view).toBeNull();
  });
});

describe('PostStack wet lens', () => {
  const drop = { x: 0.5, y: 0.5, r: 0.02, age: 0.1, life: 3 };

  it('runs only while drops are on the lens and the setting is on', () => {
    const { post } = setup();
    post.setSettings({ ...DEFAULT_POST, lens: true });
    expect(post.lensRunning).toBe(false);
    expect(post.active).toBe(false);
    post.setLensDrops([drop]);
    expect(post.lensRunning).toBe(true);
    expect(post.active).toBe(true);
    post.setSettings({ ...DEFAULT_POST, lens: false });
    expect(post.lensRunning).toBe(false);
    expect(post.active).toBe(false);
    post.setSettings({ ...DEFAULT_POST, lens: true });
    post.setLensDrops([]);
    expect(post.active).toBe(false);
  });

  it('never runs on the light tier or without half-float targets', () => {
    const camera = new THREE.PerspectiveCamera();
    const light = new PostStack(fakeRenderer(), new THREE.Scene(), camera, 'light');
    light.setSettings({ ...DEFAULT_POST, lens: true });
    light.setLensDrops([drop]);
    expect(light.lensRunning).toBe(false);
    expect(light.active).toBe(false);
    const { post } = setup(false);
    post.setSettings({ ...DEFAULT_POST, lens: true });
    post.setLensDrops([drop]);
    expect(post.lensRunning).toBe(false);
  });

  it('is dry underwater', () => {
    const { post } = setup();
    post.setSettings({ ...DEFAULT_POST, lens: true });
    post.setLensDrops([drop]);
    post.setUnderwater(UNDER);
    expect(post.lensRunning).toBe(false);
  });
});
