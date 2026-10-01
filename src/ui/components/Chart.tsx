/**
 * Thin uPlot wrapper. Charts redraw at most ~4 times per second from the telemetry history and
 * pick their colours from the active theme. Every chart also has a text summary (aria-label)
 * and the Statistics tab offers the same information as an accessible table.
 */
import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { telemetry } from '../telemetry';
import { useLab } from '../store';

export interface ChartSeries {
  label: string;
  /** CSS custom property name for the colour, e.g. '--chart-1'. */
  colorVar: string;
  unit: string;
  dash?: number[];
}

interface ChartProps {
  title: string;
  series: ChartSeries[];
  /** Produce x (shared) and y arrays. Called on every refresh. */
  getData: () => [ArrayLike<number>, ...ArrayLike<number>[]];
  xLabel: string;
  yLabel: string;
  logX?: boolean;
  logY?: boolean;
  /** Text summary for assistive tech. */
  summary: string;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

export function Chart({ title, series, getData, xLabel, yLabel, logX, logY, summary }: ChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const getDataRef = useRef(getData);
  useEffect(() => {
    getDataRef.current = getData;
  });
  const theme = useLab((s) => s.theme);
  const seriesKey = series.map((s) => s.label).join('|');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const grid = { stroke: cssVar('--chart-grid'), width: 1 };
    const axis = {
      stroke: cssVar('--text-muted'),
      grid,
      ticks: { stroke: cssVar('--chart-grid') },
      font: '12px system-ui, sans-serif',
      labelFont: '12px system-ui, sans-serif',
    };
    const opts: uPlot.Options = {
      width: Math.max(200, host.clientWidth),
      height: Math.max(120, host.clientHeight),
      legend: { show: true, live: false },
      cursor: { drag: { x: false, y: false } },
      scales: {
        x: { time: false, ...(logX ? { distr: 3 } : {}) },
        y: logY ? { distr: 3 } : {},
      },
      axes: [
        { ...axis, label: xLabel },
        { ...axis, label: yLabel, size: 56 },
      ],
      series: [
        { label: xLabel },
        ...series.map((s) => ({
          label: `${s.label} [${s.unit}]`,
          stroke: cssVar(s.colorVar),
          width: 1.6,
          ...(s.dash ? { dash: s.dash } : {}),
          points: { show: false },
        })),
      ],
    };
    const plot = new uPlot(opts, getDataRef.current() as uPlot.AlignedData, host);
    plotRef.current = plot;
    const ro = new ResizeObserver(() => {
      plot.setSize({
        width: Math.max(200, host.clientWidth),
        height: Math.max(120, host.clientHeight),
      });
    });
    ro.observe(host);
    let pending = false;
    let last = 0;
    const refresh = () => {
      if (pending) return;
      pending = true;
      const delay = Math.max(0, 250 - (performance.now() - last));
      setTimeout(() => {
        pending = false;
        last = performance.now();
        plot.setData(getDataRef.current() as uPlot.AlignedData);
      }, delay);
    };
    const unsub = telemetry.subscribe(refresh);
    return () => {
      unsub();
      ro.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
    // Rebuild when the series set, axes or theme change.
  }, [seriesKey, xLabel, yLabel, logX, logY, theme, series]);

  return (
    <figure className="chart" aria-label={`${title}. ${summary}`}>
      <figcaption>{title}</figcaption>
      <div className="chart__plot" ref={hostRef} aria-hidden="true" />
    </figure>
  );
}
