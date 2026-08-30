import { defineConfig, devices } from '@playwright/test';

// The browser half of issue #14's testing requirements: overlap and clipping at
// 320 CSS px, a keyboard journey, reduced motion, and automated accessibility
// checks at desktop and mobile widths. jsdom cannot answer any of them --
// `getBoundingClientRect` returns a non-zero box for an element that is never
// painted -- so these run in a real engine and assert measured geometry.
//
// Deliberately NOT wired into `npm run validate`. `web/package.json`'s `build`
// is `validate && astro build`, so anything inside `validate` runs inside every
// dock's and every CI job's build; a Chromium download does not belong there.
// `.github/workflows/web-e2e.yml` installs the browser and runs this suite as a
// separate status instead, which leaves `web-ci` -- the required check -- and
// the test that pins its step list untouched.

const PORT = 4321;
const ORIGIN = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // `*.e2e.ts`, never `*.test.ts`: vitest's default include is
  // `**/*.{test,spec}.?(c|m)[jt]s?(x)`, and `scripts/verify-test-coverage.mjs`
  // fails any file vitest discovers but never runs. A Playwright spec under a
  // name vitest globs would be exactly that file.
  testMatch: '**/*.e2e.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  // No retries. A flaky accessibility or overflow result is a finding, not
  // something to paper over by running it again.
  retries: 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : [['list']],
  use: {
    baseURL: ORIGIN,
    trace: 'retain-on-failure',
    // Failure-only, and never committed. A baseline rendered on Windows and
    // compared on ubuntu-latest differs by font rasterisation alone, so it
    // would be red on arrival and tell you nothing about the page.
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // `astro preview` over the real build output, not `astro dev`: the dev
    // toolbar is a fixed overlay sitting in front of the very overlap these
    // specs measure. `npx astro build` rather than `npm run build`, because the
    // latter would re-run the whole vitest suite first.
    command: `npx astro build && npx astro preview --host 127.0.0.1 --port ${PORT}`,
    url: `${ORIGIN}/`,
    // Pinned, not inherited. `astro.config.mjs` is `base: env.BASE_PATH ?? '/'`,
    // and both `web-ci.yml` and `pages.yml` set `BASE_PATH: /ModelTree/` for the
    // deployed site. If that value reached this build the preview would serve
    // everything under `/ModelTree/`, every navigation in `e2e/` would land on a
    // 404, and a 404 page has no horizontal overflow, no animation to collapse
    // and no serious axe violations -- the entire suite would go green while
    // measuring an error document. Setting it here means the base is this file's
    // decision rather than an accident of whatever environment invoked it.
    //
    // The choice is `/`: these specs assert layout, focus, motion and
    // accessibility, none of which the base path changes. Root-absolute hrefs
    // that only break once deployed are a different concern, and one this repo
    // already covers -- `src/lib/*.test.ts` builds every route from `basePath`
    // and asserts the `/ModelTree/` form directly.
    env: { BASE_PATH: '/' },
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
