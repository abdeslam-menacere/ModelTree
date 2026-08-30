import { expect, test, type Page } from '@playwright/test';
import { NARROW, gotoLineage, openFirstRelease } from './lineage-helpers';

// Issue #14, acceptance criterion 5: "reduced-motion users get no nonessential
// animation."
//
// `global.test.ts` already asserts the `@media (prefers-reduced-motion: reduce)`
// block exists and targets `*`. That is a fact about the stylesheet. This is the
// fact the criterion is about: with the preference set, the engine computes no
// motion on the surfaces that animate, and the interface still works -- because
// "no animation" achieved by never showing the drawer would satisfy a naive
// assertion and fail the user.
//
// The preference is set with `page.emulateMedia`, not with `test.use({
// reducedMotion })`. The control below caught `test.use` not reaching the page
// in this project: `matchMedia('(prefers-reduced-motion: reduce)').matches` came
// back false while the spec believed it was measuring a reduced-motion session,
// and every duration assertion under it would have been measuring the ordinary
// page. Left as it found it, that is a green suite proving nothing.

test.use({ viewport: { width: NARROW.width, height: NARROW.height } });

/** The control every assertion in this file depends on. */
async function usePreference(page: Page, reduce: boolean) {
  await page.emulateMedia({ reducedMotion: reduce ? 'reduce' : 'no-preference' });
  const matches = await page.evaluate(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  expect(
    matches,
    reduce
      ? 'the reduced-motion preference never reached the page, so a collapsed duration would prove nothing'
      : 'the reduced-motion preference leaked into the control case',
  ).toBe(reduce);
}

/** Every finite duration a computed style lists, in seconds. */
function durations(value: string): number[] {
  return value
    .split(',')
    .map((part) => Number.parseFloat(part.trim()))
    .filter((parsed) => Number.isFinite(parsed));
}

test('the drawer still opens and closes with reduced motion, and animates for no perceptible time', async ({
  page,
}) => {
  await usePreference(page, true);
  await gotoLineage(page, '/tree/');
  await openFirstRelease(page);

  const release = page.locator('.tree-release-node button').first();
  await release.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  const motion = await dialog.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      animationName: style.animationName,
      animation: style.animationDuration,
      transition: style.transitionDuration,
    };
  });

  // The killswitch clamps durations rather than removing the animation, so the
  // name is still there. What must be true is that nothing takes perceptible
  // time. The block sets 0.01ms; 20ms is a generous ceiling that still fails
  // the drawer's real 160ms rise.
  for (const duration of durations(motion.animation)) {
    expect(duration, `animation-duration ${duration}s under reduced motion`).toBeLessThanOrEqual(
      0.02,
    );
  }
  for (const duration of durations(motion.transition)) {
    expect(duration, `transition-duration ${duration}s under reduced motion`).toBeLessThanOrEqual(
      0.02,
    );
  }

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('no lineage element animates for a perceptible time under reduced motion', async ({ page }) => {
  await usePreference(page, true);
  await gotoLineage(page, '/tree/');
  await openFirstRelease(page);
  await page.locator('.tree-release-node button').first().click();
  await page.locator('.tree-details').waitFor({ state: 'visible' });

  const moving = await page.evaluate(() => {
    const longest = (value: string) =>
      Math.max(
        0,
        ...value
          .split(',')
          .map((part) => Number.parseFloat(part.trim()))
          .filter((parsed) => Number.isFinite(parsed)),
      );

    return Array.from(document.body.querySelectorAll('*'))
      .map((el) => {
        const style = getComputedStyle(el);
        return {
          selector: `${el.tagName.toLowerCase()}.${String(el.className)}`.slice(0, 80),
          animation: longest(style.animationDuration),
          transition: longest(style.transitionDuration),
        };
      })
      .filter((entry) => entry.animation > 0.02 || entry.transition > 0.02);
  });

  expect(moving, 'elements still animating with prefers-reduced-motion: reduce').toEqual([]);
});

// The non-vacuity half. If emulation silently stopped working -- or if this
// suite were pointed at a page with no motion on it -- the assertions above
// would pass for the wrong reason. Without the preference the drawer's rise
// must be measurable, which proves both that there is an animation to suppress
// and that the preference is what suppresses it.
test('the drawer does animate without the preference, so the result above is not vacuous', async ({
  page,
}) => {
  await usePreference(page, false);
  await gotoLineage(page, '/tree/');
  await openFirstRelease(page);
  await page.locator('.tree-release-node button').first().click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  const duration = await dialog.evaluate((el) =>
    Number.parseFloat(getComputedStyle(el).animationDuration),
  );
  expect(duration, 'the drawer has no animation to suppress').toBeGreaterThan(0.05);
});
