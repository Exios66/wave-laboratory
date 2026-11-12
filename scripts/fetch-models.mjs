#!/usr/bin/env node
// Download the CC0 scenery models from Poly Haven and optimise them into public/models/*.glb.
//
//   node scripts/fetch-models.mjs [cacheDir]
//
// The output is committed; this script only needs re-running to change the asset list or
// budgets. Each model is merged to one mesh per material, simplified to a triangle budget,
// its textures resized and re-encoded as WebP, and its vertex data meshopt-compressed.
// All assets are CC0 (https://polyhaven.com/license); credits go to public/models/CREDITS.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  center,
  dedup,
  flatten,
  join,
  meshopt,
  prune,
  simplify,
  textureCompress,
  weld,
} from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

/** Poly Haven id → output name, triangle budget, texture size [px]. */
const ASSETS = [
  { id: 'coast_rocks_01', name: 'rock-a', tris: 3000, tex: 512 },
  { id: 'coast_rocks_05', name: 'rock-b', tris: 3000, tex: 512 },
  { id: 'ocean_buoy', name: 'buoy', tris: 4000, tex: 512 },
  { id: 'lifebuoy', name: 'lifebuoy', tris: 800, tex: 256 },
];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'public', 'models');
const cache = process.argv[2] ?? path.join(os.tmpdir(), 'wave-lab-models');
const API = 'https://api.polyhaven.com';

async function download(url, file) {
  if (fs.existsSync(file)) return;
  const res = await fetch(url, { headers: { 'User-Agent': 'wave-laboratory-asset-script' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

async function fetchAsset(id) {
  const res = await fetch(`${API}/files/${id}`, {
    headers: { 'User-Agent': 'wave-laboratory-asset-script' },
  });
  const files = await res.json();
  const g = files.gltf['1k'].gltf;
  const dir = path.join(cache, id);
  const main = path.join(dir, g.url.split('/').pop());
  await download(g.url, main);
  for (const [rel, inc] of Object.entries(g.include)) await download(inc.url, path.join(dir, rel));
  return main;
}

function triangles(doc) {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      n += (idx ? idx.getCount() : prim.getAttribute('POSITION').getCount()) / 3;
    }
  }
  return n;
}

await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.encoder': MeshoptEncoder,
});
fs.mkdirSync(outDir, { recursive: true });
const credits = [];
for (const a of ASSETS) {
  const src = await fetchAsset(a.id);
  const doc = await io.read(src);
  await doc.transform(dedup(), flatten(), join(), weld());
  const before = triangles(doc);
  const ratio = Math.min(1, a.tris / before);
  await doc.transform(
    simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.01, lockBorder: false }),
    center({ pivot: 'below' }),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [a.tex, a.tex], quality: 80 }),
    prune(),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  const out = path.join(outDir, `${a.name}.glb`);
  await io.write(out, doc);
  const bounds = doc.getRoot().listScenes()[0];
  const size = fs.statSync(out).size;
  console.log(
    `${a.name}: ${Math.round(before)} → ${Math.round(triangles(doc))} triangles, ${(size / 1024).toFixed(0)} KB`,
    bounds ? '' : '',
  );
  credits.push(`| \`${a.name}.glb\` | [${a.id}](https://polyhaven.com/a/${a.id}) |`);
}
fs.writeFileSync(
  path.join(outDir, 'CREDITS.md'),
  `# Scenery models

All models are from [Poly Haven](https://polyhaven.com) and released under
[CC0](https://polyhaven.com/license) (public domain). They were simplified, their textures resized
and re-encoded, and their meshes compressed by \`scripts/fetch-models.mjs\`.

| File | Source |
|---|---|
${credits.join('\n')}
`,
);
