import { describe, expect, it } from 'vitest';
import { formatRideTelemetry } from './rideHud';

describe('ride telemetry line', () => {
  it('reads altitude, airspeed, heading and bank the way a pilot would', () => {
    expect(
      formatRideTelemetry({ altitudeM: 312, speedMs: 68, headingDeg: 274.4, bankDeg: -30.6 }),
    ).toBe('ALT 312 m · 1,024 ft · IAS 132 kn · HDG 274° · BANK 31° L');
  });

  it('pads the heading, wraps 360 to 000 and drops the side when level', () => {
    expect(
      formatRideTelemetry({ altitudeM: 300, speedMs: 85, headingDeg: 359.7, bankDeg: 0.2 }),
    ).toBe('ALT 300 m · 984 ft · IAS 165 kn · HDG 000° · BANK 0°');
    expect(formatRideTelemetry({ altitudeM: 280, speedMs: 62, headingDeg: 5, bankDeg: 12.4 })).toBe(
      'ALT 280 m · 919 ft · IAS 121 kn · HDG 005° · BANK 12° R',
    );
  });
});
