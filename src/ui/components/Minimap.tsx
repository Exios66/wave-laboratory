/**
 * Chart in the corner of the 3D view: where the camera is and which way it looks, the vessels
 * with their recent tracks, wave gauges, islands with their reefs and lighthouses, and the
 * wind. Click the water or an island to send the camera there; click a vessel to select it.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { LabRendererApi, MapIsland, NavigationView } from '../../render/api';
import { getRuntime } from '../runtime';
import { useLab } from '../store';
import {
  DEFAULT_RANGE,
  MAP_RANGES,
  bearingToScreen,
  compassPoint,
  formatBearing,
  formatDistance,
  formatPosition,
  mapToWorld,
  stepRange,
  worldToMap,
  type MapFrame,
} from './minimapMath';

interface MapPrefs {
  open: boolean;
  range: number;
  northUp: boolean;
}

const PREFS_KEY = 'wave-lab:minimap';
const DEFAULT_PREFS: MapPrefs = { open: true, range: DEFAULT_RANGE, northUp: true };

function readPrefs(): MapPrefs {
  // Small screens start with the chart folded away so it does not cover the view.
  const open = typeof window === 'undefined' || window.innerWidth >= 700;
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<MapPrefs>;
    return {
      open: typeof raw.open === 'boolean' ? raw.open : open,
      range: MAP_RANGES.includes(raw.range as (typeof MAP_RANGES)[number])
        ? (raw.range as number)
        : DEFAULT_PREFS.range,
      northUp: typeof raw.northUp === 'boolean' ? raw.northUp : DEFAULT_PREFS.northUp,
    };
  } catch {
    return { ...DEFAULT_PREFS, open };
  }
}

function writePrefs(p: MapPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable: the choice lasts for this session only */
  }
}

/** Seconds between track points, and how many points each vessel keeps. */
const TRACK_EVERY = 1;
const TRACK_POINTS = 240;
/** Minimum time between map redraws [ms]. */
const DRAW_INTERVAL = 66;

interface Track {
  t: number;
  pts: { x: number; y: number }[];
}

interface Hit {
  kind: 'vessel';
  id: string;
}

export function Minimap() {
  const [prefs, setPrefs] = useState<MapPrefs>(readPrefs);
  const [nav, setNav] = useState<NavigationView | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const prefsRef = useRef(prefs);
  const tracks = useRef(new Map<string, Track>());
  const islands = useRef<{ cx: number; cy: number; range: number; list: MapIsland[] } | null>(null);
  const frameRef = useRef<MapFrame | null>(null);
  const lastNavText = useRef(0);
  const revision = useLab((s) => s.revision);
  const islandsOn = useLab((s) => s.ambience.islands);

  const update = useCallback((patch: Partial<MapPrefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      writePrefs(next);
      return next;
    });
  }, []);

  useEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);

  // A new experiment starts fresh tracks; toggling the islands re-reads the chart.
  useEffect(() => {
    tracks.current.clear();
  }, [revision]);
  useEffect(() => {
    islands.current = null;
  }, [islandsOn]);

  useEffect(() => {
    if (!prefs.open) return;
    let raf = 0;
    let last = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last < DRAW_INTERVAL) return;
      last = now;
      const canvas = canvasRef.current;
      const r = getRuntime().rendererApi;
      if (!canvas || !r) return;
      const view = r.getNavigation();
      draw(canvas, r, view, prefsRef.current, tracks.current, islands, frameRef);
      // The text readout changes far less often than the picture.
      if (now - lastNavText.current > 400) {
        lastNavText.current = now;
        setNav(view);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [prefs.open]);

  const sendCamera = (point: { x: number; y: number }) => {
    const r = getRuntime().rendererApi;
    if (!r) return;
    const lab = useLab.getState();
    if (lab.camera === 'follow' || lab.camera === 'bridge') lab.setCamera('orbit');
    r.setExplorePoint(point);
  };

  const recentre = () => getRuntime().rendererApi?.setExplorePoint(null);

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const f = frameRef.current;
    if (!f) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left - rect.width / 2;
    const py = e.clientY - rect.top - rect.height / 2;
    const hit = hitTest(px, py);
    const lab = useLab.getState();
    if (hit) {
      lab.select({ kind: 'vessel', id: hit.id });
      getRuntime().rendererApi?.setExplorePoint(null);
      lab.setCamera(lab.camera, hit.id);
      return;
    }
    if (Math.hypot(px, py) > f.radiusPx) return;
    sendCamera(mapToWorld(f, px, py));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLCanvasElement>) => {
    const f = frameRef.current;
    const step = prefs.range * 0.2;
    const moves: Record<string, [number, number]> = {
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
    };
    const move = moves[e.key];
    if (move && f) {
      e.preventDefault();
      const target = nav?.explore ?? { x: f.cx, y: f.cy };
      // Arrows move in screen directions on the map, whichever way it is turned.
      const base = worldToMap(f, target.x, target.y);
      const px = f.radiusPx / f.range;
      sendCamera(mapToWorld(f, base.x + move[0] * step * px, base.y + move[1] * step * px));
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      update({ range: stepRange(prefs.range, -1) });
    } else if (e.key === '-') {
      e.preventDefault();
      update({ range: stepRange(prefs.range, 1) });
    } else if (e.key === 'Home' || e.key === 'Escape') {
      if (nav?.explore) {
        e.preventDefault();
        recentre();
      }
    }
  };

  if (!prefs.open) {
    return (
      <button
        type="button"
        className="minimap__show hud__card"
        onClick={() => update({ open: true })}
        aria-label="Show chart"
        title="Show chart"
      >
        <ChartIcon /> Chart
      </button>
    );
  }

  return (
    <section className="minimap hud__card" aria-labelledby="minimap-title">
      <div className="minimap__bar">
        <h3 id="minimap-title" className="minimap__title">
          Chart
        </h3>
        <span className="minimap__range" aria-label={`Range ${formatDistance(prefs.range)}`}>
          {formatDistance(prefs.range)}
        </span>
        <div className="minimap__tools">
          <button
            type="button"
            onClick={() => update({ range: stepRange(prefs.range, -1) })}
            disabled={prefs.range === MAP_RANGES[0]}
            aria-label="Zoom chart in"
            title="Zoom in"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => update({ range: stepRange(prefs.range, 1) })}
            disabled={prefs.range === MAP_RANGES[MAP_RANGES.length - 1]}
            aria-label="Zoom chart out"
            title="Zoom out"
          >
            −
          </button>
          <button
            type="button"
            aria-pressed={!prefs.northUp}
            onClick={() => update({ northUp: !prefs.northUp })}
            aria-label="Turn the chart with the camera heading"
            title={
              prefs.northUp ? 'North up (click for heading up)' : 'Heading up (click for north up)'
            }
          >
            {prefs.northUp ? 'N↑' : 'H↑'}
          </button>
          <button
            type="button"
            onClick={() => update({ open: false })}
            aria-label="Hide chart"
            title="Hide chart"
          >
            ×
          </button>
        </div>
      </div>
      <canvas
        ref={canvasRef}
        className="minimap__canvas"
        tabIndex={0}
        aria-label="Chart around the camera. Click the water or an island to send the camera there, click a vessel to select it. With the chart focused, arrow keys move the camera, plus and minus zoom, Home returns to the fleet."
        aria-describedby="minimap-readout"
        onClick={onClick}
        onKeyDown={onKeyDown}
        onWheel={(e) => update({ range: stepRange(prefsRef.current.range, e.deltaY > 0 ? 1 : -1) })}
      />
      <div className="minimap__foot">
        <p id="minimap-readout" className="minimap__readout">
          {nav ? (
            <>
              <span>{formatPosition(nav.x, nav.y)}</span>
              <span>
                Hdg {formatBearing(nav.headingDeg)} {compassPoint(nav.headingDeg)}
              </span>
            </>
          ) : (
            <span>—</span>
          )}
        </p>
        {nav?.explore && (
          <button type="button" className="minimap__recentre" onClick={recentre}>
            Back to fleet
          </button>
        )}
      </div>
    </section>
  );
}

function ChartIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 3.2 10 9 8 8 6 9z" fill="currentColor" />
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------------------------

const COLORS = {
  seaInner: '#12385a',
  seaOuter: '#08182c',
  ring: 'rgba(148, 196, 230, 0.22)',
  ringText: 'rgba(200, 225, 245, 0.75)',
  reef: 'rgba(94, 234, 212, 0.28)',
  sand: '#e8d6a0',
  land: '#4f8a3a',
  lighthouse: '#fde047',
  vessel: '#e6edf7',
  selected: '#fbbf24',
  capsized: '#f87171',
  track: 'rgba(230, 237, 247, 0.35)',
  probe: '#fb923c',
  cone: 'rgba(56, 189, 248, 0.22)',
  camera: '#38bdf8',
  explore: '#38bdf8',
  north: '#f87171',
  wind: '#cbd5e1',
};

/** Vessels drawn on the last frame, for clicks: map pixels and id. */
let vesselHits: { x: number; y: number; id: string }[] = [];

function hitTest(px: number, py: number): Hit | null {
  let best: Hit | null = null;
  let bestD = 12;
  for (const v of vesselHits) {
    const d = Math.hypot(v.x - px, v.y - py);
    if (d < bestD) {
      bestD = d;
      best = { kind: 'vessel', id: v.id };
    }
  }
  return best;
}

function draw(
  canvas: HTMLCanvasElement,
  r: LabRendererApi,
  view: NavigationView,
  prefs: MapPrefs,
  tracks: Map<string, Track>,
  islandCache: { current: { cx: number; cy: number; range: number; list: MapIsland[] } | null },
  frameRef: { current: MapFrame | null },
): void {
  const css = canvas.clientWidth;
  if (css <= 0) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const px = Math.round(css * dpr);
  if (canvas.width !== px || canvas.height !== px) {
    canvas.width = px;
    canvas.height = px;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const half = css / 2;
  const radiusPx = half - 2;
  const f: MapFrame = {
    cx: view.x,
    cy: view.y,
    range: prefs.range,
    radiusPx,
    upDeg: prefs.northUp ? 0 : view.headingDeg,
  };
  frameRef.current = f;
  const s = radiusPx / f.range;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, css, css);
  ctx.save();
  ctx.translate(half, half);
  ctx.beginPath();
  ctx.arc(0, 0, radiusPx, 0, Math.PI * 2);
  ctx.clip();
  const sea = ctx.createRadialGradient(0, 0, radiusPx * 0.1, 0, 0, radiusPx);
  sea.addColorStop(0, COLORS.seaInner);
  sea.addColorStop(1, COLORS.seaOuter);
  ctx.fillStyle = sea;
  ctx.fillRect(-half, -half, css, css);

  // Range ring at half range, and cross hairs along the map axes.
  ctx.strokeStyle = COLORS.ring;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(0, 0, radiusPx / 2, 0, Math.PI * 2);
  ctx.moveTo(-radiusPx, 0);
  ctx.lineTo(radiusPx, 0);
  ctx.moveTo(0, -radiusPx);
  ctx.lineTo(0, radiusPx);
  ctx.stroke();

  // Islands: reef halo, sand, green interior, blinking lighthouse.
  const cache = islandCache.current;
  if (
    !cache ||
    cache.range !== f.range ||
    Math.hypot(cache.cx - f.cx, cache.cy - f.cy) > f.range * 0.25
  ) {
    islandCache.current = {
      cx: f.cx,
      cy: f.cy,
      range: f.range,
      list: r.mapIslands(f.cx, f.cy, f.range * 1.6),
    };
  }
  const blink = Math.floor(performance.now() / 700) % 2 === 0;
  for (const isl of islandCache.current!.list) {
    const p = worldToMap(f, isl.x, isl.y);
    const reef = isl.reefRadius * s;
    if (Math.hypot(p.x, p.y) - reef > radiusPx) continue;
    if (reef > 2) {
      ctx.fillStyle = COLORS.reef;
      ctx.beginPath();
      ctx.arc(p.x, p.y, reef, 0, Math.PI * 2);
      ctx.fill();
    }
    const land = Math.max(1.5, isl.radius * s);
    ctx.fillStyle = COLORS.sand;
    ctx.beginPath();
    ctx.arc(p.x, p.y, land, 0, Math.PI * 2);
    ctx.fill();
    if (land > 3) {
      ctx.fillStyle = COLORS.land;
      ctx.beginPath();
      ctx.arc(p.x, p.y, land * 0.7, 0, Math.PI * 2);
      ctx.fill();
    }
    if (isl.lighthouse && blink) {
      ctx.fillStyle = COLORS.lighthouse;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // The camera at the centre: field-of-view wedge and a dot, under the vessels.
  const h = bearingToScreen(f, view.headingDeg);
  const halfFov = (Math.min(view.fovDeg, 150) * Math.PI) / 360;
  const cone = ctx.createRadialGradient(0, 0, 0, 0, 0, radiusPx * 0.75);
  cone.addColorStop(0, 'rgba(56, 189, 248, 0.38)');
  cone.addColorStop(1, 'rgba(56, 189, 248, 0)');
  ctx.fillStyle = cone;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, radiusPx * 0.75, h - halfFov, h + halfFov);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = COLORS.camera;
  ctx.strokeStyle = '#04263a';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(0, 0, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  const lab = useLab.getState();
  const frame = lab.frame;

  // Lab origin and wave gauges.
  const o = worldToMap(f, 0, 0);
  ctx.strokeStyle = COLORS.ringText;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(o.x - 4, o.y);
  ctx.lineTo(o.x + 4, o.y);
  ctx.moveTo(o.x, o.y - 4);
  ctx.lineTo(o.x, o.y + 4);
  ctx.stroke();
  ctx.fillStyle = COLORS.probe;
  for (const probe of lab.experiment.probes) {
    const p = worldToMap(f, probe.x, probe.y);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y - 3);
    ctx.lineTo(p.x + 3, p.y);
    ctx.lineTo(p.x, p.y + 3);
    ctx.lineTo(p.x - 3, p.y);
    ctx.closePath();
    ctx.fill();
  }

  // Vessel tracks and hulls.
  const selected = lab.selection?.kind === 'vessel' ? lab.selection.id : null;
  const hits: typeof vesselHits = [];
  for (const v of frame?.vessels ?? []) {
    let tr = tracks.get(v.id);
    if (!tr || frame!.t < tr.t - 1) {
      tr = { t: -Infinity, pts: [] };
      tracks.set(v.id, tr);
    }
    if (frame!.t - tr.t >= TRACK_EVERY) {
      tr.t = frame!.t;
      tr.pts.push({ x: v.position.x, y: v.position.y });
      if (tr.pts.length > TRACK_POINTS) tr.pts.shift();
    }
    if (tr.pts.length > 1) {
      ctx.strokeStyle = COLORS.track;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      tr.pts.forEach((pt, i) => {
        const q = worldToMap(f, pt.x, pt.y);
        if (i === 0) ctx.moveTo(q.x, q.y);
        else ctx.lineTo(q.x, q.y);
      });
      const now = worldToMap(f, v.position.x, v.position.y);
      ctx.lineTo(now.x, now.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  const defs = lab.vesselDefinitions;
  for (const v of frame?.vessels ?? []) {
    const p = worldToMap(f, v.position.x, v.position.y);
    hits.push({ x: p.x, y: p.y, id: v.id });
    const len = Math.max(9, (defs[v.id]?.length ?? 50) * s);
    const beam = Math.max(5, (defs[v.id]?.beam ?? 10) * s * 1.2, len * 0.32);
    const a = bearingToScreen(f, v.headingDeg);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(a);
    ctx.beginPath();
    ctx.moveTo(len * 0.6, 0);
    ctx.lineTo(-len * 0.4, beam / 2);
    ctx.lineTo(-len * 0.25, 0);
    ctx.lineTo(-len * 0.4, -beam / 2);
    ctx.closePath();
    ctx.fillStyle = v.capsized
      ? COLORS.capsized
      : v.id === selected
        ? COLORS.selected
        : COLORS.vessel;
    ctx.strokeStyle = 'rgba(4, 12, 24, 0.85)';
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  vesselHits = hits;

  // Exploration target.
  if (view.explore) {
    const p = worldToMap(f, view.explore.x, view.explore.y);
    const pulse = 5 + 2 * Math.sin(performance.now() / 250);
    ctx.strokeStyle = COLORS.explore;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, pulse, 0, Math.PI * 2);
    ctx.moveTo(p.x - 9, p.y);
    ctx.lineTo(p.x - 3, p.y);
    ctx.moveTo(p.x + 3, p.y);
    ctx.lineTo(p.x + 9, p.y);
    ctx.moveTo(p.x, p.y - 9);
    ctx.lineTo(p.x, p.y - 3);
    ctx.moveTo(p.x, p.y + 3);
    ctx.lineTo(p.x, p.y + 9);
    ctx.stroke();
  }

  ctx.restore();

  // Bezel: north marker on the rim, range label, wind arrow.
  ctx.save();
  ctx.translate(half, half);
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(0, 0, radiusPx, 0, Math.PI * 2);
  ctx.stroke();
  const n = bearingToScreen(f, 0);
  const nx = Math.cos(n) * (radiusPx - 9);
  const ny = Math.sin(n) * (radiusPx - 9);
  ctx.fillStyle = 'rgba(8, 14, 26, 0.8)';
  ctx.beginPath();
  ctx.arc(nx, ny, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = COLORS.north;
  ctx.font = '600 10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('N', nx, ny + 0.5);

  ctx.fillStyle = COLORS.ringText;
  ctx.font = '9px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(formatDistance(f.range / 2), 3, -radiusPx / 2 - 6);

  const weather = frame?.weather;
  if (weather && weather.windSpeed > 0.3) {
    // Arrow points where the wind blows TO, from the bottom-left of the dial.
    const wa = bearingToScreen(f, weather.windFromDeg + 180);
    const wx = -radiusPx * 0.68;
    const wy = radiusPx * 0.68;
    const L = 9;
    ctx.save();
    ctx.translate(wx, wy);
    ctx.rotate(wa);
    ctx.strokeStyle = COLORS.wind;
    ctx.fillStyle = COLORS.wind;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-L, 0);
    ctx.lineTo(L - 3, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(L, 0);
    ctx.lineTo(L - 5, 3.5);
    ctx.lineTo(L - 5, -3.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}
