/**
 * One-click weather situations. Each sets the mean wind (environment) and the weather around
 * it; a wind sea that follows the weather then grows to match (fetch-limited JONSWAP).
 * Wind speeds are mid-class Beaufort values; visibilities and rain rates are typical of the
 * situation (WMO Manual on Codes; rain classes from the AMS Glossary).
 */
import { WeatherSchema, type Environment, type Weather } from '../schema/experiment';

export interface WeatherPreset {
  id: string;
  label: string;
  summary: string;
  wind: Pick<Environment, 'windSpeed'> & Partial<Pick<Environment, 'sunElevationDeg'>>;
  weather: Weather;
}

const w = (o: Partial<Weather>): Weather =>
  WeatherSchema.parse({ ...o, squalls: { enabled: false, ...o.squalls } });

export const WEATHER_PRESETS: readonly WeatherPreset[] = [
  {
    id: 'calm',
    label: 'Calm',
    summary: 'Beaufort 1, clear sky.',
    wind: { windSpeed: 1.5 },
    weather: w({ gustiness: 0.05, cloudCover: 0.1, visibilityKm: 50 }),
  },
  {
    id: 'breeze',
    label: 'Moderate breeze',
    summary: 'Beaufort 4, fair-weather cumulus.',
    wind: { windSpeed: 7 },
    weather: w({ gustiness: 0.09, cloudCover: 0.35, visibilityKm: 40 }),
  },
  {
    id: 'strong',
    label: 'Strong breeze',
    summary: 'Beaufort 6, gusty under a broken sky.',
    wind: { windSpeed: 12 },
    weather: w({ gustiness: 0.13, cloudCover: 0.6, visibilityKm: 25 }),
  },
  {
    id: 'gale',
    label: 'Gale',
    summary: 'Beaufort 8, overcast with showers.',
    wind: { windSpeed: 19 },
    weather: w({ gustiness: 0.15, cloudCover: 0.88, rainMmH: 4, visibilityKm: 12 }),
  },
  {
    id: 'storm',
    label: 'Storm',
    summary: 'Beaufort 10, heavy rain, lightning.',
    wind: { windSpeed: 26, sunElevationDeg: 18 },
    weather: w({
      gustiness: 0.18,
      cloudCover: 0.97,
      rainMmH: 20,
      visibilityKm: 4,
      lightning: true,
    }),
  },
  {
    id: 'hurricane',
    label: 'Hurricane',
    summary: 'Beaufort 12 eyewall: violent rain bands, squalls and lightning.',
    wind: { windSpeed: 42, sunElevationDeg: 15 },
    weather: w({
      gustiness: 0.22,
      cloudCover: 1,
      rainMmH: 60,
      visibilityKm: 1.5,
      lightning: true,
      squalls: { enabled: true, intervalMin: 6, durationMin: 2.5, strength: 1.3, veerDeg: 20 },
    }),
  },
  {
    id: 'squalls',
    label: 'Squall line',
    summary: 'Fresh wind broken by violent squall fronts with veer and downpours.',
    wind: { windSpeed: 9 },
    weather: w({
      gustiness: 0.14,
      cloudCover: 0.55,
      visibilityKm: 20,
      lightning: true,
      squalls: { enabled: true, intervalMin: 5, durationMin: 3, strength: 2.2, veerDeg: 45 },
    }),
  },
  {
    id: 'fog',
    label: 'Fog bank',
    summary: 'Light air and thick fog (visibility 300 m).',
    wind: { windSpeed: 3 },
    weather: w({ gustiness: 0.06, cloudCover: 0.9, visibilityKm: 0.3 }),
  },
];
