/**
 * Shared contract for the decorative scenery layers (islands, sea life, seabirds, sailors) and
 * the sky/lighting controller. None of this feeds back into the physics: islands do not block
 * waves and animals do not disturb the sea.
 *
 * Coordinates: layers live in the Three.js scene, which is y-up. World (x east, y north, z up)
 * maps to Three.js as (x, z, −y).
 */
import type * as THREE from 'three';
import type { WaterType } from '../../schema/experiment';
import type { VesselDefinition } from '../../vessel/api';

/**
 * How much ambient scenery the device can afford. Resolved from the device-capped quality
 * (`low` → lite, `medium` → mid, otherwise full) and carried in `SceneryFrame.tier`; each
 * scenery module holds the caps it enforces for its own tier.
 */
export type SceneryTier = 'full' | 'mid' | 'lite';

/** Viewer preferences for the ambience. Stored per browser, not in experiment files. */
export interface AmbienceSettings {
  /** Run the day:night cycle. When off, the experiment's fixed sun is used. */
  dayNight: boolean;
  /** Real minutes for one full 24 h day at 1× simulation speed. */
  dayLengthMin: number;
  /** Clock time [h, 0–24] the cycle starts from (and resets to). */
  startHour: number;
  islands: boolean;
  /** Dolphins, whales, turtles, fish and seabirds (shown in fair weather). */
  wildlife: boolean;
  sailors: boolean;
  /** Rare old aircraft passing overhead (the Bermuda Triangle's lost flights). */
  planes: boolean;
  /** Background naval traffic: fishing fleets, merchant lanes, patrol boats, tankers and liners. */
  traffic: boolean;
  /** Offshore oil rigs, wind turbines and navigation buoys. */
  structures: boolean;
  /** Seabed, kelp forests, coral, shipwrecks and underwater atmosphere. */
  underwater: boolean;
  /** Opt-in pirate luggers and low recon aircraft passes (off by default). */
  hostiles: boolean;
}

export const DEFAULT_AMBIENCE: AmbienceSettings = {
  dayNight: true,
  dayLengthMin: 12,
  startHour: 10,
  islands: true,
  wildlife: true,
  sailors: true,
  planes: true,
  traffic: true,
  structures: true,
  underwater: true,
  hostiles: false,
};

export const DAY_LENGTH_RANGE = { min: 1, max: 120 } as const;

/** A vessel as the scenery sees it. `group` is the hull's Three.js group (body frame). */
export interface SceneryVessel {
  id: string;
  definition: VesselDefinition;
  /**
   * Body-frame group in Three.js axes: body x (bow) → three x, body z (up) → three y,
   * body y (port) → three −z. Origin at the CoG. Children move with the hull.
   */
  group: THREE.Group;
}

export interface VesselMotion {
  id: string;
  speedKn: number;
  capsized: boolean;
}

/** Everything a layer needs to animate one rendered frame. */
export interface SceneryFrame {
  /** Simulation time being drawn [s]. Pauses with the simulation. */
  t: number;
  /** Wall-clock seconds since the previous frame (clamped to 0.1). Keeps running when paused. */
  dt: number;
  /** Seconds since the renderer started (wall clock). Good for idle animation. */
  wallT: number;
  camera: THREE.PerspectiveCamera;
  /** The camera is on a ship's bridge (crew right in front of the lens are hidden). */
  bridgeView?: boolean;
  /** 0 = storm, 1 = fair and calm. Smoothed over several seconds. */
  calm: number;
  /** 0 = deep night, 1 = full daylight. */
  daylight: number;
  /** Clock time [h, 0–24]. */
  timeOfDay: number;
  /** Unit vector toward the sun, Three.js axes. */
  sunDir: THREE.Vector3;
  /** 10 m wind [m/s] and the compass bearing it blows FROM [deg]. */
  windSpeed: number;
  windDirectionDeg: number;
  /** Significant wave height of the current sea [m]. */
  hs: number;
  vessels: readonly VesselMotion[];
  /** World positions (Three.js axes) of the vessels' CoGs, same order as `vessels`. */
  vesselPositions: readonly THREE.Vector3[];
  /** Whether the camera is currently submerged below the surface. */
  underwater?: boolean;
  /** Depth of the submerged camera below the local wave surface [m]. */
  cameraDepth?: number;
  /** Still-water depth of the experiment [m]: sets the seafloor depth (or blue water when deep). */
  waterDepth?: number;
  /** Island scenery is on: islands raise reef shelves out of deep water. */
  islands?: boolean;
  /** Current Jerlov water type, for underwater tinting and bioluminescence. */
  waterType?: WaterType;
  /** Scenery performance tier ('full' | 'mid' | 'lite'). */
  tier?: SceneryTier;
  /** Whether opt-in hostiles (pirates and recon passes) are enabled. */
  hostiles?: boolean;
}

export interface SceneryLayer {
  /** Root object added to the scene (or an empty group for layers that attach elsewhere). */
  readonly object: THREE.Object3D;
  /** Called after the vessel list changes, and with [] before old vessels are disposed. */
  setVessels?(vessels: readonly SceneryVessel[]): void;
  setEnabled(enabled: boolean): void;
  update(frame: SceneryFrame): void;
  dispose(): void;
}
