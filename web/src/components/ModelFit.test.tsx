import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ModelFamily,
  ModelFitEvidenceGap,
  ModelFitStatement,
  ModelRelease,
  Organization,
  Publisher,
  SourceReference,
} from '../data/schema';
import { buildModelFitGuidance } from '../lib/model-fit';
import ModelFit from './ModelFit';

const TODAY = '2026-08-18';
const RELEASE_ID = 'release-a';

const organizations: Organization[] = [
  {
    id: 'example-org',
    slug: 'example-org',
    name: 'Example Org',
    shortName: 'Example',
    type: 'company',
    website: 'https://example.com',
    releasePage: 'https://example.com/releases',
    description: 'A creator organization.',
    sourceIds: ['creator-docs'],
    verifiedAt: '2026-08-01',
  },
];

const publishers: Publisher[] = [
  { id: 'creator-voice', name: 'Example Org', organizationId: 'example-org' },
  { id: 'analyst-house', name: 'Analyst House' },
];

const sources: SourceReference[] = [
  {
    id: 'creator-docs',
    url: 'https://example.com/docs',
    title: 'Creator documentation',
    type: 'official-docs',
    publisherId: 'creator-voice',
    lastCheckedDate: '2026-08-01',
  },
  {
    id: 'analyst-report',
    url: 'https://example.org/report',
    title: 'Analyst report',
    type: 'independent-evaluation',
    publisherId: 'analyst-house',
    lastCheckedDate: '2026-08-01',
  },
];

const families: ModelFamily[] = [
  {
    id: 'family-a',
    slug: 'family-a',
    organizationId: 'example-org',
    name: 'Family A',
    description: 'A model family.',
    categories: ['language-reasoning'],
    firstReleaseDate: '2026-01-01',
    datePrecision: 'day',
    status: 'legacy',
    sourceIds: ['creator-docs'],
    verifiedAt: '2026-08-01',
  },
];

const releases: ModelRelease[] = [
  {
    id: RELEASE_ID,
    slug: 'release-a',
    canonicalName: 'Release A',
    displayName: 'Release A',
    organizationId: 'example-org',
    familyId: 'family-a',
    version: '1',
    variant: 'Base',
    releaseDate: '2026-01-01',
    datePrecision: 'day',
    status: 'current',
    featured: false,
    categories: ['language-reasoning'],
    inputModalities: ['text'],
    outputModalities: ['text'],
    accessType: 'open-weight',
    license: { name: 'Example Community Licence', weightsDownloadable: true, osiApproved: false },
    contextWindow: 200000,
    apiAliases: [],
    predecessorIds: [],
    successorIds: [],
    siblingIds: [],
    derivedFromIds: [],
    summary: 'A model.',
    intendedUse: 'Assistant-style chat.',
    sourceIds: ['creator-docs'],
    verifiedAt: '2026-08-01',
  },
];

const benchmarks: BenchmarkDefinition[] = [
  {
    id: 'bench-a',
    slug: 'bench-a',
    name: 'Bench A',
    domain: 'general-reasoning',
    owner: 'Bench Owner',
    appliesToCategories: ['language-reasoning', 'coding'],
    metric: 'accuracy',
    metricUnit: '%',
    direction: 'higher-is-better',
    sourceIds: ['analyst-report'],
    verifiedAt: '2026-08-01',
  },
];

const benchmarkResults: BenchmarkResult[] = [
  {
    id: 'result-independent',
    benchmarkId: 'bench-a',
    benchmarkVersion: '2026-01',
    releaseId: RELEASE_ID,
    score: 71.5,
    unit: '%',
    evaluationDate: '2026-06',
    resultType: 'independent',
    sourceIds: ['analyst-report'],
    verifiedAt: '2026-08-01',
  },
];

function statement(overrides: Partial<ModelFitStatement> = {}): ModelFitStatement {
  return {
    id: 'fit-a',
    releaseId: RELEASE_ID,
    classification: 'good-fit-when',
    condition: 'you must run the model on hardware you operate',
    statement: 'The weights are published for download under a stated licence.',
    rubricDimensions: ['access-and-licensing'],
    facts: [{ kind: 'release-field', releaseId: RELEASE_ID, field: 'accessType' }],
    sourceIds: ['creator-docs'],
    scope: 'Availability only.',
    caveats: ['Availability says nothing about behaviour.'],
    conflictsWithIds: [],
    verifiedAt: '2026-08-01',
    ...overrides,
  };
}

function render(
  modelFitStatements: ModelFitStatement[],
  modelFitEvidenceGaps: ModelFitEvidenceGap[] = [],
) {
  const guidance = buildModelFitGuidance(
    {
      sources,
      publishers,
      organizations,
      families,
      releases,
      releaseEvents: [],
      benchmarks,
      benchmarkResults,
      usageObservations: [],
      pricing: [],
      deployments: [],
      modelFitStatements,
      modelFitEvidenceGaps,
    },
    RELEASE_ID,
    TODAY,
  );

  return renderToStaticMarkup(<ModelFit guidance={guidance} releaseName="Release A" />);
}

const gap: ModelFitEvidenceGap = {
  id: 'gap-a',
  releaseId: RELEASE_ID,
  dimension: 'cost-structure',
  reason: 'no-qualifying-source',
  note: 'No pricing is recorded for this release, so no cost guidance is derived.',
  verifiedAt: '2026-08-01',
};

describe('ModelFit rendering states', () => {
  it('renders an accessible section heading in every state', () => {
    for (const markup of [render([]), render([statement()])]) {
      expect(markup).toContain('aria-labelledby="fit-title"');
      expect(markup).toContain('<h2 id="fit-title">When it fits, and when it does not</h2>');
    }
  });

  it('names the section as editorial synthesis before any statement', () => {
    const markup = render([statement()]);

    expect(markup).toContain('Everything in this section is ModelTree editorial synthesis');
    expect(markup).toContain('It does not declare this model preferable to another');
  });

  it('states the no-guidance case instead of implying a judgement', () => {
    const markup = render([]);

    expect(markup).toContain('No conditional-fit guidance is recorded for Release A');
    expect(markup).toContain('not that the model suits every situation or none');
    expect(markup).not.toContain('fit-statement');
  });

  it('renders the good-fit state with its condition and full provenance', () => {
    const markup = render([statement()]);

    expect(markup).toContain('>Good fit when</h3>');
    expect(markup).toContain('you must run the model on hardware you operate');
    expect(markup).toContain('The weights are published for download under a stated licence.');
    expect(markup).toContain('Access and licensing');
    expect(markup).toContain('Availability only.');
    expect(markup).toContain('Availability says nothing about behaviour.');
    expect(markup).toContain('href="https://example.com/docs"');
    expect(markup).toContain('Creator documentation');
  });

  it('renders the trade-off state under its own heading', () => {
    const markup = render([statement({ classification: 'trade-off' })]);

    expect(markup).toContain('>Trade-off</h3>');
    expect(markup).toContain('the recorded facts cut both ways');
    expect(markup).toContain('fit-group-trade-off');
  });

  it('renders the avoid state under its own heading', () => {
    const markup = render([statement({ classification: 'avoid-when' })]);

    expect(markup).toContain('>Avoid when</h3>');
    expect(markup).toContain('Not a statement that the model is deficient');
    expect(markup).toContain('fit-group-avoid-when');
  });

  it('separates creator claims from measured evidence in text, not colour alone', () => {
    const markup = render([statement({
      rubricDimensions: ['access-and-licensing', 'measured-benchmark-evidence'],
      facts: [
        { kind: 'release-field', releaseId: RELEASE_ID, field: 'accessType' },
        { kind: 'benchmark-result', benchmarkResultId: 'result-independent' },
      ],
      sourceIds: ['creator-docs', 'analyst-report'],
    })]);

    expect(markup).toContain('>Measured evidence</h6>');
    expect(markup).toContain('>Creator claims</h6>');
    expect(markup).toContain('Produced by a recorded measurement rather than stated in documentation.');
    expect(markup).toContain('Documentation, not measurement.');
    expect(markup).toContain('ModelTree editorial synthesis');
  });

  it('renders the missing-evidence state as a recorded gap', () => {
    const markup = render([statement()], [gap]);

    expect(markup).toContain('Where the evidence runs out');
    expect(markup).toContain('Cost structure');
    expect(markup).toContain('No qualifying source');
    expect(markup).toContain('No pricing is recorded for this release');
    expect(markup).toContain('1 rubric dimension with no qualifying evidence');
  });

  it('renders gaps even when nothing else is recorded', () => {
    const markup = render([], [gap]);

    expect(markup).toContain('No conditional-fit guidance is recorded for Release A');
    expect(markup).toContain('Where the evidence runs out');
  });

  it('renders the conflict state with both readings and no winner', () => {
    const markup = render([
      statement({ id: 'fit-current', conflictsWithIds: ['fit-legacy'] }),
      statement({
        id: 'fit-legacy',
        classification: 'avoid-when',
        condition: 'you need a family the vendor still lists as current',
        statement: 'The family this release belongs to is recorded as legacy.',
        rubricDimensions: ['lifecycle-stability'],
        facts: [{ kind: 'family-field', familyId: 'family-a', field: 'status' }],
        conflictsWithIds: ['fit-current'],
      }),
    ]);

    expect(markup).toContain('Contradicted by other recorded guidance for this model');
    expect(markup).toContain('Both readings are kept and neither is treated as settling the question');
    expect(markup).toContain('Includes contradicting statements, kept side by side');
    expect(markup).toContain('The weights are published for download under a stated licence.');
    expect(markup).toContain('The family this release belongs to is recorded as legacy.');
  });

  it('labels the date as evidence verification, not editorial review', () => {
    const markup = render([statement()]);

    expect(markup).toContain('<dt>Evidence verified</dt>');
    expect(markup).not.toContain('Last verified');
  });

  it('marks stale guidance as stale evidence, in text', () => {
    const markup = render([statement({ verifiedAt: '2025-06-01' })]);

    expect(markup).toMatch(/Stale: the evidence beneath this has not been re-checked for \d+ days/);
    expect(markup).toContain('Includes guidance whose evidence is awaiting re-verification');
  });

  it('describes the wording check without overstating what it can detect', () => {
    const markup = render([]);

    expect(markup).toContain('What the wording check does, and what it cannot do');
    expect(markup).toContain('a vocabulary filter, not a judgement about meaning');
    expect(markup).toContain('a comparative claim phrased around those words would pass it');
    expect(markup).toContain('The check that actually holds is provenance');
    // The old copy promised that anything placing a model above the field was
    // rejected before publication. It is not, and the page must not say so.
    expect(markup).not.toContain('rejected before it can be published');
  });

  it('describes the provenance rule as a sourcing rule, not a semantic one', () => {
    const markup = render([]);

    expect(markup).toContain('may cite only the sources the facts beneath it already cite');
    expect(markup).toContain('cannot pull in a source no recorded fact carries');
    expect(markup).toContain('constrains where evidence comes from, not what a sentence means');
    // The provenance rule is a subset check over sourceIds. It does not test
    // whether a statement's content follows from its facts: the known-miss
    // phrasing in model-fit.test.ts cites a legitimate source and validates.
    // Earlier copy said an unsupported comparison had "nothing to stand on",
    // which claimed an entailment check that does not exist anywhere here.
    expect(markup).not.toContain('nothing to stand on');
    expect(markup).not.toContain('introduce a claim');
  });

  it('says the statement date is the evidence date, not a review date', () => {
    const markup = render([statement()]);

    expect(markup).toContain('the verification date of the newest fact beneath it');
    expect(markup).toContain('not a record that an editor re-read the reasoning');
  });

  it('always carries the methodology explanation', () => {
    const markup = render([]);

    expect(markup).toContain('How ModelTree derives conditional fit');
    expect(markup).toContain('Guidance is conditional, never a verdict');
    expect(markup).toContain('The rubric is disclosed, not weighted');
    expect(markup).toContain('The evidence threshold');
    expect(markup).toContain('Conflicts are shown, not resolved');
    expect(markup).toContain('What this cannot tell you');
    expect(markup).toContain('Measured benchmark evidence');
  });

  it('never ranks a model outside the copy that rules ranking out', () => {
    const markup = render([statement()], [gap]);
    // The methodology block names ranking only to refuse it, so the guidance
    // itself is checked apart from it.
    const guidanceMarkup = markup.slice(0, markup.indexOf('<details'));

    expect(guidanceMarkup).not.toMatch(/rank|score|winner|leaderboard|best model/i);
  });

  it('links each statement heading to the statement it labels', () => {
    const markup = render([statement()]);

    expect(markup).toContain('aria-labelledby="fit-fit-a"');
    expect(markup).toContain('id="fit-fit-a"');
    expect(markup).toContain('aria-labelledby="fit-group-good-fit-when"');
    expect(markup).toContain('aria-label="Sources cited by this statement"');
  });
});
