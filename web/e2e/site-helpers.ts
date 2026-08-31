import { expect, type Page, type Response } from '@playwright/test';
import { settle } from './lineage-helpers';

/**
 * The core journeys issue #32 audits, beyond the two lineage surfaces
 * `lineage-helpers.ts` already covers. Each carries a fingerprint that only the
 * real page satisfies, for the reason spelled out there: if `BASE_PATH` ever
 * reached this build the site would serve under `/ModelTree/`, every navigation
 * would 404, and a 404 page has no violations, no overflow and no forced-colours
 * regression -- the whole suite would pass while measuring an error document. So
 * no assertion runs until the page has proved it is the page.
 *
 * A `text` fingerprint is literal page copy (stable across dataset refreshes). A
 * `ready` fingerprint is a structural selector, used where the only unique text
 * on a page is dataset-derived (the two `[slug]` detail pages).
 */
export interface CoreRoute {
  readonly path: string;
  readonly name: string;
  readonly text?: string;
  readonly ready?: string;
}

/** Routes with a fixed URL. The two `[slug]` pages are resolved at runtime. */
export const STATIC_CORE_ROUTES: readonly CoreRoute[] = [
  { path: '/', name: 'homepage lineage', text: 'Recorded lineage, creator by creator' },
  { path: '/tree/', name: 'tree explorer', text: 'AI Model Ecosystem' },
  { path: '/models', name: 'model catalog', text: 'Search the model catalog.' },
  { path: '/providers', name: 'provider directory', text: 'Who builds the models' },
  { path: '/benchmarks', name: 'evidence', text: 'What was actually measured.' },
  { path: '/compare', name: 'compare', text: 'models.' },
  { path: '/timeline', name: 'timeline', text: 'Follow the release timeline.' },
  { path: '/updates', name: 'updates', text: 'Read the recorded release updates.' },
  { path: '/methodology', name: 'methodology', text: 'How ModelTree decides what to record.' },
] as const;

/** A route that does not exist, used to prove a fingerprint can fail. */
export const FABRICATED_PATH = '/definitely-not-a-page/';

async function firstHref(page: Page, prefix: string): Promise<string | null> {
  return page.evaluate((p) => {
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));
    const match = links.find((el) => {
      const href = el.getAttribute('href') ?? '';
      // A detail page, not the index itself: `/models/<slug>/`, never `/models`.
      return href.includes(p) && href.replace(/\/$/, '') !== p.replace(/\/$/, '');
    });
    return match ? match.getAttribute('href') : null;
  }, prefix);
}

/**
 * The two dataset-driven detail routes, resolved by following the first link off
 * their index rather than naming a slug -- so a dataset refresh cannot redden
 * this suite. `main.passport-page` / `main.provider-page` are the structural
 * fingerprints, since the only unique text on those pages is the record's name.
 */
export async function resolveDetailRoutes(page: Page): Promise<CoreRoute[]> {
  await page.goto('/models');
  const modelHref = await firstHref(page, '/models/');
  await page.goto('/providers');
  const providerHref = await firstHref(page, '/providers/');

  const resolved: CoreRoute[] = [];
  if (modelHref) {
    resolved.push({ path: modelHref, name: 'model passport', ready: 'main.passport-page' });
  }
  if (providerHref) {
    resolved.push({ path: providerHref, name: 'provider profile', ready: 'main.provider-page' });
  }
  return resolved;
}

/** All core routes, static plus the two resolved detail pages. */
export async function allCoreRoutes(page: Page): Promise<CoreRoute[]> {
  return [...STATIC_CORE_ROUTES, ...(await resolveDetailRoutes(page))];
}

/**
 * Navigate to a core route and refuse to continue unless it is the real one:
 * the server answered 200, and the page carries the fingerprint unique to it.
 */
export async function gotoCore(page: Page, route: CoreRoute): Promise<Response> {
  const response = await page.goto(route.path);
  expect(response, `no response for ${route.path}`).not.toBeNull();
  expect(response?.status(), `HTTP status for ${route.path}`).toBe(200);

  if (route.ready) {
    await expect(
      page.locator(route.ready),
      `${route.path} is missing ${route.ready}; is the preview serving a different base?`,
    ).toBeVisible();
  }
  if (route.text) {
    await expect(
      page.locator('body'),
      `${route.path} is missing the text only the real page has`,
    ).toContainText(route.text);
  }

  await settle(page);
  return response as Response;
}
