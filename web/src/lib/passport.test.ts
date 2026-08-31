import { describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import { accessTypeGlossary, lifecycleStatusGlossary, methodologyReferences } from './methodology';
import { modelRoute } from './catalog';
import { parseComparisonSelection } from './comparison';
import {
  COMPLETE_RELEASE_ID,
  DANGLING_RELATION_ID,
  FIXTURE_TODAY,
  OPEN_WEIGHT_RELEASE_ID,
  PROPRIETARY_RELEASE_ID,
  SPARSE_RELEASE_ID,
  passportFixtures,
} from '../../tests/fixtures/passport-dataset';
import {
  absentPositioning,
  completePositioning,
  partialPositioning,
} from '../../tests/fixtures/passport-positioning';
import type { VariantPositioning } from '../data/variant-positioning-schema';
import {
  PASSPORT_SECTION_ORDER,
  PassportError,
  RELATIONSHIP_KINDS,
  VOLATILE_STALE_AFTER_DAYS,
  buildModelPassport,
  compareHref,
  correctionHref,
  formatDateWithPrecision,
  formatEffectiveRange,
  formatRate,
  relationshipDescription,
  relationshipLabel,
} from './passport';
import { MODEL_DNA_DIMENSIONS } from './model-dna';
import { organizationLabel } from './organization-name';
import { modelStaticPaths } from './routes';

const BASE = '/ModelTree/';
const TODAY = '2026-08-27';

const fixtureView = (releaseId: string) =>
  buildModelPassport(passportFixtures, releaseId, BASE, FIXTURE_TODAY);

const realView = (releaseId: string) => buildModelPassport(dataset, releaseId, BASE, TODAY);

const sectionOf = (view: ReturnType<typeof fixtureView>, id: (typeof PASSPORT_SECTION_ORDER)[number]) => {
  const section = view.sections.find((candidate) => candidate.id === id);
  if (!section) throw new Error(`no section ${id}`);
  return section;
};

describe('date formatting respects the precision the source stated', () => {
  it('prints a year-only date as a year', () => {
    expect(formatDateWithPrecision('2024-01-01', 'year')).toBe('2024');
  });

  it('prints a month-only date as a month and year', () => {
    expect(formatDateWithPrecision('2026-03-01', 'month')).toBe('Mar 2026');
  });

  it('prints a day-precision date in full', () => {
    expect(formatDateWithPrecision('2026-02-10', 'day')).toBe('Feb 10, 2026');
  });

  it('accepts a partial string a Date constructor would reject', () => {
    // `new Date('2026-03')` parses, but `new Date('2026')` and the
    // `formatDate` helper's `${value}T00:00:00Z` both produce Invalid Date.
    expect(formatDateWithPrecision('2026', 'year')).toBe('2026');
    expect(formatDateWithPrecision('2026-03', 'month')).toBe('Mar 2026');
  });

  it('never invents precision the record does not carry', () => {
    // The stored day is a placeholder wherever precision is coarser, so it must
    // not reach the page.
    expect(formatDateWithPrecision('2026-03-01', 'month')).not.toMatch(/\b1\b/);
    expect(formatDateWithPrecision('2024-01-01', 'year')).not.toMatch(/Jan/);
  });
});

describe('rate formatting', () => {
  it('keeps sub-cent rates legible instead of rounding them to zero', () => {
    // A real per-1k-token input price sits below one cent. Two-decimal currency
    // formatting would print "0.00" and state a falsehood.
    const formatted = formatRate(0.0018, 'EUR');
    expect(formatted).not.toMatch(/0\.00\b/);
    expect(formatted).toMatch(/0\.0018/);
  });

  it('names the currency of every rate by its ISO code', () => {
    // The code, not a symbol: several currencies share "$", and the schema
    // stores the code precisely so the page need not guess.
    expect(formatRate(1.4, 'USD')).toBe('USD 1.40');
    expect(formatRate(0.002, 'EUR')).toBe('EUR 0.002');
  });
});

describe('effective ranges', () => {
  it('leaves an open range open rather than inventing an end date', () => {
    const range = formatEffectiveRange('2026-06-01');
    expect(range).toBe('From Jun 1, 2026');
    expect(range).not.toMatch(/ to /);
  });

  it('closes a superseded range with its end date', () => {
    const range = formatEffectiveRange('2026-01-20', '2026-05-31');
    expect(range).toBe('Jan 20, 2026 to May 31, 2026');
  });
});

describe('AC2 — lineage relationships are distinct and complete', () => {
  it('covers all four relationship kinds the schema records', () => {
    expect([...RELATIONSHIP_KINDS].sort()).toEqual(
      ['derivation', 'predecessor', 'sibling', 'successor'],
    );
  });

  it('gives every kind a distinct label and a distinct explanation', () => {
    const labels = RELATIONSHIP_KINDS.map((kind) => relationshipLabel(kind));
    const descriptions = RELATIONSHIP_KINDS.map((kind) => relationshipDescription(kind));

    expect(new Set(labels).size).toBe(RELATIONSHIP_KINDS.length);
    expect(new Set(descriptions).size).toBe(RELATIONSHIP_KINDS.length);
    for (const description of descriptions) expect(description.length).toBeGreaterThan(20);
  });

  it('resolves every kind to a linked release on the complete fixture', () => {
    const view = fixtureView(COMPLETE_RELEASE_ID);
    const byKind = new Map(view.relationships.map((group) => [group.kind, group]));

    for (const kind of RELATIONSHIP_KINDS) {
      expect(byKind.get(kind)?.links.length, `${kind} should resolve`).toBeGreaterThan(0);
    }
    expect(byKind.get('predecessor')?.links[0]?.displayName).toBe('Earlier Model');
    expect(byKind.get('successor')?.links[0]?.displayName).toBe('Later Model');
    expect(byKind.get('sibling')?.links[0]?.displayName).toBe('Complete Model Mini');
    expect(byKind.get('derivation')?.links[0]?.displayName).toBe('Foundation Model');
  });

  it('surfaces a relationship id no release resolves rather than dropping it', () => {
    const view = fixtureView(COMPLETE_RELEASE_ID);
    const derivation = view.relationships.find((group) => group.kind === 'derivation');

    expect(derivation?.unresolvedIds).toEqual([DANGLING_RELATION_ID]);
  });

  it('links every relationship to the same route the catalog uses', () => {
    const view = fixtureView(COMPLETE_RELEASE_ID);
    for (const group of view.relationships) {
      for (const link of group.links) {
        expect(link.href).toBe(modelRoute(BASE, link.slug));
      }
    }
  });

  it('hides the lineage section when no relationship is recorded', () => {
    const view = fixtureView(SPARSE_RELEASE_ID);
    expect(view.presentRelationships).toEqual([]);
    expect(sectionOf(view, 'lineage').present).toBe(false);
    expect(view.notRecorded.map((note) => note.id)).toContain('lineage');
  });
});

describe('sibling tier positioning on the passport view', () => {
  const positionedView = (releaseId: string, records: VariantPositioning) =>
    buildModelPassport(passportFixtures, releaseId, BASE, FIXTURE_TODAY, records);

  it('measures coverage as complete only when every name in use is positioned', () => {
    const view = positionedView(COMPLETE_RELEASE_ID, completePositioning);

    expect(view.positioning.coverage).toBe('complete');
    expect(view.positioning.unpositioned).toEqual([]);
    expect(view.positioning.positioned.map((entry) => entry.variant)).toEqual(['base', 'mini']);
  });

  it('measures coverage as partial, and names what is missing, when one is not', () => {
    const view = positionedView(COMPLETE_RELEASE_ID, partialPositioning);

    expect(view.positioning.coverage).toBe('partial');
    expect(view.positioning.unpositioned.map((entry) => entry.variant)).toEqual(['mini']);
  });

  it('measures coverage as absent when nothing is recorded, keeping the names in use', () => {
    const view = positionedView(COMPLETE_RELEASE_ID, absentPositioning);

    expect(view.positioning.coverage).toBe('absent');
    expect(view.positioning.positioned).toEqual([]);
    expect(view.positioning.unpositioned.map((entry) => entry.variant)).toEqual(['base', 'mini']);
  });

  it('keeps the creator\'s words and ModelTree\'s reading in separate fields', () => {
    const view = positionedView(COMPLETE_RELEASE_ID, completePositioning);
    const [entry] = view.positioning.positioned;

    // The structural half of the "official is not editorial" rule: there is no
    // ModelTree-authored string anywhere under `official`, so the two cannot be
    // rendered from one value with a flag.
    expect(Object.keys(entry.official).sort()).toEqual(['effectiveAsOf', 'sources']);
    expect(entry.official.sources[0].quote).not.toBe(entry.editorial.summary);
    expect(entry.editorial.verifiedAt).toBeTruthy();
  });

  // Sibling variants are family membership, not a recorded relationship, so the
  // section has to survive a release that has one and not the other.
  it('shows the lineage section for a release with positioning but no relationship', () => {
    const records: VariantPositioning = [{
      ...partialPositioning[0],
      familyId: 'sparse-family',
      variants: [partialPositioning[0].variants[0]],
    }];
    const view = buildModelPassport(passportFixtures, SPARSE_RELEASE_ID, BASE, FIXTURE_TODAY, records);

    expect(view.presentRelationships).toEqual([]);
    expect(sectionOf(view, 'lineage').present).toBe(true);
  });

  it('routes every member release through the same helper the catalog uses', () => {
    const view = positionedView(COMPLETE_RELEASE_ID, completePositioning);
    const members = view.positioning.positioned.flatMap((entry) => entry.releases);

    expect(members.length).toBeGreaterThan(0);
    for (const member of members) {
      expect(view.positioningMemberHrefs[member.id]).toBe(modelRoute(BASE, member.slug));
    }
  });

  it('points at the methodology section that refuses a universal ranking', () => {
    const view = positionedView(COMPLETE_RELEASE_ID, completePositioning);
    expect(view.positioningMethodologyHref).toBe(`${BASE}methodology/#guidance`);
  });

  it('records nothing for the shipped families that have no documented ladder', () => {
    // Not a placeholder assertion: `meta-llama-4` ships sibling variants and no
    // ladder ModelTree could verify, and it must stay visibly unknown rather
    // than be filled in from the names.
    const llama = dataset.releases.find(({ familyId }) => familyId === 'meta-llama-4');
    expect(llama, 'expected the shipped catalog to still carry meta-llama-4').toBeTruthy();

    const view = realView(llama!.id);
    expect(view.positioning.coverage).toBe('absent');
    expect(view.positioning.unpositioned.length).toBeGreaterThan(1);
  });
});

describe('AC3 — pricing states currency, unit, effective date, region/tier, and source', () => {
  it('renders every required field for each priced row', () => {
    const view = fixtureView(PROPRIETARY_RELEASE_ID);
    expect(view.pricing.length).toBeGreaterThan(0);

    for (const row of view.pricing) {
      expect(row.currency).not.toBe('');
      expect(row.unitLabel).not.toBe('');
      expect(row.effectiveRange).not.toBe('');
      expect(row.rates.length).toBeGreaterThan(0);
      expect(row.sources.length).toBeGreaterThan(0);
      for (const source of row.sources) expect(source.url).toMatch(/^https?:\/\//);
    }
  });

  it('distinguishes a superseded price from the current one', () => {
    const view = fixtureView(PROPRIETARY_RELEASE_ID);
    const current = view.pricing.filter((row) => row.isCurrent);
    const superseded = view.pricing.filter((row) => !row.isCurrent);

    expect(current).toHaveLength(1);
    expect(superseded).toHaveLength(1);
    expect(superseded[0]?.effectiveRange).toMatch(/ to /);
    expect(current[0]?.effectiveRange).toMatch(/^From /);
  });

  it('leaves region and tier explicitly null when unrecorded, not blank', () => {
    const view = fixtureView(PROPRIETARY_RELEASE_ID);
    const withTier = view.pricing.find((row) => row.processingTier !== null);
    const withoutTier = view.pricing.find((row) => row.processingTier === null);

    expect(withTier?.region).toBe('eu-west');
    expect(withTier?.processingTier).toBe('Batch');
    expect(withoutTier?.region).toBeNull();
  });

  it('marks a price verified beyond the volatile horizon as stale', () => {
    const view = fixtureView(PROPRIETARY_RELEASE_ID);
    const stale = view.pricing.find((row) => row.isStale);
    const fresh = view.pricing.find((row) => !row.isStale);

    expect(stale, 'a price verified long ago should be flagged').toBeDefined();
    expect(stale?.daysSinceVerified).toBeGreaterThan(VOLATILE_STALE_AFTER_DAYS);
    expect(fresh?.daysSinceVerified).toBeLessThanOrEqual(VOLATILE_STALE_AFTER_DAYS);
  });

  it('reaches a price only through a deployment on a named platform', () => {
    const view = fixtureView(COMPLETE_RELEASE_ID);
    for (const row of view.pricing) {
      expect(row.platformName).toBe('Example Cloud API');
    }
    // The downloadable-weights deployment carries no rate, so it contributes a
    // row to availability and none to pricing.
    expect(view.availability).toHaveLength(2);
    expect(view.pricing).toHaveLength(1);
  });
});

describe('AC4 — openness wording follows the methodology page', () => {
  it('quotes the methodology glossary definition verbatim', () => {
    for (const releaseId of [COMPLETE_RELEASE_ID, PROPRIETARY_RELEASE_ID, OPEN_WEIGHT_RELEASE_ID]) {
      const view = fixtureView(releaseId);
      const entry = accessTypeGlossary.find((candidate) => candidate.value === view.access.value);
      expect(view.access.definition).toBe(entry?.definition);
    }
  });

  it('quotes the methodology lifecycle definition verbatim', () => {
    const view = fixtureView(COMPLETE_RELEASE_ID);
    const entry = lifecycleStatusGlossary.find(
      (candidate) => candidate.value === view.release.status,
    );
    expect(view.statusDefinition).toBe(entry?.definition);
  });

  it('links to the methodology section that defines access', () => {
    const view = fixtureView(COMPLETE_RELEASE_ID);
    expect(view.access.methodologyHref).toBe(`${BASE}methodology/#access`);
  });

  it('does not call downloadable weights open source when the OSI has not approved the licence', () => {
    const view = fixtureView(OPEN_WEIGHT_RELEASE_ID);
    const license = view.access.license;

    expect(license?.weightsDownloadable).toBe(true);
    expect(license?.osiApproved).toBe(false);
    expect(license?.weightsStatement).toMatch(/downloadable/i);
    // Asserted against the derived statement, not the glossary prose: the
    // methodology's own definition of open-weight legitimately contains the
    // phrase "open-source" while explaining that the two differ.
    expect(license?.osiStatement).toMatch(/not recorded as OSI-approved/i);
    expect(license?.osiStatement).not.toMatch(/\bis recorded as OSI-approved\b/);
  });

  it('states OSI approval where the record carries it', () => {
    const view = fixtureView(COMPLETE_RELEASE_ID);
    expect(view.access.license?.osiStatement).toMatch(/OSI-approved open source/);
    expect(view.access.license?.spdxId).toBe('Apache-2.0');
  });

  it('reports the two licence booleans separately, never inferring one from the other', () => {
    const complete = fixtureView(COMPLETE_RELEASE_ID).access.license;
    const nonOsi = fixtureView(OPEN_WEIGHT_RELEASE_ID).access.license;

    // Same weights answer, different OSI answer, and the statements must differ
    // on exactly that axis.
    expect(complete?.weightsStatement).toBe(nonOsi?.weightsStatement);
    expect(complete?.osiStatement).not.toBe(nonOsi?.osiStatement);
  });

  it('explains an absent licence rather than implying the model is unlicensed', () => {
    const view = fixtureView(PROPRIETARY_RELEASE_ID);
    expect(view.access.license).toBeNull();
    expect(view.access.licenseAbsenceNote).toMatch(/not a claim/i);
  });

  it('refuses to render an access type the methodology does not define', () => {
    const broken = {
      ...passportFixtures,
      releases: passportFixtures.releases.map((release) =>
        release.id === SPARSE_RELEASE_ID
          ? { ...release, accessType: 'invented-access' as never }
          : release),
    };

    expect(() => buildModelPassport(broken, SPARSE_RELEASE_ID, BASE, FIXTURE_TODAY))
      .toThrow(PassportError);
  });
});

describe('AC5 — a correction link is offered for every release', () => {
  it('names the record slug in the issue title and body of every real release', () => {
    expect(dataset.releases.length).toBeGreaterThan(0);

    for (const release of dataset.releases) {
      const url = new URL(correctionHref(release));
      expect(url.origin + url.pathname).toBe(
        new URL(`${methodologyReferences.repository}/issues/new`).href,
      );
      expect(url.searchParams.get('title')).toContain(release.slug);
      expect(url.searchParams.get('body')).toContain(release.slug);
    }
  });

  it('survives a canonical name containing characters that would truncate a raw query string', () => {
    const url = new URL(correctionHref({
      slug: 'ampersand-model',
      canonicalName: 'A & B #1 Model',
      verifiedAt: '2026-08-15',
    }));

    expect(url.searchParams.get('title')).toContain('A & B #1 Model');
    expect(url.searchParams.get('title')).toContain('ampersand-model');
  });

  it('is exposed as the report action on the built view', () => {
    const view = fixtureView(COMPLETE_RELEASE_ID);
    const report = view.actions.find((action) => action.kind === 'report');

    expect(report?.href).toBe(view.correctionUrl);
    expect(report?.external).toBe(true);
  });
});

describe('actions cooperate with the routes that exist', () => {
  // The comparison's own parser, fed the real release slugs, so a compare link
  // cannot drift from what `/compare` actually accepts.
  const knownSlugs = dataset.releases.map((release) => release.slug);

  it('builds a compare link the comparison itself parses back to this release', () => {
    const view = realView(dataset.releases[0]!.id);
    const compare = view.actions.find((action) => action.kind === 'compare');
    expect(compare).toBeDefined();

    const search = new URL(compare!.href, 'https://example.invalid').search;
    const selection = parseComparisonSelection(search, knownSlugs);

    expect(selection.slugs).toEqual([view.release.slug]);
    // One model is a start, not a comparison, and the page says so.
    expect(selection.isComparable).toBe(false);
    expect(selection.shortfall).toBe(1);
  });

  it('points every real release at a slug the comparison can select', () => {
    expect(dataset.releases.length).toBeGreaterThan(0);

    for (const release of dataset.releases) {
      const search = new URL(compareHref(BASE, release.slug), 'https://example.invalid').search;
      const selection = parseComparisonSelection(search, knownSlugs);
      expect(selection.slugs, `${release.slug} should survive the comparison parser`)
        .toEqual([release.slug]);
      expect(selection.rejections).toEqual([]);
    }
  });

  it('drops a slug the comparison does not know, rather than opening an empty column', () => {
    // Proves the assertion above is a real round trip: the parser validates
    // against the known slugs, so a value it does not hold comes back rejected.
    const search = new URL(compareHref(BASE, 'no-such-model'), 'https://example.invalid').search;
    const selection = parseComparisonSelection(search, knownSlugs);

    expect(selection.slugs).toEqual([]);
    expect(selection.rejections.map((rejection) => rejection.code)).toEqual(['unknown-model']);
  });

  it('lands on the compare route rather than the catalog', () => {
    const view = realView(dataset.releases[0]!.id);
    const compare = view.actions.find((action) => action.kind === 'compare')!;

    expect(compare.href.startsWith(`${BASE}compare/`)).toBe(true);
    expect(compare.href).not.toContain('/models/');
  });

  it('anchors the evidence action to a heading the page actually renders', () => {
    const view = fixtureView(COMPLETE_RELEASE_ID);
    const evidence = view.actions.find((action) => action.kind === 'evidence');
    const headingIds = view.sections.map((section) => section.headingId);

    expect(evidence?.href.startsWith('#')).toBe(true);
    expect(headingIds).toContain(evidence!.href.slice(1));
  });

  it('offers exactly the three actions the issue asks for', () => {
    const view = fixtureView(COMPLETE_RELEASE_ID);
    expect(view.actions.map((action) => action.kind)).toEqual(['compare', 'evidence', 'report']);
    for (const action of view.actions) {
      expect(action.label.length).toBeGreaterThan(0);
      expect(action.description.length).toBeGreaterThan(0);
    }
  });
});

describe('AC1 — sections disappear coherently when their records are absent', () => {
  it('numbers present sections contiguously and leaves absent ones unnumbered', () => {
    for (const releaseId of [COMPLETE_RELEASE_ID, SPARSE_RELEASE_ID, PROPRIETARY_RELEASE_ID]) {
      const view = fixtureView(releaseId);
      const numbers = view.sections.filter((s) => s.present).map((s) => s.number);
      const expected = numbers.map((_, index) => String(index + 1).padStart(2, '0'));

      expect(numbers, `${releaseId} should number 01..0N with no gap`).toEqual(expected);
      for (const section of view.sections.filter((s) => !s.present)) {
        expect(section.number).toBeNull();
      }
    }
  });

  it('names every absent section in the roll-up with a reason', () => {
    const view = fixtureView(SPARSE_RELEASE_ID);
    const absent = view.sections.filter((section) => !section.present).map((s) => s.id);

    expect(view.notRecorded.map((note) => note.id)).toEqual(absent);
    for (const note of view.notRecorded) {
      expect(note.reason.length).toBeGreaterThan(40);
      // An absent record is a gap in ModelTree's review, not a claim about the
      // model, and each reason has to say so.
      expect(note.reason).toMatch(/not a claim|has not|none has been|does not infer/i);
    }
  });

  it('records nothing as missing when every section is populated', () => {
    const view = fixtureView(COMPLETE_RELEASE_ID);
    expect(view.notRecorded).toEqual([]);
    expect(view.sections.every((section) => section.present)).toBe(true);
    expect(view.sections.map((section) => section.number)).toEqual(
      PASSPORT_SECTION_ORDER.map((_, index) => String(index + 1).padStart(2, '0')),
    );
  });

  it('gives every section a unique heading id', () => {
    const view = fixtureView(COMPLETE_RELEASE_ID);
    const ids = view.sections.map((section) => section.headingId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the shipped dataset exercises both the present and the absent branch', () => {
  // `raw.ts` now composes serving-platform, deployment, and release-event JSON,
  // so availability and history render on real data for the first time. Pricing
  // still has no sourced record, so its absent branch is still the real one.
  // The fixture-backed tests above stay the proof for the populated branches: a
  // section asserted only here would go quiet the day its last record moved.
  it('backs availability and history with records, and still prices nothing', () => {
    expect(dataset.servingPlatforms.length).toBeGreaterThan(0);
    expect(dataset.deployments.length).toBeGreaterThan(0);
    expect(dataset.releaseEvents.length).toBeGreaterThan(0);
    expect(dataset.pricing).toEqual([]);
  });

  it('shows availability and history exactly where a record backs them', () => {
    // Positive control: the release list is non-empty, so the loop below runs.
    expect(dataset.releases.length).toBeGreaterThan(0);

    let deployedCount = 0;
    let eventedCount = 0;
    let bareCount = 0;

    for (const release of dataset.releases) {
      const view = realView(release.id);
      const deployed = dataset.deployments.some((item) => item.releaseId === release.id);
      const evented = dataset.releaseEvents.some((item) => item.releaseId === release.id);
      const absent = view.notRecorded.map((note) => note.id);

      expect(view.availability.length > 0, release.id).toBe(deployed);
      expect(view.history.length > 0, release.id).toBe(evented);
      expect(absent.includes('availability'), release.id).toBe(!deployed);
      expect(absent.includes('history'), release.id).toBe(!evented);

      // No release carries a sourced price, so this one absence is universal.
      expect(view.pricing, release.id).toEqual([]);
      expect(absent, release.id).toContain('pricing');

      if (deployed) deployedCount += 1;
      if (evented) eventedCount += 1;
      if (!deployed && !evented) bareCount += 1;
    }

    // Both branches must actually be taken. Without these, every assertion in
    // the loop is satisfied by a dataset that only ever reaches one of them.
    expect(deployedCount).toBeGreaterThan(0);
    expect(eventedCount).toBeGreaterThan(0);
    expect(bareCount).toBeGreaterThan(0);
  });

  it('still numbers the remaining sections without a gap', () => {
    for (const release of dataset.releases) {
      const view = realView(release.id);
      const numbers = view.sections.filter((s) => s.present).map((s) => s.number);
      expect(numbers).toEqual(numbers.map((_, index) => String(index + 1).padStart(2, '0')));
    }
  });

  it('builds a passport for every release the route generates', () => {
    const paths = modelStaticPaths();
    // Derived from the dataset, never written down: a hardcoded count is correct
    // until the next data merge and then it is a lie nobody notices.
    expect(paths).toHaveLength(dataset.releases.length);

    for (const path of paths) {
      const view = buildModelPassport(dataset, path.props.releaseId, BASE, TODAY);
      expect(view.canonicalRoute).toBe(modelRoute(BASE, path.params.slug));
      expect(view.sources.length).toBeGreaterThan(0);
      expect(view.summary.length).toBeGreaterThan(0);
    }
  });

  it('renders an identity record for every release with no unknown required field', () => {
    for (const release of dataset.releases) {
      const view = realView(release.id);
      const unknownIdentity = view.identityFacts.filter((entry) => entry.unknown);
      expect(unknownIdentity, `${release.slug} identity should be complete`).toEqual([]);
    }
  });
});

describe('unknown values stay explicit rather than being smoothed over', () => {
  it('marks an unrecorded technical limit as unknown instead of omitting it', () => {
    const view = fixtureView(SPARSE_RELEASE_ID);
    const contextWindow = view.technicalFacts.find((entry) => entry.term === 'Context window');

    expect(contextWindow).toBeDefined();
    expect(contextWindow?.unknown).toBe(true);
    expect(contextWindow?.value).toMatch(/not recorded/i);
  });

  it('states a recorded limit with its unit', () => {
    const view = fixtureView(COMPLETE_RELEASE_ID);
    const contextWindow = view.technicalFacts.find((entry) => entry.term === 'Context window');
    const parameters = view.technicalFacts.find((entry) => entry.term === 'Parameters');

    expect(contextWindow?.unknown).toBe(false);
    expect(contextWindow?.value).toMatch(/tokens/);
    expect(parameters?.value).toMatch(/120B total, 12B active/);
  });

  it('keeps API identifiers separate from display names', () => {
    const complete = fixtureView(COMPLETE_RELEASE_ID);
    const sparse = fixtureView(SPARSE_RELEASE_ID);

    expect(complete.apiAliases).toEqual(['complete-model-2', 'complete-model-2-2026-02-10']);
    expect(complete.otherNames).toEqual(['Example Complete Model 2']);
    expect(sparse.apiAliases).toEqual([]);
    // Canonical name equals display name here, so it is not repeated back.
    expect(sparse.otherNames).toEqual([]);
  });
});

describe('change history', () => {
  it('orders events oldest first regardless of record order', () => {
    const view = fixtureView(COMPLETE_RELEASE_ID);
    expect(view.history.map((row) => row.typeLabel)).toEqual([
      'Announced',
      'Generally available',
    ]);
  });

  it('prints each event at the precision its source stated', () => {
    const view = fixtureView(COMPLETE_RELEASE_ID);
    expect(view.history[0]?.date).toBe('Feb 10, 2026');
    // Stated as a month, so no day reaches the page.
    expect(view.history[1]?.date).toBe('Mar 2026');
  });

  it('carries a source on every event', () => {
    const view = fixtureView(COMPLETE_RELEASE_ID);
    for (const row of view.history) expect(row.sources.length).toBeGreaterThan(0);
  });
});

describe('build failures are loud', () => {
  it('refuses an unknown release', () => {
    expect(() => fixtureView('no-such-release')).toThrow(PassportError);
  });

  it('refuses a release whose family is missing', () => {
    const broken = {
      ...passportFixtures,
      families: passportFixtures.families.filter((family) => family.id !== 'sparse-family'),
    };
    expect(() => buildModelPassport(broken, SPARSE_RELEASE_ID, BASE, FIXTURE_TODAY))
      .toThrow(/missing family/);
  });

  it('refuses a release whose organization is missing', () => {
    const broken = {
      ...passportFixtures,
      organizations: passportFixtures.organizations.filter((org) => org.id !== 'example-lab'),
    };
    expect(() => buildModelPassport(broken, SPARSE_RELEASE_ID, BASE, FIXTURE_TODAY))
      .toThrow(/missing organization/);
  });
});

describe('the passport carries the Model DNA strip (issue #37)', () => {
  it('builds an ordered strip on every view', () => {
    const view = fixtureView(COMPLETE_RELEASE_ID);
    const expected = MODEL_DNA_DIMENSIONS.map((dimension) => dimension.id);

    expect(view.dna.segments.map((segment) => segment.id)).toEqual(expected);
    expect(view.dna.headingId).toBe('model-dna-title');
  });

  it('keeps the strip in step with the identity facts it summarises', () => {
    // The strip is a second reading of identity, so a disagreement between the
    // two would be the passport contradicting itself on one page. The creator is
    // compared through `organizationLabel`, which is this repository's single
    // rule for which recorded name is displayed -- comparing against `name`
    // directly would assert the strip breaks that rule.
    const view = fixtureView(COMPLETE_RELEASE_ID);
    const dnaValue = (id: string) =>
      view.dna.segments.find((segment) => segment.id === id)?.value;

    expect(dnaValue('creator')).toBe(organizationLabel(view.organization));
    expect(dnaValue('family')).toBe(view.family.name);
  });

  it('marks weights unrecorded where the release carries no licence record', () => {
    const view = fixtureView(SPARSE_RELEASE_ID);
    const weights = view.dna.segments.find((segment) => segment.id === 'weights');

    expect(weights?.recorded).toBe(false);
    expect(weights?.value).toBe('Not recorded');
  });

  it('renders the same nine dimensions for every release on the real site', () => {
    const expected = MODEL_DNA_DIMENSIONS.map((dimension) => dimension.id);
    for (const release of dataset.releases) {
      expect(realView(release.id).dna.segments.map((segment) => segment.id)).toEqual(expected);
    }
  });
});