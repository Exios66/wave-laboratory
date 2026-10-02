/** Default vessel factory: wires experiment vessel configs to the vessel dynamics module. */
import type { OceanField } from '../ocean/oceanField';
import type { VesselConfig } from '../schema/experiment';
import type { WeatherField } from '../weather/weather';
import { createVesselDefinition, Vessel } from '../vessel';
import type { SimVessel } from './Simulation';

export function createSimVessel(
  config: VesselConfig,
  field: OceanField,
  weather?: WeatherField,
): SimVessel {
  const definition = createVesselDefinition(config.type, config.scale, config.kgFactor);
  return new Vessel(config.id, definition, config, field, weather ? { wind: weather } : {});
}
