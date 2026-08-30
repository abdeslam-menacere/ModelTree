import { expect, test } from '@playwright/test';
import {
  FABRICATED_PATH,
  LINEAGE_PAGES,
  NARROW,
  findOverflow,
  gotoLineage,
  openFirstRelease,
  settle,
} from './lineage-helpers';

// Issue #14, acceptance criterion 1: "the lineage view and the model drawer are
// usable at 320 CSS px wide without horizontal scrolling or clipped text."
//
// This is the empirical half. `src/styles/global.test.ts` and
// `src/styles/tree-narrow-viewport.test.ts` assert the cascade resolves the way
// it has to; this asserts the engine lays the page out inside 320px, which is
// what the criterion actually claims and what a stylesheet reader cannot check.

test.use({ viewport: { width: NARROW.width, height: NARROW.height } });

// --- Controls ---------------------------------------------------------------
//
// Every assertion below is a probe, and a probe that cannot fail is not
// evidence. These three prove the instrument works before it is believed.

test('the suite is pointed at the real site, and can tell when it is not', async ({ page }) => {
  // The base the server actually used, read off a served URL rather than off
  // the config. `astro.config.mjs` is `base: env.BASE_PATH ?? '/'`, so this is
  // the one place the answer is a fact.
  const response = await gotoLineage(page, '/');
  const served = new URL(response.url());
  expect(served.pathname, 'the homepage is not served at the site root').toBe('/');

  const missing = await page.goto(FABRICATED_PATH);
  const fingerprintOnFabricatedRoute = await page
    .locator('body')
    .textContent()
    .then((text) => (text ?? '').includes(LINEAGE_PAGES[0].fingerprint));

  // A 404 under Astro's static preview may answer 404 or fall through to a
  // custom page; what must never be true is that it looks like the real page.
  // If it did, every geometry and axe assertion in this directory would be
  // measuring an error document and reporting success.
  expect(
    fingerprintOnFabricatedRoute,
    `${FABRICATED_PATH} satisfies the homepage fingerprint, so the fingerprint proves nothing`,
  ).toBe(false);
  expect(missing?.status(), `status for ${FABRICATED_PATH}`).not.toBe(200);
});

test('the overflow detector actually detects overflow', async ({ page }) => {
  await gotoLineage(page, '/tree/');

  const clean = await findOverflow(page);
  expect(clean.offenders, 'the page must start clean for this control to mean anything').toEqual([]);

  // A 400px box in a 320px viewport is unambiguous overflow. If the detector
  // stays silent here it is silent for every real overflow too.
  await page.evaluate(() => {
    const canary = document.createElement('div');
    canary.id = 'overflow-canary';
    canary.style.cssText = 'width:400px;height:40px;background:#f00';
    document.body.append(canary);
  });

  const dirty = await findOverflow(page);
  expect(
    dirty.offenders.map((offender) => offender.selector),
    'the injected 400px element was not reported',
  ).toContain('div#overflow-canary');
  expect(dirty.scrollWidth).toBeGreaterThan(dirty.clientWidth);

  await page.evaluate(() => document.getElementById('overflow-canary')?.remove());

  const restored = await findOverflow(page);
  expect(restored.offenders, 'the detector kept reporting after the canary was removed').toEqual([]);
  expect(restored.scrollWidth).toBeLessThanOrEqual(restored.clientWidth);
});

test('the ruler is the content box, and the scrollbar gutter is recorded', async ({ page }) => {
  await gotoLineage(page, '/tree/');
  const { clientWidth, innerWidth } = await findOverflow(page);

  // `innerWidth` includes the scrollbar gutter and `clientWidth` does not, so
  // measuring against the wrong one moves every threshold by the gutter's
  // width. This records the difference instead of assuming it away; headless
  // Chromium overlays its scrollbar, so it is 0 here and the assertions above
  // are unaffected either way.
  expect(innerWidth - clientWidth).toBeGreaterThanOrEqual(0);
  expect(clientWidth).toBe(NARROW.width);
});

// --- The criterion ----------------------------------------------------------

for (const { path, name } of LINEAGE_PAGES) {
  test(`${name} fits 320 CSS px with nothing past the right edge`, async ({ page }) => {
    await gotoLineage(page, path);

    const { scrollWidth, clientWidth, offenders } = await findOverflow(page);

    expect(offenders, `elements past the right edge on ${path}`).toEqual([]);
    expect(scrollWidth, `document scroll width on ${path}`).toBeLessThanOrEqual(clientWidth);
  });
}

// The header is called out separately because it is the part of AC-1 that
// changed under this issue's feet. It was eleven flat links when #14 was
// written, and has been five items -- two of them native disclosures -- since
// #523. This measures the header as it is now rather than fixing a row that no
// longer exists, and it is what turns "the overflow looks resolved" into a fact.
test('the primary navigation wraps inside 320 CSS px instead of overflowing', async ({ page }) => {
  await gotoLineage(page, '/');

  const nav = page.locator('.primary-nav').first();
  await expect(nav).toBeVisible();

  const measurement = await nav.evaluate((el) => {
    const clientWidth = document.documentElement.clientWidth;
    const box = el.getBoundingClientRect();
    const items = Array.from(el.querySelectorAll(':scope .nav-row > *')).map((item) => {
      const rect = item.getBoundingClientRect();
      return {
        text: (item.textContent ?? '').trim().slice(0, 24),
        right: rect.right,
        top: rect.top,
      };
    });
    return { clientWidth, right: box.right, width: box.width, scrollWidth: el.scrollWidth, items };
  });

  expect(measurement.items.length, 'the grouped nav rendered no top-level items').toBeGreaterThan(0);
  expect(measurement.right).toBeLessThanOrEqual(measurement.clientWidth + 1);
  expect(measurement.scrollWidth).toBeLessThanOrEqual(Math.ceil(measurement.width) + 1);
  for (const item of measurement.items) {
    expect(item.right, `nav item "${item.text}" past the viewport`).toBeLessThanOrEqual(
      measurement.clientWidth + 1,
    );
  }
});

test('the tree explorer still fits 320 CSS px with a family expanded', async ({ page }) => {
  await gotoLineage(page, '/tree/');
  await openFirstRelease(page);

  const { scrollWidth, clientWidth, offenders } = await findOverflow(page);

  expect(offenders, 'elements past the right edge with releases showing').toEqual([]);
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
});

test('the release drawer fits 320 CSS px and clips no text', async ({ page }) => {
  await gotoLineage(page, '/tree/');
  await openFirstRelease(page);
  await page.locator('.tree-release-node button').first().click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await settle(page);

  const { scrollWidth, clientWidth, offenders } = await findOverflow(page);
  expect(offenders, 'elements past the right edge with the drawer open').toEqual([]);
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

  // Clipped text is a different failure from overflow: a box can sit inside the
  // viewport and still cut its own content off. `scrollWidth > clientWidth` on
  // the element itself is the engine saying exactly that. `.visually-hidden` is
  // excluded by name -- it is deliberately a 1px clipped box, which is the
  // shape this check looks for and the one case where it is intended.
  const clipped = await dialog.evaluate((el) =>
    Array.from(el.querySelectorAll('*'))
      .filter((child) => !child.classList.contains('visually-hidden'))
      .filter((child) => child.scrollWidth > child.clientWidth + 1)
      .map((child) => `${child.tagName.toLowerCase()}.${String(child.className)}`),
  );
  expect(clipped, 'elements clipping their own content inside the drawer').toEqual([]);
});
