import { describe, expect, it } from 'vitest';
import { datePrecision, familyDatePrecision, familySchema } from './schema';
import { rawDataset } from './raw';
import { validateDataset } from './validate';
import { buildModelTree } from '../lib/model-tree';
import { familyFirstReleaseLine, formatFamilyFirstRelease } from '../lib/format';

/**
 * The decision recorded in
 * `docs/adr/0012-a-family-first-release-date-may-be-explicitly-unstated.md`:
 * a family may record that no primary source states its first release date at
 * any precision, by omitting `firstReleaseDate` and declaring
 * `datePrecision: 'unstated'` beside it.
 *
 * The record below is Cohere's Rerank family, which is the input this exists to
 * unblock rather than an invented example. abdeslam-menacere/ModelTree#740
 * investigated three candidate dates for it -- the v2 announcement, the v3.5
 * changelog entry, and the docs page's own publication -- and rejected all
 * three: each dates a *release* or a page, and none is Cohere stating when the
 * family began. The family was dropped from the dataset rather than published
 * with one of them, and its four records were preserved in
 * abdeslam-menacere/ModelTree#807.
 *
 * Three properties are proved here, because a member that only satisfies the
 * first two is a hole rather than a claim:
 *
 * 1. absence stays a hard failure -- omitting the date without saying so is
 *    still refused, in both this schema and the dataset gate;
 * 2. the contradiction is guarded -- `unstated` beside a date is refused;
 * 3. the value renders as its own words, because an unstated date that renders
 *    as a blank is indistinguishable from the dropped family this replaces.
 */

const unstatedFamily = {
  id: 'cohere-rerank',
  slug: 'cohere-rerank',
  organizationId: 'cohere',
  name: 'Rerank',
  description:
    'Cohere’s reranking models, which reorder a candidate list of documents against a query.',
  categories: ['embedding-reranking'],
  datePrecision: 'unstated',
  status: 'current',
  sourceIds: ['cohere-rerank-docs'],
  verifiedAt: '2026-08-30',
};

describe('a family first release date may be explicitly unstated', () => {
  it('adds unstated to the family vocabulary without touching the release one (ADR 0012)', () => {
    // The scope of the member is the decision, so it is asserted rather than
    // described. A release is an event, and a record of an event nobody can
    // date at all is not a release -- widening the shared vocabulary would have
    // made that state expressible everywhere a date appears, including in the
    // ordering that `model-tree.ts` and `timeline.ts` build from release dates.
    expect(familyDatePrecision.options).toEqual(['year', 'month', 'day', 'unstated']);
    expect(datePrecision.options).toEqual(['year', 'month', 'day']);
  });

  it('accepts a family whose first release date no source states', () => {
    const parsed = familySchema.parse(unstatedFamily);
    expect(parsed.firstReleaseDate).toBeUndefined();
    expect(parsed.datePrecision).toBe('unstated');
  });

  it('refuses a family that omits the date without saying so', () => {
    // Property 1, and the reason this is not simply `.optional()`. An absent
    // field says nothing about whether anyone looked; the point of the pair is
    // that the absence has to be claimed. Every stated precision refuses it,
    // not just the default one, so the guard cannot be stepped around by
    // declaring a coarser reading of a date that is not there.
    for (const precision of ['year', 'month', 'day'] as const) {
      const result = familySchema.safeParse({ ...unstatedFamily, datePrecision: precision });
      expect(result.success).toBe(false);
      const issue = result.success
        ? undefined
        : result.error.issues.find((candidate) => candidate.path.join('.') === 'firstReleaseDate');
      expect(issue?.message).toContain('is required unless datePrecision is "unstated"');
    }
  });

  it('refuses a family that omits both the date and the precision', () => {
    // The same property against the laziest possible record. `datePrecision`
    // stays required, so a family cannot reach the unstated state by saying
    // nothing at all -- silence is what the pair exists to make unwritable.
    const { datePrecision: _dropped, ...withoutPrecision } = unstatedFamily;
    const result = familySchema.safeParse(withoutPrecision);
    expect(result.success).toBe(false);
    expect(
      result.success
        ? []
        : result.error.issues.map((issue) => issue.path.join('.')),
    ).toContain('datePrecision');
  });

  it('refuses a family that claims the date is unstated while carrying one', () => {
    // Property 2. A record asserting that no source gives this date, beside a
    // date, has contradicted itself and a reader cannot tell which half to
    // believe. Nothing else in the schema would notice: `partialDate` is happy,
    // and the enum is happy.
    const result = familySchema.safeParse({ ...unstatedFamily, firstReleaseDate: '2024-12-02' });
    expect(result.success).toBe(false);
    const issue = result.success
      ? undefined
      : result.error.issues.find((candidate) => candidate.path.join('.') === 'datePrecision');
    expect(issue?.message).toContain('cannot be unstated when the family records a first release date');
  });

  it('refuses a date basis recorded for a date that is not stated', () => {
    // `dateBasis` says where a recorded date came from. With no date recorded
    // there is nothing for it to describe, so admitting it would let a record
    // cite a basis for a fact it does not state.
    const result = familySchema.safeParse({ ...unstatedFamily, dateBasis: 'platform-repository-created' });
    expect(result.success).toBe(false);
    const issue = result.success
      ? undefined
      : result.error.issues.find((candidate) => candidate.path.join('.') === 'dateBasis');
    expect(issue?.message).toContain('cannot be recorded when no first release date is stated');
  });

  it('renders the unstated date as its own words, never as a blank', () => {
    // Property 3, and the one the other two are for. The state this replaces is
    // a family that is not on the site at all; a rendering that prints nothing
    // puts the reader back there while the dataset believes it has published a
    // claim. So both call sites are asserted, and asserted to be non-empty and
    // distinct from the dated wording rather than merely defined.
    const family = familySchema.parse(unstatedFamily);
    expect(formatFamilyFirstRelease(family)).toBe('Not stated by any source');
    expect(familyFirstReleaseLine(family)).toBe('First release date not stated by any source');

    const dated = familySchema.parse({
      ...unstatedFamily,
      firstReleaseDate: '2024-12-02',
      datePrecision: 'day',
    });
    expect(formatFamilyFirstRelease(dated)).not.toBe(formatFamilyFirstRelease(family));
    expect(familyFirstReleaseLine(dated)).toContain('First released');
  });

  it('keeps an unstated family in the built tree (#441, #554)', () => {
    // The render trap this repository has fallen into twice: a family that
    // validates, passes every gate, and is then dropped by `buildModelTree`, so
    // the dataset believes it published a record the site never shows.
    //
    // Run against the *real* builder over the real dataset, with one family
    // rewritten to the unstated pair -- which is legal, since nothing in the
    // tree reads `firstReleaseDate`; families are ordered by their newest
    // release. A fixture would prove the fixture.
    const mutated = structuredClone(rawDataset) as Record<string, any>;
    const subject = mutated.families[0];
    delete subject.firstReleaseDate;
    delete subject.dateBasis;
    subject.datePrecision = 'unstated';

    const tree = buildModelTree(validateDataset(mutated));
    const familyIds = [...tree.featured, ...tree.others].flatMap(
      (creator) => creator.families.map(({ family }) => family.id),
    );

    // A probe that finds nothing because it is broken looks exactly like one
    // that finds nothing because nothing is wrong, so both controls run in the
    // same invocation as the assertion they are guarding.
    expect(familyIds).toContain(rawDataset.families[1].id); // positive control
    expect(familyIds).not.toContain('zzz-not-a-real-family-id'); // negative control
    expect(familyIds).toContain(subject.id);

    // And it still renders its own words once it is there, which is the
    // difference between appearing in the tree and appearing on the page.
    const built = [...tree.featured, ...tree.others]
      .flatMap((creator) => creator.families)
      .find(({ family }) => family.id === subject.id);
    expect(built).toBeDefined();
    expect(familyFirstReleaseLine(built!.family)).toBe('First release date not stated by any source');
  });

  it('shows Cohere Rerank in the tree the site builds, dateless (#441, #554)', () => {
    // The mutated probe above proves the mechanism; this one proves the record
    // that motivated it, on the real dataset with nothing rewritten. The two
    // are not redundant: a family can survive a synthetic edit and still be
    // dropped for a reason particular to it -- an organization that no branch
    // reaches, a category nothing renders -- which is exactly how #441 and #554
    // shipped families the site never showed.
    const tree = buildModelTree(validateDataset(rawDataset));
    const familyIds = [...tree.featured, ...tree.others].flatMap(
      (creator) => creator.families.map(({ family }) => family.id),
    );

    expect(familyIds).toContain('cohere-command-a'); // positive control
    expect(familyIds).not.toContain('zzz-not-a-real-family-id'); // negative control
    expect(familyIds).toContain('cohere-rerank');

    const built = [...tree.featured, ...tree.others]
      .flatMap((creator) => creator.families)
      .find(({ family }) => family.id === 'cohere-rerank');
    expect(built).toBeDefined();
    expect(built!.family.firstReleaseDate).toBeUndefined();
    expect(built!.family.datePrecision).toBe('unstated');
    expect(familyFirstReleaseLine(built!.family)).toBe('First release date not stated by any source');

    // And the release under it, so the family is not an empty shell on the page.
    expect(built!.releases.map((release) => release.id)).toContain('cohere-rerank-v3-5');
  });

  it('refuses an unstated family through validateDataset as well as the schema', () => {
    // The build boundary, not just the record boundary. `validateDataset` is
    // what every page goes through, and its precision pairing reads the same
    // biconditional -- so a dataset that dropped a date without claiming it is
    // refused there too, with a message naming the family.
    const broken = structuredClone(rawDataset) as Record<string, any>;
    delete broken.families[0].firstReleaseDate;
    delete broken.families[0].dateBasis;

    expect(() => validateDataset(broken)).toThrow(/is required unless datePrecision is "unstated"/);
  });
});
