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

/**
 * The series key is drawn in the caption line (uPlot's own legend sat under the plot and took
 * a third of a short dock, leaving a plot area only 10–20 px tall), so the plot gets the
 * host's full height.
 */
function plotSize(host: HTMLElement): { width: number; height: number } {
  return {
    width: Math.max(160, host.clientWidth),
    height: Math.max(110, host.clientHeight),
  };
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
    const initial = plotSize(host);
    const opts: uPlot.Options = {
      width: initial.width,
      height: initial.height,
      legend: { show: false },
      cursor: { drag: { x: false, y: false } },
      scales: {
        x: { time: false, ...(logX ? { distr: 3 } : {}) },
        y: logY ? { distr: 3 } : {},
      },
      axes: [
        { ...axis, label: xLabel, size: 34, labelSize: 14, labelGap: 0 },
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
      plot.setSize(plotSize(host));
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
      <figcaption>
        <span>{title}</span>
        <span className="chart__key" aria-hidden="true">
          {series.map((s) => (
            <span key={s.label} className="chart__key-item">
              <i
                className={s.dash ? 'chart__swatch chart__swatch--dash' : 'chart__swatch'}
                style={{ borderColor: `var(${s.colorVar})` }}
              />
              {s.label} [{s.unit}]
            </span>
          ))}
        </span>
      </figcaption>
      <div className="chart__plot" ref={hostRef} aria-hidden="true" />
    </figure>
  );
}
