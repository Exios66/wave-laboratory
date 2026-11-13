/** Plane view readout formatting (pure, so it is tested in node). */
import { msToKnots } from '../../core/units';

/** Feet per metre. */
const FT = 1 / 0.3048;
const GROUPED = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export interface RideReadout {
  altitudeM: number;
  speedMs: number;
  /** Compass heading [deg]. */
  headingDeg: number;
  /** Bank [deg], positive right wing down. */
  bankDeg: number;
}

/** `ALT 312 m · 1,024 ft · IAS 132 kn · HDG 274° · BANK 31° L` */
export function formatRideTelemetry(r: RideReadout): string {
  const hdg = ((Math.round(r.headingDeg) % 360) + 360) % 360;
  const bank = Math.round(Math.abs(r.bankDeg));
  const side = bank === 0 ? '' : r.bankDeg < 0 ? ' L' : ' R';
  return [
    `ALT ${GROUPED.format(r.altitudeM)} m`,
    `${GROUPED.format(r.altitudeM * FT)} ft`,
    `IAS ${GROUPED.format(msToKnots(r.speedMs))} kn`,
    `HDG ${String(hdg).padStart(3, '0')}°`,
    `BANK ${bank}°${side}`,
  ].join(' · ');
}
