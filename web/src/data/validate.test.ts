import { describe, expect, it } from 'vitest';
import { precisionOf } from './partial-date';
import { rawDataset } from './raw';
import { validateDataset } from './validate';

function copyDataset() {
  return structuredClone(rawDataset);
}

/** The raw dataset as loose records, so a test can break an invariant on purpose. */
function mutableDataset(): Record<string, any> {
  return copyDataset() as Record<string, any>;
}

function findRelease(input: Record<string, any>, predicate: (release: any) => boolean): any {
  const match = (input.releases as any[]).find(predicate);
  if (!match) throw new Error('seed data no longer exercises this invariant');
  return match;
}

/**
 * Every source id in `input` published by the OSI, derived from the input rather
 * than listed here so that a renamed or newly added OSI source is still stripped
 * by the tests that mutate against this rule. Empty is a hard error: a test that
 * removes nothing would pass whatever the validator did.
 */
function osiPublishedSourceIds(input: Record<string, any>): Set<string> {
  const ids = new Set<string>(
    (input.sources as any[])
      .filter((source) => source.publisherId === 'open-source-initiative')
      .map((source) => source.id as string),
  );
  if (ids.size === 0) throw new Error('seed data no longer carries a source published by the OSI');
  return ids;
}

describe('validateDataset', () => {
  it('accepts the source-backed seed dataset', () => {
    const dataset = validateDataset(copyDataset());
    const releaseIds = new Set(dataset.releases.map((release) => release.id));

    // Named rather than counted, so deleting a record fails loudly while adding
    // one does not force an unrelated edit to this test.
    for (const expected of [
      'openai-gpt-4-1-2025-04-14',
      'anthropic-claude-fable-5',
      'google-gemini-2-5-pro',
      'meta-llama-4-scout',
    ]) {
      expect(releaseIds).toContain(expected);
    }

    // Not enforced by validateDataset, which only checks that referenced sources
    // exist and never the reverse. An unreferenced source is dead provenance.
    const cited = new Set<string>();
    for (const record of [...dataset.organizations, ...dataset.families, ...dataset.releases]) {
      for (const sourceId of record.sourceIds) cited.add(sourceId);
    }
    // Benchmark definitions and their results are provenance-bearing records too:
    // each cites the benchmark owner or the model card the score was read from.
    for (const record of [...dataset.benchmarks, ...dataset.benchmarkResults]) {
      for (const sourceId of record.sourceIds) cited.add(sourceId);
    }
    // Publishers cite sources for their controlling-company (ownership) facts.
    for (const publisher of dataset.publishers) {
      for (const sourceId of publisher.control?.sourceIds ?? []) cited.add(sourceId);
    }
    // A usage observation is the only citation its sources have when the figure
    // comes from a platform operator rather than the creator.
    for (const observation of dataset.usageObservations) {
      for (const sourceId of observation.sourceIds) cited.add(sourceId);
    }
    // Products, serving platforms, deployments and release events carry the
    // provenance for the facts that are deliberately not model facts: what a
    // product is, who operates a platform, where a model can be deployed, and
    // when its availability changed. A platform operator's own page is often
    // cited here and nowhere else, precisely because it is not evidence of
    // authorship and so may not be cited by any creator, family or release.
    for (const record of [
      ...dataset.products,
      ...dataset.servingPlatforms,
      ...dataset.deployments,
      ...dataset.releaseEvents,
    ]) {
      for (const sourceId of record.sourceIds) cited.add(sourceId);
    }
    const orphaned = dataset.sources
      .map((source) => source.id)
      .filter((id) => !cited.has(id));

    expect(orphaned).toEqual([]);
  });

  it('rejects a one-sided sibling relationship', () => {
    const input = mutableDataset();
    const sibling = findRelease(input, (release) => release.siblingIds?.length > 0);
    const partner = findRelease(input, (release) => release.id === sibling.siblingIds[0]);
    partner.siblingIds = partner.siblingIds.filter((id: string) => id !== sibling.id);

    expect(() => validateDataset(input)).toThrow(/sibling relationship with .* is not reciprocal/);
  });

  it('rejects a successor in another family', () => {
    const input = mutableDataset();
    const source = findRelease(input, (release) => release.successorIds?.length > 0);
    const outsider = findRelease(input, (release) => release.familyId !== source.familyId);
    source.successorIds = [outsider.id];

    expect(() => validateDataset(input)).toThrow(/must stay within family/);
  });

  it('allows derivedFromIds to cross family boundaries', () => {
    const input = mutableDataset();
    // Constructed rather than found: no seed release claims a derivation, because
    // no source states one. The rule still has to hold.
    const derived = findRelease(input, (release) => release.id === 'anthropic-claude-mythos-5');
    const outsider = findRelease(input, (release) => release.familyId !== derived.familyId);
    derived.derivedFromIds = [outsider.id];

    const parsed = validateDataset(input);
    const kept = parsed.releases.find((release) => release.id === 'anthropic-claude-mythos-5');
    expect(kept?.derivedFromIds).toEqual([outsider.id]);
  });

  it('rejects an open-weight release without downloadable weights', () => {
    const input = mutableDataset();
    const openWeight = findRelease(input, (release) => release.accessType === 'open-weight');
    openWeight.license.weightsDownloadable = false;

    expect(() => validateDataset(input)).toThrow(/contradicts an open-weight access type/);
  });

  it('rejects an OSI-approved licence claim that pins no licence', () => {
    const input = mutableDataset();
    const openWeight = findRelease(input, (release) => release.accessType === 'open-weight');
    openWeight.license = {
      name: openWeight.license.name,
      weightsDownloadable: true,
      osiApproved: true,
    };

    expect(() => validateDataset(input)).toThrow(/must identify the licence with an spdxId or a licence URL/);
  });

  // The `osiApproved` evidence rule, decided in #481 and stated beside
  // `licenseSchema`. `findRelease` throws when its predicate matches nothing, so
  // each of these fails loudly rather than passing vacuously if the seed data
  // stops carrying the shape it reaches for.
  it('rejects a licence claim that cites no source published by OSI', () => {
    const input = mutableDataset();
    const osiSourceIds = osiPublishedSourceIds(input);
    const licensed = findRelease(input, (release) => Boolean(release.license));
    const before = licensed.sourceIds.length;
    licensed.sourceIds = licensed.sourceIds.filter((id: string) => !osiSourceIds.has(id));
    // Without this the filter could be a no-op, and the throw below would prove
    // nothing about the rule.
    expect(licensed.sourceIds.length).toBeLessThan(before);

    expect(() => validateDataset(input)).toThrow(
      /records license\.osiApproved without citing a source published by the Open Source Initiative/,
    );
  });

  it('requires an OSI source for osiApproved: false, not only for true', () => {
    const input = mutableDataset();
    const osiSourceIds = osiPublishedSourceIds(input);
    const licensed = findRelease(input, (release) => release.license?.osiApproved === false);
    const before = licensed.sourceIds.length;
    licensed.sourceIds = licensed.sourceIds.filter((id: string) => !osiSourceIds.has(id));
    expect(licensed.sourceIds.length).toBeLessThan(before);

    expect(() => validateDataset(input)).toThrow(
      /records license\.osiApproved without citing a source published by the Open Source Initiative/,
    );
  });

  it('asks nothing of a release that records no licence at all', () => {
    const input = mutableDataset();
    const osiSourceIds = osiPublishedSourceIds(input);
    const unlicensed = findRelease(input, (release) => !release.license);
    unlicensed.sourceIds = unlicensed.sourceIds.filter((id: string) => !osiSourceIds.has(id));

    expect(() => validateDataset(input)).not.toThrow();
  });

  it('rejects a duplicate release id', () => {
    const input = copyDataset();
    input.releases[1].id = input.releases[0].id;

    expect(() => validateDataset(input)).toThrow(/duplicate release id/);
  });

  it('refuses to let an API alias become a second release', () => {
    // Positive control: the unmutated dataset validates, so a pass below cannot
    // come from the dataset being broken to begin with.
    expect(() => validateDataset(copyDataset())).not.toThrow();

    const input = mutableDataset();
    // The mistake this guards against is a platform alias promoted into a release
    // of its own. An alias resolves to a model that is already recorded, so a
    // second record claiming it double-counts one model under a name its creator
    // never released separately.
    const owner = findRelease(input, (release) => release.apiAliases?.length > 1);
    const alias: string = owner.apiAliases[1];

    (input.releases as any[]).push({
      ...structuredClone(owner),
      id: `${owner.id}-alias`,
      slug: `${owner.slug}-alias`,
      canonicalName: alias,
      displayName: alias,
      featured: false,
      apiAliases: [alias],
      predecessorIds: [],
      successorIds: [],
      siblingIds: [],
    });

    const quoted = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(() => validateDataset(input)).toThrow(
      new RegExp(`duplicate API alias value "${quoted}"`),
    );
  });

  it('rejects an impossible release date', () => {
    const input = copyDataset();
    input.releases[0].releaseDate = '2025-02-30';

    expect(() => validateDataset(input)).toThrow(/must be a real date written as/);
  });

  it('rejects a broken family reference', () => {
    const input = copyDataset();
    input.releases[0].familyId = 'missing-family';

    expect(() => validateDataset(input)).toThrow(/familyId references missing id/);
  });

  it('rejects a broken source reference', () => {
    const input = copyDataset();
    input.releases[0].sourceIds = ['missing-source'];

    expect(() => validateDataset(input)).toThrow(/sourceIds references missing id/);
  });

  it('requires a primary source for featured records', () => {
    const input = copyDataset();
    for (const source of input.sources) source.type = 'independent-evaluation';

    expect(() => validateDataset(input)).toThrow(/featured release .* requires a primary source/);
  });

  /**
   * Adds a family that no release points at, by cloning a live one and changing
   * only its id and slug. Cloning keeps every other rule satisfied by
   * construction — the organization resolves, the sources resolve, the dates are
   * real and agree with the recorded precision — so a refusal is attributable to
   * the missing release rather than to a fixture broken in several ways at once.
   *
   * `attachRelease` is the control arm: identical setup, one release added, and
   * the opposite verdict expected.
   */
  function withEmptyFamily({ attachRelease = false } = {}) {
    const input = mutableDataset();
    const donorFamily = input.families.find(
      (family: any) => input.releases.some((release: any) => release.familyId === family.id),
    );
    if (!donorFamily) throw new Error('seed data no longer carries a family with a release to clone');
    const donorRelease = findRelease(input, (release) => release.familyId === donorFamily.id);

    input.families.push({ ...donorFamily, id: 'probe-empty-family', slug: 'probe-empty-family' });
    if (attachRelease) {
      input.releases.push({
        ...donorRelease,
        id: 'probe-empty-family-release',
        slug: 'probe-empty-family-release',
        familyId: 'probe-empty-family',
        apiAliases: [],
        // Lineage stripped: a clone keeping its donor's edges would be judged on
        // those edges too, and this fixture is about one thing.
        predecessorIds: [],
        successorIds: [],
        siblingIds: [],
        derivedFromIds: [],
      });
    }

    // What the setup claims about itself, checked rather than assumed: a probe
    // whose family quietly acquired a release would produce the control's
    // result while reading as the probe's.
    const pointedAt = new Set(input.releases.map((release: any) => release.familyId));
    expect(pointedAt.has('probe-empty-family')).toBe(attachRelease);

    return input;
  }

  it('refuses a family that no release belongs to', () => {
    // #554. The dataset cannot say "announced but unreleased" — `lifecycleStatus`
    // has no such member — so a family holding nothing is a data error, and the
    // build refuses it rather than letting `/` render a heading above an empty
    // list while `/tree/` silently drops the same family.
    //
    // Refusing here rather than filtering in each consumer is what keeps a
    // printed count honest: `pages/index.astro` prints `dataset.families.length`
    // beside a hierarchy that renders only families holding releases, and those
    // two agree only because of this rule.
    expect(() => validateDataset(withEmptyFamily())).toThrow(/family probe-empty-family has no releases/);
  });

  it('accepts the same family once one release belongs to it, so the rule is not "a new family fails"', () => {
    expect(() => validateDataset(withEmptyFamily({ attachRelease: true }))).not.toThrow();
  });
});

describe('benchmark seed corpus', () => {
  it('accepts the source-backed benchmark corpus', () => {
    const data = validateDataset(copyDataset());

    // Named rather than counted, so deleting one of these named records fails
    // loudly while adding one does not force an unrelated edit here. The other
    // results are covered structurally, not asserted by name.
    const benchmarkIds = new Set(data.benchmarks.map((benchmark) => benchmark.id));
    for (const expected of ['mmlu-pro', 'gpqa-diamond', 'livecodebench', 'mmmu']) {
      expect(benchmarkIds).toContain(expected);
    }

    const resultIds = new Set(data.benchmarkResults.map((result) => result.id));
    for (const expected of ['llama-4-scout-mmlu-pro', 'llama-4-maverick-gpqa-diamond']) {
      expect(resultIds).toContain(expected);
    }

    // A spot-checked value read from the model card, kept honest against silent
    // drift, together with the official/independent distinction the schema draws.
    const maverickMmlu = data.benchmarkResults.find((result) => result.id === 'llama-4-maverick-mmlu-pro');
    expect(maverickMmlu?.score).toBe(80.5);
    expect(maverickMmlu?.resultType).toBe('official');

    // The result's unit must match its benchmark's declared unit.
    const mmluPro = data.benchmarks.find((benchmark) => benchmark.id === 'mmlu-pro');
    expect(maverickMmlu?.unit).toBe(mmluPro?.metricUnit);
  });

  it('rejects a duplicate benchmark/version/model/setup result in the seed data', () => {
    const input = mutableDataset();
    const original = input.benchmarkResults[0];
    input.benchmarkResults.push({ ...original, id: `${original.id}-copy` });

    expect(() => validateDataset(input)).toThrow(/duplicates an existing result/);
  });

  // Negative fixture: a result whose source field is emptied must fail. Provenance
  // is mandatory, so a score with no source can never load.
  it('rejects a benchmark result with no source', () => {
    const input = mutableDataset();
    input.benchmarkResults[0].sourceIds = [];

    expect(() => validateDataset(input)).toThrow(/benchmarkResults\.\d+\.sourceIds/);
  });

  // Negative fixture: a result missing a required configuration field must fail
  // rather than load with a silent default.
  it('rejects a benchmark result missing required configuration', () => {
    const input = mutableDataset();
    delete input.benchmarkResults[0].benchmarkVersion;

    expect(() => validateDataset(input)).toThrow(/benchmarkResults\.\d+\.benchmarkVersion/);
  });

  // Negative fixture: a benchmark definition without a source must fail.
  it('rejects a benchmark definition with no source', () => {
    const input = mutableDataset();
    input.benchmarks[0].sourceIds = [];

    expect(() => validateDataset(input)).toThrow(/benchmarks\.\d+\.sourceIds/);
  });
});

/** The seed data plus one valid record of every entity type the schema defines. */
function extendedDataset(): Record<string, any> {
  const base = copyDataset();
  const release = base.releases[0].id;

  return {
    ...base,
    products: [{
      id: 'chatgpt',
      slug: 'chatgpt',
      name: 'ChatGPT',
      organizationId: 'openai',
      description: 'A consumer product that is not the same entity as the model serving it.',
      modelSelection: 'routed',
      releaseIds: [],
      effectiveFrom: '2025-04-14',
      sourceIds: ['openai-gpt-4-1-announcement'],
      verifiedAt: '2026-08-14',
    }],
    servingPlatforms: [{
      id: 'openai-api',
      slug: 'openai-api',
      name: 'OpenAI API',
      organizationId: 'openai',
      type: 'first-party-api',
      website: 'https://platform.openai.com/',
      sourceIds: ['openai-gpt-4-1-docs'],
      verifiedAt: '2026-08-14',
    }],
    deployments: [{
      id: 'gpt-4-1-openai-api',
      releaseId: release,
      platformId: 'openai-api',
      deliveryMode: 'hosted-api',
      apiIdentifier: 'gpt-4.1',
      regions: [],
      effectiveFrom: '2025-04-14',
      sourceIds: ['openai-gpt-4-1-docs'],
      verifiedAt: '2026-08-14',
    }],
    pricing: [{
      id: 'gpt-4-1-openai-api-2025-04-14',
      deploymentId: 'gpt-4-1-openai-api',
      currency: 'USD',
      unit: 'per-1m-tokens',
      rates: { input: 2, cachedInput: 0.5, output: 8 },
      effectiveFrom: '2025-04-14',
      sourceIds: ['openai-gpt-4-1-announcement'],
      verifiedAt: '2026-08-14',
    }],
    benchmarks: [{
      id: 'swe-bench-verified',
      slug: 'swe-bench-verified',
      name: 'SWE-bench Verified',
      domain: 'coding',
      owner: 'OpenAI',
      metric: 'tasks resolved',
      metricUnit: 'percent',
      direction: 'higher-is-better',
      sourceIds: ['openai-gpt-4-1-announcement'],
      verifiedAt: '2026-08-14',
    }],
    benchmarkResults: [{
      id: 'gpt-4-1-swe-bench-verified',
      benchmarkId: 'swe-bench-verified',
      benchmarkVersion: '2025-04',
      releaseId: release,
      score: 54.6,
      unit: 'percent',
      evaluationDate: '2025-04',
      resultType: 'official',
      sourceIds: ['openai-gpt-4-1-announcement'],
      verifiedAt: '2026-08-14',
    }],
    releaseEvents: [{
      id: 'gpt-4-1-announced',
      releaseId: release,
      type: 'announced',
      date: '2025-04-14',
      datePrecision: 'day',
      note: 'Introduced in the API alongside its sibling variants.',
      sourceIds: ['openai-gpt-4-1-announcement'],
      verifiedAt: '2026-08-14',
    }],
  };
}

describe('extended entity invariants', () => {
  it('accepts one valid record of every entity type', () => {
    const data = validateDataset(extendedDataset());

    expect([
      data.products.length,
      data.servingPlatforms.length,
      data.deployments.length,
      data.pricing.length,
      data.benchmarks.length,
      data.benchmarkResults.length,
      data.releaseEvents.length,
    ]).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it('rejects a product that claims a fixed model but names none', () => {
    const input = extendedDataset();
    input.products[0].modelSelection = 'fixed';

    expect(() => validateDataset(input)).toThrow(/claims a fixed model but names no release/);
  });

  it('rejects a deployment on a missing serving platform', () => {
    const input = extendedDataset();
    input.deployments[0].platformId = 'missing-platform';

    expect(() => validateDataset(input)).toThrow(/platformId references missing id/);
  });

  it('rejects a pricing record with no rate', () => {
    const input = extendedDataset();
    input.pricing[0].rates = {};

    expect(() => validateDataset(input)).toThrow(/states no rate/);
  });

  it('rejects a negative price', () => {
    const input = extendedDataset();
    input.pricing[0].rates.input = -1;

    expect(() => validateDataset(input)).toThrow(/rates.input/);
  });

  it('rejects an effective range that ends before it starts', () => {
    const input = extendedDataset();
    input.pricing[0].effectiveTo = '2025-04-13';

    expect(() => validateDataset(input)).toThrow(/ends before it takes effect/);
  });

  it('rejects a benchmark result whose unit contradicts its benchmark', () => {
    const input = extendedDataset();
    input.benchmarkResults[0].unit = 'elo';

    expect(() => validateDataset(input)).toThrow(/does not match benchmark/);
  });

  it('rejects two results for the same model and setup', () => {
    const input = extendedDataset();
    input.benchmarkResults.push({ ...input.benchmarkResults[0], id: 'duplicate-setup' });

    expect(() => validateDataset(input)).toThrow(/duplicates an existing result/);
  });

  it('rejects a release event whose date contradicts its stated precision', () => {
    const input = extendedDataset();
    input.releaseEvents[0].datePrecision = 'month';

    expect(() => validateDataset(input)).toThrow(/does not match precision/);
  });

  it('accepts a partial date at month precision', () => {
    const input = extendedDataset();
    input.releaseEvents[0].date = '2025-04';
    input.releaseEvents[0].datePrecision = 'month';

    expect(validateDataset(input).releaseEvents[0].date).toBe('2025-04');
  });

  it('rejects an impossible partial date', () => {
    const input = extendedDataset();
    input.releaseEvents[0].date = '2025-13';
    input.releaseEvents[0].datePrecision = 'month';

    expect(() => validateDataset(input)).toThrow(/must be a real date/);
  });

  it('rejects an open-weight claim with no licence', () => {
    const input = extendedDataset();
    input.releases[0].accessType = 'open-weight';

    expect(() => validateDataset(input)).toThrow(/required when a release claims downloadable weights/);
  });

  it('rejects an open-weight claim whose licence withholds the weights', () => {
    const input = extendedDataset();
    input.releases[0].accessType = 'open-weight';
    input.releases[0].license = {
      name: 'Custom community licence',
      url: 'https://example.com/licence',
      weightsDownloadable: false,
      osiApproved: false,
    };

    expect(() => validateDataset(input)).toThrow(/contradicts an open-weight access type/);
  });

  it('rejects an open-source claim that pins no licence', () => {
    const input = extendedDataset();
    input.releases[0].license = {
      name: 'Apache 2.0',
      weightsDownloadable: true,
      osiApproved: true,
    };
    input.releases[0].sourceIds.push('osi-license-index');

    expect(() => validateDataset(input)).toThrow(/must identify the licence with an spdxId or a licence URL/);
  });

  it('separates downloadable weights from an open-source licence', () => {
    const input = extendedDataset();
    input.releases[0].accessType = 'open-weight';
    input.releases[0].license = {
      name: 'Custom community licence',
      url: 'https://example.com/licence',
      weightsDownloadable: true,
      osiApproved: false,
    };
    input.releases[0].sourceIds.push('osi-license-index');

    expect(validateDataset(input).releases[0].license?.osiApproved).toBe(false);
  });

  it('rejects a derivation that points at a missing release', () => {
    const input = extendedDataset();
    input.releases[0].derivedFromIds = ['missing-release'];

    expect(() => validateDataset(input)).toThrow(/derivedFromIds references missing id/);
  });
});

describe('partial dates on family and release dates', () => {
  /**
   * A creator whose sources only give a month is the case this schema change
   * exists for, so it is checked end to end rather than field by field: a family
   * and one of its releases are both coarsened, and the whole dataset must still
   * validate with the values intact.
   */
  it('accepts a month-precision family and release', () => {
    const input = mutableDataset();
    const family = input.families[0];
    const release = findRelease(input, (candidate) => candidate.familyId === family.id);

    family.firstReleaseDate = family.firstReleaseDate.slice(0, 7);
    family.datePrecision = 'month';
    release.releaseDate = release.releaseDate.slice(0, 7);
    release.datePrecision = 'month';

    const dataset = validateDataset(input);

    expect(dataset.families.find((entry) => entry.id === family.id)!.firstReleaseDate)
      .toBe(family.firstReleaseDate);
    expect(dataset.releases.find((entry) => entry.id === release.id)!.releaseDate)
      .toBe(release.releaseDate);
  });

  it('accepts a year-precision family and release', () => {
    const input = mutableDataset();
    const family = input.families[0];
    const release = findRelease(input, (candidate) => candidate.familyId === family.id);

    family.firstReleaseDate = family.firstReleaseDate.slice(0, 4);
    family.datePrecision = 'year';
    release.releaseDate = release.releaseDate.slice(0, 4);
    release.datePrecision = 'year';

    expect(validateDataset(input).families.find((entry) => entry.id === family.id)!.datePrecision)
      .toBe('year');
  });

  /*
   * The invented-day path, closed from both directions. Widening the type is
   * what makes a month recordable; these two are what stop the old workaround --
   * invent a day, then label it `month` -- from remaining available.
   */
  it('rejects a release that claims month precision while carrying a day', () => {
    const input = mutableDataset();
    input.releases[0].datePrecision = 'month';

    expect(() => validateDataset(input)).toThrow(/does not match precision/);
  });

  it('rejects a family that claims month precision while carrying a day', () => {
    const input = mutableDataset();
    input.families[0].datePrecision = 'month';

    expect(() => validateDataset(input)).toThrow(/does not match precision/);
  });

  it('rejects a release that claims day precision while carrying only a month', () => {
    const input = mutableDataset();
    input.releases[0].releaseDate = input.releases[0].releaseDate.slice(0, 7);

    expect(() => validateDataset(input)).toThrow(/does not match precision/);
  });

  it('rejects a family that claims day precision while carrying only a month', () => {
    const input = mutableDataset();
    input.families[0].firstReleaseDate = input.families[0].firstReleaseDate.slice(0, 7);

    expect(() => validateDataset(input)).toThrow(/does not match precision/);
  });

  it('rejects an impossible partial family date', () => {
    const input = mutableDataset();
    input.families[0].firstReleaseDate = '2025-13';
    input.families[0].datePrecision = 'month';

    expect(() => validateDataset(input)).toThrow(/must be a real date written as/);
  });

  /**
   * Criterion 4. Every record the backfill touched keeps the date it already
   * had and is marked `day` -- because a day is what those sources gave, not
   * because `day` is a convenient default for a newly required field. The
   * counts are floors so that adding a record does not force an edit here,
   * while deleting one fails.
   *
   * That the *values* are unchanged is a property of the diff rather than of a
   * test: `families.json` gains lines and loses none, and `releases.json` is not
   * touched at all.
   *
   * A record whose source genuinely gave less than a day is the capability this
   * change exists to provide, so such records are enumerated here rather than
   * forbidden -- scanning the live dataset for `day` alone would have made the
   * first honest partial date fail, which is the opposite of the intent above.
   * The enumeration is the assertion and it stays exact: an unlisted non-day
   * record still fails, so a backfilled `day` quietly downgraded to `month`, or
   * a `year` stamped on a record whose source gave more, is still caught.
   */
  it('leaves every committed date at day precision, agreeing with its value', () => {
    const datesCoarserThanADay = [
      {
        id: 'cohere-command-a',
        precision: 'month',
        // Cohere dates the family only through its earliest member's published
        // identifier, `command-a-03-2025`. No approved origin states a day, so
        // recording one would be the invention this field exists to prevent.
      },
      {
        id: 'zhipu-ai-glm-4-5',
        precision: 'month',
        // GLM-4.5 launched at WAIC Shanghai in late July 2025; no fetchable
        // primary from Zhipu states the calendar day, so month precision is the
        // honest floor rather than an invented day.
      },
      {
        id: 'zhipu-ai-glm-4-5-air',
        precision: 'month',
        // The Air variant shipped in the same GLM-4.5 launch; same reasoning.
      },
    ];

    const dataset = validateDataset(copyDataset());
    const dated = [
      ...dataset.families.map((family) => ({
        id: family.id,
        value: family.firstReleaseDate,
        precision: family.datePrecision,
      })),
      ...dataset.releases.map((release) => ({
        id: release.id,
        value: release.releaseDate,
        precision: release.datePrecision,
      })),
    ];

    expect(dataset.families.length).toBeGreaterThanOrEqual(26);
    expect(dataset.releases.length).toBeGreaterThanOrEqual(51);

    const notDay = dated.filter((entry) => entry.precision !== 'day');
    expect(notDay.map(({ id, precision }) => ({ id, precision }))).toEqual(datesCoarserThanADay);

    const disagreeing = dated.filter((entry) => precisionOf(entry.value) !== entry.precision);
    expect(disagreeing).toEqual([]);
  });
});
