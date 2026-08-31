import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The public verification context on the model detail page (issue #28). It reads
 * the page source rather than a render — the precedent set by
 * `methodology.test.ts` — because what these assertions defend is calm, textual,
 * machine-readable markup, which is exactly what is on the page before any
 * hydration and what the forced-colors and axe e2e sweeps then scan.
 *
 * The requirements this pins:
 *   - the last-verified date is a machine-readable `<time datetime>` element, not
 *     bare prose, so assistive tech and machines read the same date a human does;
 *   - the note links to the methodology's freshness section, so a visitor has a
 *     path from "how old is this" to "how we decide", and that anchor actually
 *     exists on the methodology page;
 *   - the note stays calm: no alarm icon, no warning styling. Staleness on public
 *     surfaces is shown per-fact by the passport's existing text note, never by
 *     reddening this record-level line.
 *
 * This test lives under `src/lib/` rather than beside the page: everything under
 * `src/pages/` is a route Astro tries to build, so a `.test.ts` there becomes a
 * broken endpoint.
 */
const page = readFileSync(new URL('../pages/models/[slug].astro', import.meta.url), 'utf8');
const methodology = readFileSync(new URL('../pages/methodology.astro', import.meta.url), 'utf8');

const verificationNote = (() => {
  const match = page.match(/<p class="verification-note">([\s\S]*?)<\/p>/);
  if (!match) throw new Error('the model detail page has no verification note');
  return match[1];
})();

describe('model detail verification note', () => {
  it('renders the last-verified date as a machine-readable time element', () => {
    expect(verificationNote).toContain('<time datetime={release.verifiedAt}>');
    expect(verificationNote).toContain('{view.verifiedAt}</time>');
  });

  it('links to the methodology freshness section', () => {
    // The note references the frontmatter constant; the constant resolves to the
    // freshness anchor. Assert both halves so neither can drift alone.
    expect(verificationNote).toContain('href={methodologyFreshnessHref}');
    expect(page).toContain('methodology/#freshness');
  });

  it('links to an anchor the methodology page actually defines', () => {
    expect(methodology).toContain('id="freshness"');
  });

  it('stays calm: no warning icon or alarm styling on the record-level note', () => {
    expect(verificationNote).not.toMatch(/AlertTriangle|warning|danger|<svg/i);
  });
});
