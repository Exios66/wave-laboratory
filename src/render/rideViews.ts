/**
 * The Plane view's camera choices. Kept free of Three.js so the UI can list and validate them
 * without pulling the renderer into the entry chunk (rideCamera.ts does the maths).
 */
export type RideView = 'chase' | 'cockpit' | 'wing' | 'flyby';

export const RIDE_VIEWS: readonly RideView[] = ['chase', 'cockpit', 'wing', 'flyby'];

/** How each view is named in the HUD and in notices. */
export const RIDE_VIEW_LABELS: Readonly<Record<RideView, string>> = {
  chase: 'Chase',
  cockpit: 'Cockpit',
  wing: 'Wing',
  flyby: 'Fly-by',
};
