import { describe, expect, it } from 'vitest';
import { renderCostText, renderCostTitle } from './renderCost';

describe('render cost readout', () => {
  it('shows frame rate and GPU time when the browser measures it', () => {
    expect(renderCostText(61.6, 7.06)).toBe('62 fps · GPU 7.1 ms');
    expect(renderCostText(30, null)).toBe('30 fps');
    expect(renderCostText(0, 5)).toBe('');
  });

  it('lists the GPU passes in frame order in the tooltip', () => {
    expect(renderCostTitle({ scene: 4, ocean: 0.84, post: 1.06, prepass: 1.2 })).toBe(
      'GPU time per pass: ocean 0.8 ms · prepass 1.2 ms · scene 4.0 ms · post 1.1 ms',
    );
    expect(renderCostTitle({ ocean: 1, scene: 2 })).toBe(
      'GPU time per pass: ocean 1.0 ms · scene 2.0 ms',
    );
    expect(renderCostTitle(null)).toBe('Frames drawn per second and GPU time per frame');
  });

  it('says in the tooltip when temporal antialiasing is blending frames', () => {
    expect(renderCostTitle({ ocean: 1, scene: 2 }, true)).toBe(
      'GPU time per pass: ocean 1.0 ms · scene 2.0 ms. Temporal antialiasing on',
    );
    expect(renderCostTitle(null, true)).toBe(
      'Frames drawn per second and GPU time per frame. Temporal antialiasing on',
    );
    expect(renderCostTitle(null, false)).toBe('Frames drawn per second and GPU time per frame');
  });

  it('says when raindrops are on the lens', () => {
    expect(renderCostTitle(null, false, true)).toBe(
      'Frames drawn per second and GPU time per frame. Raindrops on the lens',
    );
    expect(renderCostTitle(null, true, true)).toBe(
      'Frames drawn per second and GPU time per frame. Temporal antialiasing on. Raindrops on the lens',
    );
  });
});
