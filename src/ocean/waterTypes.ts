/**
 * Jerlov optical water types (Jerlov 1976; coefficients after Solonenko & Mobley 2015).
 *
 * Each type is described by its diffuse attenuation coefficient K_d [1/m] in three bands that
 * stand in for the red, green and blue channels (≈ 600, 530 and 470 nm), and by the colour of the
 * light scattered back up out of deep water. Clear oceanic water (type I) absorbs red quickly and
 * passes blue for tens of metres; turbid coastal water (types 1–9) is loaded with chlorophyll and
 * dissolved organic matter that absorb blue, so it looks green to brown and goes dark within a few
 * metres. These numbers drive rendering only (water colour, light through thin crests, the
 * underwater fog); the physics does not depend on them.
 */
import type { WaterType } from '../schema/experiment';

export interface WaterOptics {
  label: string;
  /** Diffuse attenuation K_d [1/m] for the red, green and blue channels. */
  attenuation: readonly [number, number, number];
  /** Linear RGB of the light scattered up out of deep water (the "body colour" of the sea). */
  scatter: readonly [number, number, number];
}

export const WATER_TYPES: Readonly<Record<WaterType, WaterOptics>> = {
  'oceanic-i': {
    label: 'Oceanic I (tropical blue)',
    attenuation: [0.245, 0.052, 0.02],
    scatter: [0.004, 0.032, 0.11],
  },
  'oceanic-ia': {
    label: 'Oceanic IA',
    attenuation: [0.25, 0.058, 0.026],
    scatter: [0.005, 0.036, 0.1],
  },
  'oceanic-ib': {
    label: 'Oceanic IB (open ocean)',
    attenuation: [0.255, 0.066, 0.034],
    scatter: [0.006, 0.04, 0.09],
  },
  'oceanic-ii': {
    label: 'Oceanic II',
    attenuation: [0.27, 0.09, 0.07],
    scatter: [0.008, 0.048, 0.075],
  },
  'oceanic-iii': {
    label: 'Oceanic III',
    attenuation: [0.3, 0.13, 0.13],
    scatter: [0.01, 0.055, 0.065],
  },
  'coastal-1': {
    label: 'Coastal 1',
    attenuation: [0.32, 0.12, 0.17],
    scatter: [0.012, 0.06, 0.058],
  },
  'coastal-3': {
    label: 'Coastal 3',
    attenuation: [0.36, 0.17, 0.26],
    scatter: [0.016, 0.062, 0.045],
  },
  'coastal-5': {
    label: 'Coastal 5 (coastal green)',
    attenuation: [0.42, 0.23, 0.4],
    scatter: [0.02, 0.06, 0.035],
  },
  'coastal-7': {
    label: 'Coastal 7',
    attenuation: [0.5, 0.33, 0.62],
    scatter: [0.026, 0.055, 0.026],
  },
  'coastal-9': {
    label: 'Coastal 9 (turbid harbour)',
    attenuation: [0.62, 0.48, 0.95],
    scatter: [0.032, 0.046, 0.018],
  },
};

export function waterOptics(type: WaterType): WaterOptics {
  return WATER_TYPES[type];
}
