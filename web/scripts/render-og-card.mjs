// Renders the ModelTree social card, web/assets/og-card.svg, to the shipped
// raster web/public/og-card.png. Social scrapers do not render SVG, so the card
// that ships must be a PNG; this is the one-off, reproducible step that produces
// it. It is NOT part of the build -- `astro build` never runs it -- so it adds no
// dependency to CI or the deploy. Re-run it by hand after editing the SVG:
//
//   node scripts/render-og-card.mjs
//
// It uses the Chromium that Playwright (already a devDependency) manages, so no
// new dependency is introduced. If Chromium is not installed, run:
//
//   npx playwright install chromium
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const svgPath = fileURLToPath(new URL('../assets/og-card.svg', import.meta.url));
const outPath = fileURLToPath(new URL('../public/og-card.png', import.meta.url));

const svg = readFileSync(svgPath, 'utf8');
const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.goto(dataUrl);
  await page.screenshot({ path: outPath, clip: { x: 0, y: 0, width: 1200, height: 630 } });
  console.log(`Wrote ${outPath}`);
} finally {
  await browser.close();
}
