import { expect, test, type Page } from '@playwright/test';
import { STATIC_CORE_ROUTES, allCoreRoutes, gotoCore, type CoreRoute } from './site-helpers';

// Issue #32 requires explicit 200% and 400% zoom evidence. #31's QA gate flagged
// that zoom had no dedicated assertion anywhere in the repo -- only the indirect
// 320-CSS-px lineage reflow test, which is the 1.4.10 400%-at-1280px equivalent
// for two routes. This makes the equivalence explicit and applies it site-wide.
//
// WCAG 2.2 SC 1.4.10 (Reflow): at 400% zoom on a 1280px-wide viewport, content
// must reflow into a single column with no loss of information or functionality
// and no two-dimensional scroll. Zooming to N% is equivalent to narrowing the
// CSS viewport to 1280/(N/100): 200% -> 640 CSS px, 400% -> 320 CSS px. Data
// tables and other content that is exempt "for usage" may scroll horizontally
// inside their own region; the exemption is why the check excludes any offender
// living under an `overflow-x: auto|scroll` ancestor rather than banning
// horizontal extent outright.

interface Offender {
  readonly selector: string;
  readonly right: number;
}

interface ReflowReport {
  readonly clientWidth: number;
  readonly scrollWidth: number;
  readonly offenders: Offender[];
}

/**
 * Elements whose right edge sits past the viewport AND that are not inside a
 * scrollable-x region, plus the document's own scroll width.
 *
 * The scrollable-ancestor exclusion is the reflow exemption made literal: a wide
 * data table inside `.passport-table-scroll` or the tree inside `.tree-scroll`
 * extends past the viewport by design and the user pans it within its box, so it
 * is not a document-level horizontal scroll. Anything overflowing *without* such
 * an ancestor is a genuine reflow failure.
 */
async function reflowReport(page: Page): Promise<ReflowReport> {
  return page.evaluate(() => {
    const clientWidth = document.documentElement.clientWidth;

    const hasScrollableXAncestor = (start: Element): boolean => {
      let node: Element | null = start;
      while (node !== null && node !== document.body) {
        const overflowX = getComputedStyle(node).overflowX;
        if (overflowX === 'auto' || overflowX === 'scroll') return true;
        node = node.parentElement;
      }
      return false;
    };

    const describe = (el: Element): string => {
      const id = el.id ? `#${el.id}` : '';
      const cls =
        typeof el.className === 'string' && el.className.trim().length > 0
          ? `.${el.className.trim().split(/\s+/).join('.')}`
          : '';
      return `${el.tagName.toLowerCase()}${id}${cls}`;
    };

    const offenders: { selector: string; right: number }[] = [];
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (box.width <= 1 && box.height <= 1) continue;
      // One pixel of slack for sub-pixel rounding, matching the lineage reflow
      // detector. A 320.4px edge on a 320px viewport is not a scrollbar.
      if (box.right > clientWidth + 1 && !hasScrollableXAncestor(el)) {
        offenders.push({ selector: describe(el), right: Math.round(box.right) });
      }
    }

    return { clientWidth, scrollWidth: document.documentElement.scrollWidth, offenders };
  });
}

const BASE = 1280;
const BANDS = [
  { zoom: '200%', width: BASE / 2 }, // 640 CSS px
  { zoom: '400%', width: BASE / 4 }, // 320 CSS px
] as const;

async function assertRouteReflows(page: Page, route: CoreRoute, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await gotoCore(page, route);
  const report = await reflowReport(page);

  expect(
    report.offenders,
    `${route.name} (${route.path}) overflows the ${width}px viewport outside any scroll ` +
      `region: ${JSON.stringify(report.offenders)}`,
  ).toEqual([]);
  expect(
    report.scrollWidth,
    `${route.name} (${route.path}) has a document-level horizontal scrollbar ` +
      `(scrollWidth ${report.scrollWidth} > clientWidth ${report.clientWidth})`,
  ).toBeLessThanOrEqual(report.clientWidth + 1);
}

for (const band of BANDS) {
  test(`every core route reflows at ${band.zoom} (${band.width} CSS px)`, async ({ page }) => {
    const routes = await allCoreRoutes(page);
    // allCoreRoutes resolves the two `[slug]` detail pages by following the first
    // link off their index; if that ever silently returned nothing the loop would
    // still exercise the nine static routes, so guard the count.
    expect(routes.length, 'detail routes did not resolve').toBeGreaterThanOrEqual(
      STATIC_CORE_ROUTES.length + 1,
    );
    for (const route of routes) {
      await assertRouteReflows(page, route, band.width);
    }
  });
}

// The control: prove the detector actually detects. A fixed-width element far
// past the viewport, with no scrollable ancestor, must register as an offender --
// otherwise every green above would be vacuous.
test('the reflow detector catches a real overflow', async ({ page }) => {
  await page.setViewportSize({ width: BANDS[1].width, height: 900 });
  await gotoCore(page, STATIC_CORE_ROUTES[0]);

  const clean = await reflowReport(page);
  expect(clean.offenders, 'the homepage was not clean before planting the defect').toEqual([]);

  await page.evaluate(() => {
    const bar = document.createElement('div');
    bar.id = 'reflow-canary';
    bar.style.width = '3000px';
    bar.style.height = '8px';
    bar.style.background = 'red';
    document.body.appendChild(bar);
  });

  const planted = await reflowReport(page);
  expect(
    planted.offenders.some((o) => o.selector.includes('reflow-canary')),
    'the detector missed a 3000px-wide element',
  ).toBe(true);

  await page.evaluate(() => document.getElementById('reflow-canary')?.remove());
});
