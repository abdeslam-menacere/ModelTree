/**
 * Playwright global setup: readiness gate for `astro preview`.
 *
 * Issue #641 — a QA run saw a transient 404 from the preview server on a route
 * that passed moments later in the same run. The root cause: Playwright's
 * `webServer.url` check only confirms the root (`/`) is serving, and under CPU
 * contention `astro preview` may respond to `/` before all routes are indexed.
 *
 * This setup probes every static core route *before any test runs*. It is a
 * fixture-level readiness gate, not a test retry: once it passes, the suite
 * runs with `retries: 0` exactly as before, and any assertion failure is real.
 *
 * If a route persistently returns non-200 after the probe exhausts its
 * attempts, the suite fails immediately with a diagnostic that names the
 * fixture as the cause — so a maintainer reading the log can tell infrastructure
 * failure from a genuine regression without a written procedure.
 */

import { STATIC_CORE_ROUTES } from './site-helpers';

const PORT = 4321;
const ORIGIN = `http://127.0.0.1:${PORT}`;

/** Maximum time (ms) to spend probing a single route across all attempts. */
const ROUTE_TIMEOUT = 30_000;
/** Pause (ms) between probe attempts for one route. */
const PROBE_INTERVAL = 1_000;

async function probeRoute(path: string): Promise<void> {
  const url = `${ORIGIN}${path}`;
  const deadline = Date.now() + ROUTE_TIMEOUT;
  let lastStatus = 0;
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts++;
    try {
      const response = await fetch(url, { redirect: 'follow' });
      lastStatus = response.status;
      if (response.ok) return;
    } catch {
      // Connection refused / network error — server still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL));
  }

  throw new Error(
    `[readiness] ${url} returned ${lastStatus || 'no response'} after ${attempts} ` +
      `attempts over ${ROUTE_TIMEOUT / 1000}s. The preview server is not serving this ` +
      `route — this is a fixture/infrastructure failure, not a test finding. ` +
      `See issue #641.`,
  );
}

export default async function globalSetup(): Promise<void> {
  // Playwright has already waited for the webServer's `url` to respond before
  // calling this, so the server process is running and `/` is reachable. What
  // is not guaranteed is that every static route is served — that is what this
  // gate checks.
  const results = await Promise.allSettled(
    STATIC_CORE_ROUTES.map((route) => probeRoute(route.path)),
  );

  const failures = results
    .map((result, i) => ({ result, route: STATIC_CORE_ROUTES[i] }))
    .filter(
      (entry): entry is { result: PromiseRejectedResult; route: (typeof STATIC_CORE_ROUTES)[number] } =>
        entry.result.status === 'rejected',
    );

  if (failures.length > 0) {
    const summary = failures
      .map((f) => `  - ${f.route.path} (${f.route.name}): ${(f.result.reason as Error).message}`)
      .join('\n');
    throw new Error(
      `Preview server readiness check failed for ${failures.length} route(s):\n${summary}`,
    );
  }
}
