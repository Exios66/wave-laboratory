/** Small procedural canvas textures for vessel details. */
import * as THREE from 'three';

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  if (g) draw(g);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Black flag with a skull and crossed bones. */
export function jollyRogerTexture(): THREE.Texture {
  return canvasTexture(256, 160, (g) => {
    g.fillStyle = '#0b0b0b';
    g.fillRect(0, 0, 256, 160);
    g.strokeStyle = '#ededea';
    g.fillStyle = '#ededea';
    g.lineCap = 'round';
    g.lineWidth = 14;
    g.beginPath();
    g.moveTo(78, 128);
    g.lineTo(178, 58);
    g.moveTo(78, 58);
    g.lineTo(178, 128);
    g.stroke();
    g.beginPath();
    g.arc(128, 66, 34, 0, Math.PI * 2);
    g.fill();
    g.fillRect(108, 86, 40, 24);
    g.fillStyle = '#0b0b0b';
    g.beginPath();
    g.arc(115, 64, 9, 0, Math.PI * 2);
    g.arc(141, 64, 9, 0, Math.PI * 2);
    g.fill();
    g.fillRect(118, 98, 4, 12);
    g.fillRect(126, 98, 4, 12);
    g.fillRect(134, 98, 4, 12);
  });
}

/** Flight-deck paint: edge lines, a dashed centre line and yellow taxi lines. */
export function flightDeckTexture(): THREE.Texture {
  return canvasTexture(1024, 192, (g) => {
    g.fillStyle = '#3b4047';
    g.fillRect(0, 0, 1024, 192);
    g.fillStyle = 'rgba(255,255,255,0.05)';
    for (let i = 0; i < 400; i++) g.fillRect(Math.random() * 1024, Math.random() * 192, 6, 2);
    g.strokeStyle = '#e9ecef';
    g.lineWidth = 3;
    g.strokeRect(6, 6, 1012, 180);
    g.setLineDash([28, 22]);
    g.beginPath();
    g.moveTo(10, 96);
    g.lineTo(1014, 96);
    g.stroke();
    g.setLineDash([]);
    g.strokeStyle = '#facc15';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(560, 160);
    g.lineTo(1010, 40);
    g.moveTo(600, 170);
    g.lineTo(1010, 70);
    g.stroke();
  });
}
