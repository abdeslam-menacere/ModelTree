// Repeatable mobile lab metrics for issue #33 -- REPORT ONLY, never a gate.
//
// Why this is not wired into CI: LCP/INP/CLS are lab timings that vary with CPU
// contention, and this machine runs several agents at once. A QA gate already
// watched `astro preview` return a transient 404 under load. Gating a timing on
// a contended runner manufactures a flaky *required* check -- the exact failure
// mode the byte-budget test (which gates) is designed to avoid. So this script
// measures and prints; the numbers live in docs/product/PERFORMANCE-BUDGETS.md
// with the honest caveat, and nothing here can redden a merge.
//
// No new dependency: it drives the Chromium that Playwright (already a
// devDependency) installs, via @playwright/test's exported `chromium`. Adding
// Lighthouse would regenerate the mirror lockfile (ADR 0004) -- pure cost.
//
// Method: emulate a mid-tier mobile (Pixel-5 viewport, 4x CPU throttle, Slow-4G
// network via CDP), load each route N times, and read Web Vitals from the
// browser's own Performance APIs (LCP, CLS via layout-shift, an INP proxy via
// Event Timing after a scripted interaction). Reports median and worst (max) per
// route, because a single sample on a shared box is not trustworthy.
//
// Usage: node scripts/lab-metrics.mjs [--runs N] [--json]

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium, devices } from '@playwright/test';

const RUNS = Number(process.argv.includes('--runs') ? process.argv[process.argv.indexOf('--runs') + 1] : 5);
const AS_JSON = process.argv.includes('--json');
const PORT = 4330;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const ROUTES = [
  ['home', '/'],
  ['catalog', '/models/'],
  ['benchmarks', '/benchmarks/'],
  ['compare', '/compare/'],
];

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`preview server did not come up at ${url}`);
}

// Read LCP + CLS accumulated during load, then trigger one interaction and read
// the worst Event Timing duration as an INP proxy. Runs in the page.
async function measurePage(page, url) {
  await page.addInitScript(() => {
    window.__cls = 0;
    window.__lcp = 0;
    window.__inp = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((list) => {
      const es = list.getEntries();
      window.__lcp = es[es.length - 1].startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__inp = Math.max(window.__inp, e.duration);
    }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
  });

  await page.goto(url, { waitUntil: 'load' });
  await sleep(1500); // let LCP settle

  // A scripted interaction so the INP proxy is not vacuous: focus + type into the
  // first text input if present, else click the first button.
  const input = page.locator('input[type="search"], input[type="text"]').first();
  try {
    if (await input.count()) {
      await input.click({ timeout: 1000 });
      await input.type('gpt', { delay: 40 });
    } else {
      await page.locator('button').first().click({ timeout: 1000 });
    }
  } catch {
    /* no interactive control on this route; INP proxy stays 0 */
  }
  await sleep(500);

  return page.evaluate(() => ({ lcp: window.__lcp, cls: window.__cls, inp: window.__inp }));
}

async function main() {
  const server = spawn('node', ['node_modules/astro/bin/astro.mjs', 'preview', '--host', '127.0.0.1', '--port', String(PORT)], {
    stdio: 'ignore',
    env: { ...process.env, NODE_ENV: 'production' },
  });
  try {
    await waitForServer(`${ORIGIN}/`, 60_000);
    const browser = await chromium.launch();
    const results = {};
    for (const [id, path] of ROUTES) {
      const samples = { lcp: [], cls: [], inp: [] };
      for (let i = 0; i < RUNS; i++) {
        const context = await browser.newContext({
          ...devices['Pixel 5'],
        });
        const page = await context.newPage();
        const client = await context.newCDPSession(page);
        await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        await client.send('Network.emulateNetworkConditions', {
          offline: false,
          downloadThroughput: (1.6 * 1024 * 1024) / 8, // ~Slow 4G
          uploadThroughput: (750 * 1024) / 8,
          latency: 150,
        });
        const m = await measurePage(page, ORIGIN + path);
        samples.lcp.push(m.lcp);
        samples.cls.push(m.cls);
        samples.inp.push(m.inp);
        await context.close();
      }
      results[id] = {
        path,
        lcp: { median: Math.round(median(samples.lcp)), worst: Math.round(Math.max(...samples.lcp)) },
        cls: { median: +median(samples.cls).toFixed(3), worst: +Math.max(...samples.cls).toFixed(3) },
        inp: { median: Math.round(median(samples.inp)), worst: Math.round(Math.max(...samples.inp)) },
      };
    }
    await browser.close();

    if (AS_JSON) {
      console.log(JSON.stringify({ runs: RUNS, device: 'Pixel 5 / 4x CPU / Slow-4G', results }, null, 2));
    } else {
      console.log(`Mobile lab (Pixel 5, 4x CPU, Slow-4G), ${RUNS} runs each. Targets: LCP<2500ms INP<200ms CLS<0.1`);
      console.log('(report-only; contended shared machine -- see docs/product/PERFORMANCE-BUDGETS.md)\n');
      for (const [id, r] of Object.entries(results)) {
        console.log(
          `  ${id.padEnd(11)} ${r.path.padEnd(12)}  LCP med ${String(r.lcp.median).padStart(5)}ms / worst ${String(r.lcp.worst).padStart(5)}ms   CLS med ${r.cls.median} / worst ${r.cls.worst}   INP~ med ${String(r.inp.median).padStart(4)}ms / worst ${String(r.inp.worst).padStart(4)}ms`,
        );
      }
    }
  } finally {
    server.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
