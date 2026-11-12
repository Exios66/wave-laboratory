import { test as base, type Page } from '@playwright/test';

/**
 * Fail fast on page errors. Every spec asserts at the end that the page logged no errors, but a
 * shader compile failure or an exception early in a test used to surface only after every
 * later wait had run out (minutes under SwiftShader). The first console error or uncaught
 * exception now closes the page, so the step in flight fails within milliseconds, and the test
 * then fails with the error that caused it rather than with "page closed".
 */
const tracked = new WeakMap<Page, { errors: string[]; armed: boolean }>();

export const test = base.extend<{ failFast: void }>({
  failFast: [
    async ({ page }, use, testInfo) => {
      const state = { errors: [] as string[], armed: false };
      const { errors } = state;
      tracked.set(page, state);
      const fail = (message: string) => {
        if (!state.armed) return;
        errors.push(message);
        if (errors.length === 1) void page.close().catch(() => undefined);
      };
      page.on('console', (msg) => {
        if (msg.type() === 'error') fail(msg.text());
      });
      page.on('pageerror', (err) => fail(err.message));
      await use();
      if (errors.length > 0) {
        testInfo.annotations.push({ type: 'page error', description: errors[0] });
        throw new Error(`The page logged an error:\n${errors.join('\n')}`);
      }
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';

/**
 * Make this test fail on the first page error (tests that do not call it keep ignoring them),
 * and return the errors logged so far, for `expect(errors).toEqual([])` at a checkpoint.
 */
export function trackErrors(page: Page): string[] {
  const state = tracked.get(page);
  if (!state) throw new Error('trackErrors needs the test from e2e/fixtures.ts');
  state.armed = true;
  return state.errors;
}

/**
 * Wait until the browser has drawn `count` more animation frames. Replaces fixed sleeps: it is
 * as long as a slow software renderer needs and no longer than a fast GPU does.
 */
export async function frames(page: Page, count: number): Promise<void> {
  await page.evaluate(
    (n) =>
      new Promise<void>((resolve) => {
        let left = n;
        const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    count,
  );
}
