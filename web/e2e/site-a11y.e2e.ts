import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { DESKTOP, NARROW } from './lineage-helpers';
import {
  STATIC_CORE_ROUTES,
  gotoCore,
  resolveDetailRoutes,
} from './site-helpers';

// Issue #32: an independent, end-to-end WCAG 2.2 AA audit. The component-level
// work (#14, #24, #26, #31) each proved one surface; this proves the whole set
// of core journeys together, so a violation introduced at the seams between
// components -- or on a route no earlier issue owned -- cannot pass unseen.
//
// The severity contract matches the rest of the suite and the issue's own
// wording ("no serious or critical automated violations"): `serious` and
// `critical` fail; lower impacts are printed with any failure but do not fail a
// run, because axe's moderate findings include judgement calls (page-level
// heading order across independently authored components, say) that this issue
// documents as residual risk rather than claims to have settled.
//
// There is deliberately no tolerated-findings list here. The Phase 0 discovery
// scan for this issue found exactly two blocking violations across every core
// route -- `aria-pressed` on two candidate links, at `/benchmarks` and
// `/compare` -- and both are fixed on this branch. So the expected blocking set
// is empty everywhere, and any amnesty would only be able to hide a regression.

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const BLOCKING = new Set(['serious', 'critical']);

interface Finding {
  id: string;
  impact: string;
  help: string;
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
    // Carries the measured ratio for contrast findings, so a failure names
    // numbers instead of just a selector.
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

async function blockingFindings(page: Page): Promise<Finding[]> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return summarise(results.violations).filter((finding) => BLOCKING.has(finding.impact));
}

const VIEWPORTS = [
  { label: 'desktop', size: DESKTOP },
  { label: 'mobile', size: NARROW },
] as const;

// --- Every static core route, at both widths --------------------------------

for (const { label, size } of VIEWPORTS) {
  for (const route of STATIC_CORE_ROUTES) {
    test(`${route.name} has no serious or critical violations at ${label} width`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await gotoCore(page, route);

      const blocking = await blockingFindings(page);
      expect(
        blocking,
        `serious or critical violations on ${route.path} at ${label}:\n` +
          `${JSON.stringify(blocking, null, 2)}`,
      ).toEqual([]);
    });
  }
}

// --- The two dataset-driven detail routes, resolved at runtime --------------

for (const { label, size } of VIEWPORTS) {
  test(`the model and provider detail pages have no serious violations at ${label} width`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    const detail = await resolveDetailRoutes(page);
    expect(detail.length, 'neither detail route resolved from its index').toBeGreaterThanOrEqual(2);

    for (const route of detail) {
      await gotoCore(page, route);
      const blocking = await blockingFindings(page);
      expect(
        blocking,
        `serious or critical violations on ${route.path} (${route.name}) at ${label}:\n` +
          `${JSON.stringify(blocking, null, 2)}`,
      ).toEqual([]);
    }
  });
}

// --- Controls ---------------------------------------------------------------

// A scan that inspected nothing reports what a clean page reports. This proves
// axe actually ran a healthy number of checks against real page markup.
test('the accessibility scan actually inspected the page', async ({ page }) => {
  await page.setViewportSize({ width: DESKTOP.width, height: DESKTOP.height });
  await gotoCore(page, STATIC_CORE_ROUTES[0]);

  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(results.passes.length, 'axe reported no passing checks at all').toBeGreaterThan(5);
});

// The severity filter, tag set and scope must be able to fail this suite. An
// unlabelled text input is a violation axe rates `critical`; if a scan carrying
// one comes back clean, the harness itself is broken.
test('the accessibility scan can fail, and rates a planted defect as blocking', async ({ page }) => {
  await page.setViewportSize({ width: DESKTOP.width, height: DESKTOP.height });
  await gotoCore(page, STATIC_CORE_ROUTES[0]);

  await page.evaluate(() => {
    const planted = document.createElement('input');
    planted.id = 'axe-canary';
    planted.type = 'text';
    document.body.append(planted);
  });

  const blocking = await blockingFindings(page);
  expect(
    blocking.flatMap((finding) => finding.nodes).join(' '),
    'axe did not report a planted unlabelled input, so it cannot report a real one',
  ).toContain('axe-canary');
});
