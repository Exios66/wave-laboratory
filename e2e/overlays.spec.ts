import { expect, frames, test, trackErrors } from './fixtures';

// The scientific overlays add shader branches, vertex samplers and (velocity, pressure) extra
// FFT passes. Each mode must compile, draw some frames and show a legend with units.
test.use({ viewport: { width: 1300, height: 650 } });

const MODES = [
  { value: 'jacobian', legend: /Jacobian J/, unit: /stretched/ },
  { value: 'velocity', legend: /Orbital speed/, unit: /m\/s/ },
  { value: 'pressure', legend: /Dynamic pressure at 0 m depth/, unit: /kPa/ },
  { value: 'energy', legend: /Wave energy density/, unit: /J\/m²/ },
] as const;

for (const mode of MODES) {
  test(`${mode.value} overlay renders at low quality without errors`, async ({ page }) => {
    test.setTimeout(150_000);
    const errors = trackErrors(page);
    await page.addInitScript(() => localStorage.setItem('wave-lab:performance', 'low'));
    await page.goto('/?gfx=full');
    await expect(page.getByRole('status').filter({ hasText: 'Simulation running' })).toBeAttached({
      timeout: 60_000,
    });
    await page.getByRole('combobox', { name: 'Surface overlay' }).selectOption(mode.value);
    const legend = page.locator('figure.legend');
    await expect(legend).toContainText(mode.legend);
    await expect(legend).toContainText(mode.unit);
    await frames(page, 6);
    if (mode.value === 'pressure') {
      await legend.getByRole('spinbutton').fill('5');
      await expect(legend).toContainText(/at 5 m depth/);
      await frames(page, 4);
    }
    // Switching back must release the extra targets without errors.
    await page.getByRole('combobox', { name: 'Surface overlay' }).selectOption('none');
    await frames(page, 3);
    expect(errors).toEqual([]);
  });
}
