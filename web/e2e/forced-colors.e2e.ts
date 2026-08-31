import { expect, test, type Page } from '@playwright/test';
import { DESKTOP, gotoLineage, openFirstRelease } from './lineage-helpers';

// Issue #32: rendered proof for forced-colors mode. `visual-system.test.ts`
// asserts the `@media (forced-colors: active)` block's selectors and keywords at
// SOURCE level; it cannot see what the engine paints. This is the half that can.
//
// The lesson this exists to lock down: #31 found -- by screenshot, not by
// reasoning -- that forced-colors erased the lineage branch connectors. They are
// hairlines painted as a pseudo-element `background`, and a forced palette
// rewrites `background-color` to `Canvas`, so every connector vanished while the
// nodes stayed visible: the tree silently rendered as a flat list, and no test in
// the repository could see it. The fix restores them with `background: CanvasText`.
// This spec renders that state in a real engine and measures it.

/** The control every assertion here depends on: the preference reached the page. */
async function useForcedColors(page: Page, active: boolean) {
  await page.emulateMedia({ forcedColors: active ? 'active' : 'none' });
  const matches = await page.evaluate(
    () => window.matchMedia('(forced-colors: active)').matches,
  );
  expect(
    matches,
    active
      ? 'forced-colors never reached the page, so a painted connector would prove nothing'
      : 'forced-colors leaked into the control case',
  ).toBe(active);
}

/** The `::before` background of a selector, with system colours resolved by probe. */
async function connectorPaint(page: Page, selector: string) {
  return page.evaluate((sel) => {
    // `Canvas`/`CanvasText` only resolve to concrete rgb under the active palette,
    // and only on a real element -- reading them off `document.documentElement`
    // returns its own (often transparent) background, not the system colour. Probe
    // them directly so the comparison means what it claims.
    const probe = document.createElement('span');
    probe.style.backgroundColor = 'Canvas';
    document.body.appendChild(probe);
    const canvas = getComputedStyle(probe).backgroundColor;
    probe.style.backgroundColor = 'CanvasText';
    const canvasText = getComputedStyle(probe).backgroundColor;
    probe.remove();

    const el = document.querySelector(sel);
    const before = el ? getComputedStyle(el, '::before').backgroundColor : null;
    return { present: el !== null, before, canvas, canvasText };
  }, selector);
}

const TRANSPARENT = new Set(['rgba(0, 0, 0, 0)', 'transparent']);

test.use({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });

test('the tree branch connectors still paint when the palette is forced', async ({ page }) => {
  await useForcedColors(page, true);
  await gotoLineage(page, '/tree/');
  await openFirstRelease(page);

  // `.tree-release-list::before` is the vertical spine that joins a family's
  // releases; its ancestor `li::before` are the horizontal stubs. Both are in
  // the restored set. Reading the spine is enough to catch the regression: if it
  // were rewritten to `Canvas` it would equal the page background exactly.
  const spine = await connectorPaint(page, '.tree-release-list');
  expect(spine.present, 'no .tree-release-list to measure; did the family expand?').toBe(true);
  expect(spine.before, 'the connector has no rendered ::before background').not.toBeNull();
  expect(
    TRANSPARENT.has(spine.before ?? ''),
    `the connector ::before is transparent under forced colors (${spine.before})`,
  ).toBe(false);
  expect(
    spine.before,
    `the connector ::before (${spine.before}) matches the page Canvas (${spine.canvas}) -- ` +
      'it was rewritten to the background and has vanished, the exact #31 regression',
  ).not.toBe(spine.canvas);
});

test('the timeline spine still paints when the palette is forced', async ({ page }) => {
  await useForcedColors(page, true);
  const response = await page.goto('/timeline/');
  expect(response?.status(), 'HTTP status for /timeline/').toBe(200);
  await expect(page.locator('body')).toContainText('Follow the release timeline.');
  await expect(page.locator('.timeline-entry').first()).toBeVisible();

  const spine = await connectorPaint(page, '.timeline-entry');
  expect(spine.present, 'no .timeline-entry to measure').toBe(true);
  expect(
    TRANSPARENT.has(spine.before ?? ''),
    `the timeline spine ::before is transparent under forced colors (${spine.before})`,
  ).toBe(false);
  expect(
    spine.before,
    `the timeline spine ::before (${spine.before}) matches the page Canvas (${spine.canvas})`,
  ).not.toBe(spine.canvas);
});

test('a keyboard focus ring survives forced colors', async ({ page }) => {
  await useForcedColors(page, true);
  await gotoLineage(page, '/tree/');

  const region = page.getByRole('region', { name: 'Reviewed model ecosystem hierarchy' });
  await region.focus();
  const ring = await page.evaluate(() => {
    const el = document.activeElement;
    if (el === null) return null;
    const style = getComputedStyle(el);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  // Nothing in the stylesheet sets `outline: none`, so the ring survives the
  // mode by construction. This measures that it actually does.
  expect(ring?.outlineStyle, 'focus ring suppressed under forced colors').not.toBe('none');
  expect(Number.parseFloat(ring?.outlineWidth ?? '0')).toBeGreaterThan(0);
});

// The non-vacuity half. If emulation silently stopped working, every assertion
// above would still pass -- the connectors are painted from a token in the
// ordinary case too. Without the preference, `matchMedia` must report no forced
// colours; the control in `useForcedColors` asserts the positive direction, and
// this asserts the negative, so a broken emulation cannot pass both.
test('forced colors is genuinely off in the control case', async ({ page }) => {
  await useForcedColors(page, false);
  await gotoLineage(page, '/tree/');
  await openFirstRelease(page);

  const spine = await connectorPaint(page, '.tree-release-list');
  expect(spine.present).toBe(true);
  // Ordinary rendering also paints the connector, from `--cp-border-strong`.
  expect(TRANSPARENT.has(spine.before ?? '')).toBe(false);
});
