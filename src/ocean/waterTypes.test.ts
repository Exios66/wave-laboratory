import { describe, expect, it } from 'vitest';
import { WATER_TYPES, transmit, waterOptics } from './waterTypes';

describe('Jerlov water types', () => {
  it('covers every schema value with positive K_d and scatter', () => {
    for (const [id, o] of Object.entries(WATER_TYPES)) {
      expect(o.label.length, id).toBeGreaterThan(3);
      for (const k of o.attenuation) expect(k, id).toBeGreaterThan(0);
      for (const s of o.scatter) expect(s, id).toBeGreaterThan(0);
    }
  });

  it('oceanic I is bluer and clearer than coastal 9', () => {
    const clear = waterOptics('oceanic-i');
    const turbid = waterOptics('coastal-9');
    expect(clear.scatter[2]).toBeGreaterThan(clear.scatter[0]!);
    expect(turbid.scatter[1]).toBeGreaterThan(turbid.scatter[2]!);
    expect(clear.attenuation[2]).toBeLessThan(turbid.attenuation[2]!);
    const tClear = transmit('oceanic-i', 8);
    const tTurbid = transmit('coastal-9', 8);
    expect(tClear[2]).toBeGreaterThan(tTurbid[2]!);
    expect(tTurbid[2]).toBeLessThan(0.01);
  });

  it('waterOptics is a lookup, not a copy that can drift', () => {
    expect(waterOptics('oceanic-ib')).toBe(WATER_TYPES['oceanic-ib']);
  });
});
