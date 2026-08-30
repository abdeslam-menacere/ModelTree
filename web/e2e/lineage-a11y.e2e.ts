import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { DESKTOP, LINEAGE_PAGES, NARROW, gotoLineage, openFirstRelease, settle } from './lineage-helpers';

// Issue #14, acceptance criterion 6: "automated checks report no serious
// accessibility violations on the lineage view."
//
// The criterion names a severity, so the assertion does too: `serious` and
// `critical` fail. Lower impacts are printed alongside any failure but do not
// fail a run on their own -- axe's moderate findings include judgement calls
// (heading order across a page assembled from independent components, for one)
// that a machine cannot settle and that this issue does not claim to settle.

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const BLOCKING = new Set(['serious', 'critical']);

/**
 * Rules already failing on this repository's shared chrome before this branch
 * existed, and which this branch does not fix.
 *
 * There is exactly one, and it is measured rather than assumed:
 * `--cp-link: #0078d4` on the `#f7f4ef` page surface is 4.12:1 where AA needs
 * 4.5:1. It renders on the homepage's release-pulse links and on the "data
 * refresh" link `BaseLayout.astro` puts on every page, so correcting it is a
 * change to a site-wide colour token rather than to the lineage view -- filed
 * as a follow-up instead of smuggled into this branch.
 *
 * This list is a floor, not an amnesty. The full-page assertion below still
 * fails on any other rule, and on this rule the moment it fires inside a
 * lineage root, so the recorded set cannot quietly grow.
 */
const KNOWN_SITE_WIDE = new Set(['color-contrast']);

interface Finding {
  id: string;
  impact: string;
  help: string;
  /** axe's own explanation, which for contrast carries the measured ratio. */
  why: string[];
  nodes: string[];
}

interface AxeNode {
  target: unknown[];
  any?: { message?: string }[];
  all?: { message?: string }[];
}

function summarise(
  violations: { id: string; impact?: string | null; help: string; nodes: AxeNode[] }[],
): Finding[] {
  return violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact ?? 'unknown',
    help: violation.help,
    // Without this a contrast failure reports a selector and no numbers, which
    // is the failure message this repository keeps deciding it does not want.
    why: [
      ...new Set(
        violation.nodes.flatMap((node) =>
          [...(node.any ?? []), ...(node.all ?? [])]
            .map((check) => check.message ?? '')
            .filter((message) => message.length > 0),
        ),
      ),
    ],
    nodes: violation.nodes.map((node) => node.target.map(String).join(' ')),
  }));
}

const VIEWPORTS = [
  { label: 'desktop', size: DESKTOP },
  { label: 'mobile', size: NARROW },
] as const;

// --- The criterion, scoped to the lineage view ------------------------------

for (const { label, size } of VIEWPORTS) {
  for (const { path, name, root } of LINEAGE_PAGES) {
    test(`${name} has no serious accessibility violations at ${label} width`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await gotoLineage(page, path);

      const results = await new AxeBuilder({ page }).include(root).withTags(TAGS).analyze();
      const findings = summarise(results.violations);
      const blocking = findings.filter((finding) => BLOCKING.has(finding.impact));

      expect(
        blocking,
        `serious or critical violations in ${root} on ${path} at ${label}; all findings:\n` +
          `${JSON.stringify(findings, null, 2)}`,
      ).toEqual([]);
    });
  }
}

for (const { label, size } of VIEWPORTS) {
  test(`the tree explorer has no serious violations with the drawer open at ${label} width`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await gotoLineage(page, '/tree/');
    await openFirstRelease(page);
    await page.locator('.tree-release-node button').first().click();
    await page.locator('.tree-details').waitFor({ state: 'visible' });
    await settle(page);

    const results = await new AxeBuilder({ page })
      .include('.model-tree-explorer')
      .withTags(TAGS)
      .analyze();
    const findings = summarise(results.violations);
    const blocking = findings.filter((finding) => BLOCKING.has(finding.impact));

    expect(
      blocking,
      `serious or critical violations with the drawer open at ${label}; all findings:\n` +
        `${JSON.stringify(findings, null, 2)}`,
    ).toEqual([]);
  });
}

// --- The whole page, so nothing new can hide outside the scope ---------------

for (const { label, size } of VIEWPORTS) {
  for (const { path, name, root } of LINEAGE_PAGES) {
    test(`${name} introduces no new page-level violations at ${label} width`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await gotoLineage(page, path);

      const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      const blocking = summarise(results.violations).filter((finding) =>
        BLOCKING.has(finding.impact),
      );

      const unexpected = blocking.filter((finding) => !KNOWN_SITE_WIDE.has(finding.id));
      expect(
        unexpected,
        `serious or critical violations on ${path} at ${label} beyond the recorded site-wide set`,
      ).toEqual([]);

      // The recorded rule is tolerated outside the lineage view and nowhere
      // else. Resolving each reported selector back to its element is what
      // makes that a check rather than a promise.
      const insideLineage = await page.evaluate(
        ({ selectors, container }) => {
          const scope = document.querySelector(container);
          if (scope === null) return selectors;
          return selectors.filter((selector) => {
            try {
              const el = document.querySelector(selector);
              return el !== null && scope.contains(el);
            } catch {
              return false;
            }
          });
        },
        { selectors: blocking.flatMap((finding) => finding.nodes), container: root },
      );
      expect(
        insideLineage,
        `a tolerated site-wide violation is rendering inside ${root} on ${path}`,
      ).toEqual([]);
    });
  }
}

// --- Controls ---------------------------------------------------------------

// A scan that finds nothing because it looked at nothing reports exactly what a
// clean page reports. So: axe must have run a healthy number of checks, and it
// must have inspected the tree's own nodes by name.
test('the accessibility scan actually inspected the lineage markup', async ({ page }) => {
  await page.setViewportSize({ width: DESKTOP.width, height: DESKTOP.height });
  await gotoLineage(page, '/tree/');
  await openFirstRelease(page);

  const results = await new AxeBuilder({ page })
    .include('.model-tree-explorer')
    .withTags(TAGS)
    .analyze();

  expect(results.passes.length, 'axe reported no passing checks at all').toBeGreaterThan(5);

  const inspected = new Set(
    [...results.passes, ...results.violations, ...results.incomplete]
      .flatMap((result) => result.nodes)
      .flatMap((node) => node.target.map(String)),
  );
  const sawTree = [...inspected].some((target) => target.includes('tree-'));
  expect(
    sawTree,
    `axe never saw a tree node; it inspected:\n${[...inspected].slice(0, 40).join('\n')}`,
  ).toBe(true);
});

// The second control: axe must be capable of failing this suite from inside the
// scoped root. A deliberately unlabelled input is a violation axe rates
// `critical`, so if this scan comes back clean the tag set, the severity filter
// or the scan's scope is broken.
test('the accessibility scan can fail, and rates a planted defect as blocking', async ({ page }) => {
  await page.setViewportSize({ width: DESKTOP.width, height: DESKTOP.height });
  await gotoLineage(page, '/tree/');

  await page.evaluate(() => {
    const planted = document.createElement('input');
    planted.id = 'axe-canary';
    planted.type = 'text';
    document.querySelector('.model-tree-explorer')?.append(planted);
  });

  const results = await new AxeBuilder({ page })
    .include('.model-tree-explorer')
    .withTags(TAGS)
    .analyze();
  const blocking = summarise(results.violations).filter((finding) => BLOCKING.has(finding.impact));

  expect(
    blocking.flatMap((finding) => finding.nodes).join(' '),
    'axe did not report a planted unlabelled input, so it cannot report a real one',
  ).toContain('axe-canary');
});
