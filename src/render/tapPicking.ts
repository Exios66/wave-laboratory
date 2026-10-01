/**
 * Tap/click picking that does not fire for drags: works for mouse, pen and touch (pointer events).
 * A gesture counts as a tap only when a single pointer goes down and up within `maxMovePx` CSS
 * pixels and `maxDurationMs`; orbiting, panning and pinching therefore never select anything.
 * Listeners are passive and attached to the canvas only, so page scrolling elsewhere is untouched.
 */
import type { PickResult } from './api';

export interface TapPickingOptions {
  /** Movement beyond which the gesture is a drag [CSS px]. Default 6. */
  maxMovePx?: number;
  /** Longer presses are not taps [ms]. Default 600. */
  maxDurationMs?: number;
}

export type TapPickHandler = (result: PickResult | null, event: PointerEvent) => void;

export function installTapPicking(
  canvas: HTMLCanvasElement,
  pick: (x: number, y: number) => PickResult | null,
  onPick: TapPickHandler,
  options: TapPickingOptions = {},
): () => void {
  const maxMove = options.maxMovePx ?? 6;
  const maxDuration = options.maxDurationMs ?? 600;
  let active = -1;
  let startX = 0;
  let startY = 0;
  let startT = 0;
  let cancelled = false;
  let down = 0;

  const onDown = (e: PointerEvent) => {
    down++;
    if (down > 1) {
      cancelled = true; // multi-touch gesture (pinch/pan)
      return;
    }
    if (e.button !== 0) {
      cancelled = true;
      return;
    }
    active = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    startT = e.timeStamp;
    cancelled = false;
  };
  const onMove = (e: PointerEvent) => {
    if (e.pointerId !== active || cancelled) return;
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > maxMove) cancelled = true;
  };
  const onUp = (e: PointerEvent) => {
    down = Math.max(0, down - 1);
    if (e.pointerId !== active) return;
    active = -1;
    if (cancelled) return;
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > maxMove) return;
    if (e.timeStamp - startT > maxDuration) return;
    const rect = canvas.getBoundingClientRect();
    onPick(pick(e.clientX - rect.left, e.clientY - rect.top), e);
  };
  const onCancel = (e: PointerEvent) => {
    down = Math.max(0, down - 1);
    if (e.pointerId === active) {
      active = -1;
      cancelled = true;
    }
  };

  const opts: AddEventListenerOptions = { passive: true };
  canvas.addEventListener('pointerdown', onDown, opts);
  // Moves/ups may leave the canvas while OrbitControls captures the pointer.
  window.addEventListener('pointermove', onMove, opts);
  window.addEventListener('pointerup', onUp, opts);
  window.addEventListener('pointercancel', onCancel, opts);
  return () => {
    canvas.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
  };
}
