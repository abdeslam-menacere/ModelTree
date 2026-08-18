import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SourceReference, UsageObservation } from '../data/schema';
import { buildUsageEvidence } from '../lib/usage-evidence';
import UsageEvidence from './UsageEvidence';

const TODAY = '2026-08-18';

const sources: SourceReference[] = [
  {
    id: 'creator-blog',
    url: 'https://example.com/creator',
    title: 'Creator usage update',
    type: 'official-announcement',
    publisher: 'Example Creator',
    lastCheckedDate: '2026-08-01',
  },
  {
    id: 'router-report',
    url: 'https://example.com/router',
    title: 'Aggregator routing report',
    type: 'independent-evaluation',
    publisher: 'Router Platform',
    lastCheckedDate: '2026-08-01',
  },
  {
    id: 'analyst-report',
    url: 'https://example.com/analyst',
    title: 'Analyst measurement',
    type: 'independent-evaluation',
    publisher: 'Analyst House',
    lastCheckedDate: '2026-08-01',
  },
];

function observation(overrides: Partial<UsageObservation> = {}): UsageObservation {
  return {
    id: 'observation-router',
    releaseId: 'release-a',
    metric: 'tokens',
    metricLabel: 'Routed tokens',
    unit: 'share of routed tokens',
    population: 'requests routed by one aggregator',
    valueAsStated: 'about 4% of routed tokens',
    windowStart: '2026-05',
    windowEnd: '2026-06',
    methodology: 'Aggregator-reported routing totals',
    sourceCategory: 'independent-measurement',
    sourceIds: ['router-report'],
    scope: 'One aggregator only',
    caveats: ['Covers one aggregator, not the whole market'],
    conflictsWithIds: [],
    verifiedAt: '2026-08-01',
    ...overrides,
  };
}

function render(usageObservations: UsageObservation[]) {
  const evidence = buildUsageEvidence(
    { sources, usageObservations, usageSyntheses: [] },
    'release-a',
    TODAY,
  );

  return renderToStaticMarkup(<UsageEvidence evidence={evidence} releaseName="Example Model" />);
}

describe('UsageEvidence rendering states', () => {
  it('renders an accessible section heading in every state', () => {
    for (const markup of [render([]), render([observation()])]) {
      expect(markup).toContain('aria-labelledby="usage-title"');
      expect(markup).toContain('<h2 id="usage-title">Who reports using it</h2>');
    }
  });

  it('states the no-data case instead of estimating', () => {
    const markup = render([]);

    expect(markup).toContain('No source-qualified usage evidence is recorded for Example Model');
    expect(markup).toContain('not that the model is unused');
    expect(markup).not.toContain('usage-observation');
  });

  it('renders an observation with its full provenance', () => {
    const markup = render([observation()]);

    expect(markup).toContain('about 4% of routed tokens');
    expect(markup).toContain('Routed tokens');
    expect(markup).toContain('requests routed by one aggregator');
    expect(markup).toContain('2026-05 to 2026-06');
    expect(markup).toContain('Aggregator-reported routing totals');
    expect(markup).toContain('One aggregator only');
    expect(markup).toContain('Covers one aggregator, not the whole market');
    expect(markup).toContain('href="https://example.com/router"');
    expect(markup).toContain('Router Platform');
  });

  it('separates creator self-reports semantically, not by colour alone', () => {
    const markup = render([
      observation(),
      observation({
        id: 'observation-creator',
        sourceCategory: 'creator-self-report',
        sourceIds: ['creator-blog'],
        valueAsStated: 'millions of developers building on it',
      }),
    ]);

    expect(markup).toContain('>Creator self-reports</h4>');
    expect(markup).toContain('>Independent evidence</h4>');
    expect(markup).toContain('Creator self-report</span>');
    expect(markup).toContain('Published by the model creator, not independent evidence.');
  });

  it('marks a stale observation in text', () => {
    const markup = render([observation({ verifiedAt: '2026-01-01' })]);

    expect(markup).toMatch(/Stale: not re-checked for \d+ days/);
    expect(markup).toContain('Includes stale figures awaiting re-verification');
  });

  it('shows conflicting readings side by side without a winner', () => {
    const markup = render([
      observation({ conflictsWithIds: ['observation-analyst'] }),
      observation({
        id: 'observation-analyst',
        sourceIds: ['analyst-report'],
        valueAsStated: 'about 9% of routed tokens',
        conflictsWithIds: ['observation-router'],
      }),
    ]);

    expect(markup).toContain('about 4% of routed tokens');
    expect(markup).toContain('about 9% of routed tokens');
    expect(markup).toContain('ModelTree does not pick a winner');
    expect(markup).toContain('Includes conflicting readings, kept side by side');
  });

  it('offers no synthesis for single-source evidence', () => {
    const markup = render([observation()]);

    expect(markup).toContain('Single-source evidence: not enough independent non-creator sources');
    expect(markup).not.toContain('Cross-source statements');
  });

  it('announces synthesis eligibility once two independent publishers report', () => {
    const markup = render([
      observation(),
      observation({ id: 'observation-analyst', sourceIds: ['analyst-report'] }),
    ]);

    expect(markup).toContain('Cross-source synthesis is available: 2 independent publishers');
  });

  it('keeps incompatible metrics in separate groups with no ranking', () => {
    const markup = render([
      observation(),
      observation({
        id: 'observation-downloads',
        metric: 'downloads',
        metricLabel: 'Model hub downloads',
        unit: 'downloads',
        population: 'downloads from one model hub',
        sourceIds: ['analyst-report'],
        valueAsStated: '120,000 downloads',
      }),
    ]);

    expect(markup).toContain('>Routed tokens</h3>');
    expect(markup).toContain('>Model hub downloads</h3>');
    // The methodology copy names ranking only to rule it out, so the evidence
    // itself is checked apart from it.
    const evidenceMarkup = markup.slice(0, markup.indexOf('<details'));
    expect(evidenceMarkup).not.toMatch(/rank|score|winner|leaderboard|most popular/i);
  });

  it('always carries the methodology explanation', () => {
    const markup = render([]);

    expect(markup).toContain('How ModelTree qualifies usage evidence');
    expect(markup).toContain('Incompatible populations are never merged');
    expect(markup).toContain('Sources are qualified, not scored');
    expect(markup).toContain('A synthesis needs two independent publishers');
    expect(markup).toContain('Missing and conflicting evidence stays visible');
  });
});
