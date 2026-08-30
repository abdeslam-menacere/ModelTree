import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';

/**
 * The brand mark has to survive being drawn at favicon scale, and that is a
 * rendering claim: whether a 6-unit stroke on a 64-unit canvas still resolves to
 * visible ink at 16 CSS px is decided by a rasteriser, not by the markup. jsdom
 * cannot answer it, so geometry assertions in `src/components/brand-mark.test.ts`
 * are paired with this: a real engine, the asset as the server actually sends it,
 * measured at the sizes browsers actually use.
 *
 * This spec is part of `web-e2e`, which is a required status check on `main`, so
 * a flaky assertion here blocks every merge in the repository and not only the
 * one that introduced it. The band below is therefore set from measurement with
 * a stated margin rather than guessed. See `inkBand`.
 */

/**
 * Measured coverage of the drawn mark, as a fraction of the icon's area.
 *
 * Taken on the committed `favicon.svg` in Chromium: 0.3281 at 16px, 0.2793 at
 * 32px, 0.2559 at 64px. Coverage falls as size rises because antialiasing
 * spreads a thin stroke over proportionally more area when there is less of it.
 *
 * The band is [0.10, 0.65]. Against the measured extremes that is 2.8x of room
 * below (0.2793 / 0.10) and 2.0x above (0.65 / 0.3281) -- margins in the same
 * range as the 2.1x this suite already relies on elsewhere. It stays narrow
 * enough to discriminate: a mark that failed to draw measures 0, and one that
 * collapsed into a filled shape measures above 0.9. Both controls are asserted
 * below, because a band that cannot fail proves nothing about the one that passes.
 */
const inkBand = { min: 0.1, max: 0.65 };

/** The plate colour the mark is drawn on, as committed in `favicon.svg`. */
const PLATE: [number, number, number] = [0x0e, 0x14, 0x17];

/**
 * Fraction of an icon's area covered by drawing that is not the background plate.
 *
 * Counting opaque pixels would not work: the plate fills the canvas, so every
 * icon measures ~0.97 whether or not anything was drawn on it. Measured on the
 * committed asset, opaque-pixel coverage is 0.9844 at 16px for a mark and would
 * be 0.9844 for an empty plate too. So ink is distance from the plate colour.
 */
async function inkCoverage(page: Page, svg: string, size: number): Promise<number> {
  return page.evaluate(
    async ({ svg, size, plate }) => {
      const img = new Image();
      img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;

      // A standalone `.svg` is parsed as XML, which is strict: an unescaped `&`
      // or a `--` inside a comment makes the whole file undecodable and the icon
      // renders as nothing. `decode()` rejects in that case, and letting it
      // reject here is deliberate -- it is a real way to ship a blank favicon.
      await img.decode();

      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(img, 0, 0, size, size);

      const { data } = ctx.getImageData(0, 0, size, size);
      let ink = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] <= 16) continue;
        const distance =
          Math.abs(data[i] - plate[0]) +
          Math.abs(data[i + 1] - plate[1]) +
          Math.abs(data[i + 2] - plate[2]);
        if (distance > 48) ink += 1;
      }
      return ink / (size * size);
    },
    { svg, size, plate: PLATE },
  );
}

test.describe('the brand mark renders at favicon scale', () => {
  test('the served favicon draws visible ink at 16px and 32px', async ({ page, request }) => {
    const response = await request.get('/favicon.svg');
    expect(response.status(), 'the favicon must be served, not merely committed').toBe(200);

    const svg = await response.text();
    await page.goto('/');

    for (const size of [16, 32]) {
      const coverage = await inkCoverage(page, svg, size);

      expect(
        coverage,
        `the mark drew too little at ${size}px (${coverage.toFixed(4)}), so it reads as blank`,
      ).toBeGreaterThan(inkBand.min);
      expect(
        coverage,
        `the mark drew too much at ${size}px (${coverage.toFixed(4)}), so it reads as a solid block`,
      ).toBeLessThan(inkBand.max);
    }
  });

  test('the mask icon draws visible ink at 16px', async ({ page, request }) => {
    // Safari's pinned-tab icon is re-coloured by the browser, so only its
    // silhouette matters. It is measured against a white ground rather than the
    // plate, which is why it gets its own floor rather than reusing the band.
    const response = await request.get('/mask-icon.svg');
    expect(response.status()).toBe(200);

    const svg = await response.text();
    await page.goto('/');

    const coverage = await page.evaluate(async (svg) => {
      const img = new Image();
      img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
      await img.decode();

      const canvas = document.createElement('canvas');
      canvas.width = 16;
      canvas.height = 16;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.clearRect(0, 0, 16, 16);
      ctx.drawImage(img, 0, 0, 16, 16);

      const { data } = ctx.getImageData(0, 0, 16, 16);
      let ink = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > 16) ink += 1;
      }
      return ink / (16 * 16);
    }, svg);

    expect(coverage, 'the mask icon reads as blank at 16px').toBeGreaterThan(inkBand.min);
    expect(coverage, 'the mask icon reads as a solid block at 16px').toBeLessThan(inkBand.max);
  });

  test('the document points at both icons', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/favicon.svg');
    await expect(page.locator('link[rel="mask-icon"]')).toHaveAttribute('href', '/mask-icon.svg');
  });

  test('the in-page mark inherits the theme rather than pinning one palette', async ({ page }) => {
    await page.goto('/');

    const mark = page.locator('.brand-mark');
    await expect(mark).toBeVisible();

    const box = await mark.boundingBox();
    expect(box, 'the mark should occupy real layout space').not.toBeNull();
    expect(box!.width).toBeGreaterThan(16);
    expect(box!.height).toBeGreaterThan(16);

    const strokeOf = () =>
      mark.locator('path').first().evaluate((node) => getComputedStyle(node).stroke);

    const light = await strokeOf();

    await page.emulateMedia({ colorScheme: 'dark' });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    const dark = await strokeOf();

    // The whole reason the mark is inlined rather than loaded through `<img>`:
    // an `<img>` is a separate document and cannot see `html[data-theme]`, so
    // this pair would be identical and the header mark would stay pinned to one
    // palette while the page around it changed.
    expect(light).not.toBe(dark);
    expect(light).toMatch(/^rgb/);
    expect(dark).toMatch(/^rgb/);
  });
});

test.describe('the ink probe can fail', () => {
  // Controls. The band above only means something if the measurement it reads
  // actually discriminates, and both failure modes it names are reproduced here
  // rather than assumed.

  test('an empty plate measures below the floor', async ({ page }) => {
    await page.goto('/');

    const blank =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
      '<rect width="64" height="64" rx="14" fill="#0e1417" /></svg>';

    expect(await inkCoverage(page, blank, 16)).toBeLessThan(inkBand.min);
  });

  test('a filled block measures above the ceiling', async ({ page }) => {
    await page.goto('/');

    const solid =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
      '<rect width="64" height="64" fill="#3fd0e6" /></svg>';

    expect(await inkCoverage(page, solid, 16)).toBeGreaterThan(inkBand.max);
  });

  test('every standalone copy of the mark decodes as XML', async ({ page }) => {
    // A standalone `.svg` is parsed as XML, which is strict, and a file that
    // breaks that rule renders as nothing while looking entirely correct in an
    // editor. The favicon shipped exactly that defect during this issue.
    //
    // The docs logo is read from disk rather than fetched, because it lives
    // under `docs/` and the site never serves it -- but it is the copy GitHub
    // renders, so it has the same obligation.
    await page.goto('/');

    const assets: Array<[string, string]> = [
      ['favicon.svg', readFileSync(fileURLToPath(new URL('../public/favicon.svg', import.meta.url)), 'utf8')],
      ['mask-icon.svg', readFileSync(fileURLToPath(new URL('../public/mask-icon.svg', import.meta.url)), 'utf8')],
      ['modeltree-logo.svg', readFileSync(fileURLToPath(new URL('../../docs/assets/modeltree-logo.svg', import.meta.url)), 'utf8')],
    ];

    for (const [name, svg] of assets) {
      const error = await page.evaluate((source) => {
        const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
        return parsed.querySelector('parsererror')?.textContent ?? null;
      }, svg);

      expect(error, `${name} is not well-formed XML, so a browser renders nothing`).toBeNull();
    }
  });

  test('the ink probe rejects an SVG that is not well-formed XML', async ({ page }) => {
    await page.goto('/');

    // The control for the check above, replaying the exact defect that occurred:
    // a double hyphen is illegal inside an XML comment.
    const malformed =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
      '<!-- refined in issue #31 -- the stroke grew -->' +
      '<rect width="64" height="64" fill="#3fd0e6" /></svg>';

    const error = await page.evaluate((source) => {
      const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
      return parsed.querySelector('parsererror')?.textContent ?? null;
    }, malformed);

    expect(error, 'the parser accepted illegal XML, so the check above proves nothing').not.toBeNull();
    await expect(inkCoverage(page, malformed, 16)).rejects.toThrow();
  });
});
