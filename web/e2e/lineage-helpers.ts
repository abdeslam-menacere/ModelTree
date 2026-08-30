import { expect, type Page, type Response } from '@playwright/test';

/**
 * The lineage surfaces issue #14 is about, each with a fingerprint that only
 * the real page can satisfy.
 *
 * The fingerprint is not decoration. `astro.config.mjs` is
 * `base: env.BASE_PATH ?? '/'`, and this repository's other workflows set
 * `BASE_PATH: /ModelTree/`. If that value ever reached this suite's build the
 * site would be served under `/ModelTree/`, every navigation here would land on
 * a 404, and a 404 page has no horizontal overflow, no animation to collapse
 * under reduced motion and no serious axe violations. Every spec in this
 * directory would pass while measuring an error page. So no assertion runs
 * until the page has proved it is the page.
 */
export const LINEAGE_PAGES = [
  {
    path: '/',
    name: 'homepage lineage explorer',
    root: '.lineage-explorer',
    fingerprint: 'Recorded lineage, creator by creator',
  },
  {
    path: '/tree/',
    name: 'tree explorer',
    root: '.model-tree-explorer',
    fingerprint: 'AI Model Ecosystem',
  },
] as const;

/** A route that does not exist, used to prove the fingerprint can fail. */
export const FABRICATED_PATH = '/definitely-not-a-page/';

/**
 * The lineage surfaces, as selectors, for scoping an accessibility scan.
 *
 * Issue #14's sixth criterion is about "the lineage view", not about every
 * pixel of the site, and this repository's shared link colour has a contrast
 * shortfall that predates this branch on every page it renders. Scoping the
 * criterion's own assertion to these roots keeps the fix for that where it
 * belongs -- a follow-up, and a change to a site-wide token -- while the
 * full-page scan alongside it still refuses to let anything new appear.
 */
export const LINEAGE_ROOTS = LINEAGE_PAGES.map((page) => page.root);

/** 320 CSS px is the narrowest width issue #14 names. */
export const NARROW = { width: 320, height: 640 } as const;
export const DESKTOP = { width: 1280, height: 800 } as const;

/**
 * Wait until nothing is still moving.
 *
 * Not politeness. The homepage runs a `reveal` fade over its lineage nodes, and
 * an element mid-fade is partly transparent, so its *rendered* colour is a
 * blend of itself and whatever is behind it. axe measures what is rendered, so
 * scanning early is a true measurement of a state that lasts a few hundred
 * milliseconds and that WCAG does not judge. Settling first is what makes the
 * scan a measurement of the page rather than of the machine's load.
 */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);

  // Two frames first, and this ordering is the whole fix. `Array.every` on an
  // empty array is `true`, so polling "is anything still running" before the
  // engine has instantiated its animations answers "no" -- correctly, and
  // uselessly. That is what happened here: `settle` returned immediately, axe
  // scanned the homepage mid-`reveal`, and read the release nodes at 72%
  // opacity as `#898989` on `#fdfcfb` (3.41:1) instead of their settled
  // `#5c5c5c` on `#ffffff` (6.7:1). A false failure, but the same blindness
  // would hide a true one.
  await nextFrames(page);

  // Then poll, because awaiting a snapshot of `animation.finished` is also not
  // enough: this page's reveal is staggered (`.explorer-band` is
  // `reveal 600ms 120ms`) and hydration starts more. Indefinite animations are
  // excluded rather than waited for, or this would simply hang on one.
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .filter((animation) => {
          const iterations = animation.effect?.getComputedTiming().iterations ?? 1;
          return Number.isFinite(iterations);
        })
        .every((animation) => animation.playState === 'finished' || animation.playState === 'idle'),
    undefined,
    { timeout: 15_000 },
  );

  // And two more, so the compositor has painted the settled state axe reads.
  await nextFrames(page);
}

async function nextFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

/**
 * Navigate to a lineage page and refuse to continue unless it is the real one.
 *
 * Three separate claims, because any one of them alone can be satisfied by the
 * wrong document: the server answered 200, the component root is present, and
 * the page carries text unique to it.
 */
export async function gotoLineage(page: Page, path: string): Promise<Response> {
  const entry = LINEAGE_PAGES.find((candidate) => candidate.path === path);
  if (entry === undefined) throw new Error(`No fingerprint recorded for ${path}`);

  const response = await page.goto(path);
  expect(response, `no response for ${path}`).not.toBeNull();
  expect(response?.status(), `HTTP status for ${path}`).toBe(200);

  await expect(
    page.locator(entry.root),
    `${path} does not carry ${entry.root}; is the preview server serving a different base?`,
  ).toBeVisible();
  await expect(
    page.locator('body'),
    `${path} is missing the text only the real page has`,
  ).toContainText(entry.fingerprint);

  await settle(page);
  return response as Response;
}

export interface Overflowing {
  readonly selector: string;
  readonly right: number;
  readonly width: number;
}

export interface OverflowReport {
  readonly scrollWidth: number;
  readonly clientWidth: number;
  readonly innerWidth: number;
  readonly offenders: Overflowing[];
}

/**
 * Every painted element whose right edge sits past the viewport, plus the
 * document's own scroll width.
 *
 * The ruler is `documentElement.clientWidth`, never `window.innerWidth`:
 * `innerWidth` includes the scrollbar gutter, so comparing a layout width
 * against it can both false-pass and false-fail by the gutter's width. Both are
 * returned so a report can state the difference rather than assume it is zero.
 *
 * An element is skipped only when the browser itself says it is not rendered --
 * zero box, `display: none`, `visibility: hidden`, or the 1px clipped box the
 * `.visually-hidden` idiom uses. Nothing is excluded on the strength of a guess
 * about what "hidden" means.
 */
export async function findOverflow(page: Page): Promise<OverflowReport> {
  return page.evaluate(() => {
    const clientWidth = document.documentElement.clientWidth;
    const offenders: { selector: string; right: number; width: number }[] = [];

    const describe = (el: Element): string => {
      const id = el.id ? `#${el.id}` : '';
      const cls =
        typeof el.className === 'string' && el.className.trim().length > 0
          ? `.${el.className.trim().split(/\s+/).join('.')}`
          : '';
      return `${el.tagName.toLowerCase()}${id}${cls}`;
    };

    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;

      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (box.width <= 1 && box.height <= 1) continue;

      // One pixel of slack: sub-pixel layout rounds, and a 320.4px edge on a
      // 320px viewport is not a horizontal scrollbar.
      if (box.right > clientWidth + 1) {
        offenders.push({ selector: describe(el), right: box.right, width: box.width });
      }
    }

    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth,
      innerWidth: window.innerWidth,
      offenders,
    };
  });
}

/**
 * Open the tree explorer down to its release nodes.
 *
 * Data-independent on purpose: the first creator and the first family, not a
 * named one, so a dataset refresh cannot redden this suite. The release nodes
 * matter because `.tree-release-node` and `.tree-disclosure` carry the
 * intrinsic `min-width` rules a narrow viewport has to override.
 *
 * Waits for the island to hydrate first. Server-rendered, every branch is open
 * -- `isOpen` returns true while `enhanced` is false -- so clicking a
 * disclosure before hydration acts on markup React is about to replace.
 */
export async function openFirstRelease(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.querySelector('.tree-creator-node')?.getAttribute('aria-expanded') === 'false',
    undefined,
    { timeout: 15_000 },
  );

  await page.locator('.tree-creator-node').first().click();
  const family = page.locator('.tree-family-node').first();
  await family.waitFor({ state: 'visible' });
  await family.click();
  await page.locator('.tree-release-node button').first().waitFor({ state: 'visible' });
  await settle(page);
}
