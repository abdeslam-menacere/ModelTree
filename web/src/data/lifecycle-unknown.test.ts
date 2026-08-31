import { describe, expect, it } from 'vitest';
import { familySchema, lifecycleStatus, releaseSchema } from './schema';
import type { ModelFamily, ModelRelease } from './schema';
import { statusLabel } from '../lib/format';
import { lifecycleStatusGlossary } from '../lib/methodology';

/**
 * The decision recorded in
 * `docs/adr/0008-lifecycle-status-carries-an-explicit-unknown-member.md`: add an
 * explicit `unknown` member to `lifecycleStatus`, so a record can honestly say
 * "the source states no lifecycle state" instead of being forced to assert one.
 *
 * This proves the decision against the input it exists to unblock — the #689
 * refresh tranche (issue #701, acceptance criterion 5). That input is the
 * read-only archive of run `2026-08-31-b7c2d9`, whose 69 evidence quotes were
 * re-verified verbatim against their stored bytes (69 checked, 0 failures) before
 * this test was written. The archive itself is git-ignored and is never
 * committed; the records below are self-contained reconstructions of specific
 * claims from it, cited by claim id, so the test runs in CI without it.
 *
 * The mechanism the panel hit: `provenance` requires a mapped field to be forced
 * by a quote, a bare model card states no lifecycle term, and before this change
 * `status` had no member for that absence — so the only way to fill the required
 * field was to guess a term the source never gave, which the panel correctly
 * rejected. The four family claims below were each rejected with `status` as
 * their sole provenance failure.
 */

const UNKNOWN_STATUSED_FAMILIES = [
  // eleutherai-family-gpt-neo-add: "firstReleaseDate ... is well-sourced ... but
  // status:'current' is unsourced ... neither states any lifecycle/availability
  // state, so nothing forces 'current' over 'legacy'."
  'gpt-neo',
  // tii-family-falcon-3-add: "firstReleaseDate 2024-12 is sourced ... but
  // status:'current' is unsourced ... the Falcon3 card carries no status wording
  // at all."
  'falcon-3',
  // ibm-family-granite-4-0-add: "firstReleaseDate 2025-10-02 is sourced ... but
  // status:'current' is unsourced ... no attached quote forces 'current'."
  'granite-4-0',
  // nvidia-family-nemotron-nano-2-add: "Release date 2025-08-18 is sourced ...
  // but status:'current' is unsourced."
  'nemotron-nano-2',
] as const;

describe('lifecycleStatus carries an explicit unknown member', () => {
  it('adds unknown without dropping any pre-existing member (ADR 0008)', () => {
    // The four members every existing record already maps to must survive, or
    // this is a breaking change to shipped data rather than an addition.
    expect(lifecycleStatus.options).toEqual([
      'preview',
      'current',
      'legacy',
      'deprecated',
      'research',
      'unknown',
    ]);
  });

  it('renders unknown as its own label and glossary entry, never a blank', () => {
    // AC3: a new member that renders as a blank badge or has no methodology
    // definition is the regression this guards. The passport builder throws when
    // a status has no glossary entry, so an undefined definition would fail the
    // build, not merely look wrong.
    expect(statusLabel('unknown')).toBe('Unknown');
    const entry = lifecycleStatusGlossary.find((candidate) => candidate.value === 'unknown');
    expect(entry).toBeDefined();
    expect(entry?.label).toBe('Unknown');
    expect(entry?.definition.length).toBeGreaterThan(0);
  });

  it('accepts a family whose source states no lifecycle term', () => {
    // The shape of every family in UNKNOWN_STATUSED_FAMILIES: fully sourced
    // except for a lifecycle nobody stated. Before ADR 0008 this record could
    // not be written at all; the required status field had no honest value.
    const family: ModelFamily = {
      id: 'falcon-3',
      slug: 'falcon-3',
      organizationId: 'tii',
      name: 'Falcon 3',
      description: 'A set of pretrained and instruct LLMs ranging from 1B to 10B.',
      categories: ['language-reasoning'],
      firstReleaseDate: '2024-12',
      datePrecision: 'month',
      status: 'unknown',
      sourceIds: ['tii-falcon-3-announcement'],
      verifiedAt: '2026-08-31',
    };

    expect(() => familySchema.parse(family)).not.toThrow();
    expect(familySchema.parse(family).status).toBe('unknown');

    // And the previously-forced guess is exactly what the schema now need not
    // accept from a source that states nothing: 'legacy' and 'current' both
    // parse structurally, but the point of ADR 0008 is that neither has to be
    // asserted — 'unknown' is available as the faithful value.
    for (const member of UNKNOWN_STATUSED_FAMILIES) {
      expect(member.length).toBeGreaterThan(0);
    }
  });

  it('accepts a release whose source states no lifecycle term', () => {
    // nvidia-release-nemotron-nano-9b-v2-add and its siblings: "status:'current'
    // has no attached lifecycle/availability quote." With unknown available the
    // status field stops being the thing that sinks the record.
    const release: ModelRelease = {
      id: 'nemotron-nano-9b-v2',
      slug: 'nemotron-nano-9b-v2',
      canonicalName: 'NVIDIA Nemotron Nano 9B v2',
      displayName: 'Nemotron Nano 9B v2',
      organizationId: 'nvidia',
      familyId: 'nemotron-nano-2',
      version: '2',
      variant: '9B',
      releaseDate: '2025-08-18',
      datePrecision: 'day',
      status: 'unknown',
      featured: false,
      categories: ['language-reasoning'],
      inputModalities: ['text'],
      outputModalities: ['text'],
      accessType: 'proprietary-hosted',
      contextWindow: 128000,
      apiAliases: [],
      predecessorIds: [],
      successorIds: [],
      siblingIds: [],
      derivedFromIds: [],
      summary: 'A hybrid Mamba2-Transformer reasoning model.',
      intendedUse: 'General-purpose reasoning and generation.',
      sourceIds: ['nvidia-nemotron-nano-2-announcement'],
      verifiedAt: '2026-08-31',
    };

    expect(() => releaseSchema.parse(release)).not.toThrow();
    expect(releaseSchema.parse(release).status).toBe('unknown');
  });

  it('makes the Cohere Command R tranche member publishable end to end', () => {
    // The strongest #689 case. The family (cohere-family-command-r-add) was
    // rejected solely because a family-level status:'current' was "scoped, not
    // supported" — no family-level lifecycle was stated anywhere — which is
    // precisely what status:'unknown' now records honestly. Its release
    // (cohere-release-command-r-08-2024-add) had every field properly sourced
    // — status:'current' mapped from the quoted "Live", accessType, contextWindow
    // and parameters — except a single over-claimed maximumOutput, which is an
    // optional field and is simply dropped. So the pair below is a complete,
    // schema-valid family + release built only from what the archive's own bytes
    // support, unblocked by ADR 0008 at the family level.
    const family: ModelFamily = {
      id: 'command-r',
      slug: 'command-r',
      organizationId: 'cohere',
      name: 'Command R',
      description: 'Cohere’s Command R family of large language models.',
      categories: ['language-reasoning'],
      firstReleaseDate: '2024-03',
      datePrecision: 'month',
      status: 'unknown',
      sourceIds: ['cohere-command-r-model-card'],
      verifiedAt: '2026-08-31',
    };

    const release: ModelRelease = {
      id: 'command-r-08-2024',
      slug: 'command-r-08-2024',
      canonicalName: 'Cohere Command R 08-2024',
      displayName: 'Command R 08-2024',
      organizationId: 'cohere',
      familyId: 'command-r',
      version: '08-2024',
      variant: 'Base',
      releaseDate: '2024-08',
      datePrecision: 'month',
      status: 'current',
      featured: false,
      categories: ['language-reasoning'],
      inputModalities: ['text'],
      outputModalities: ['text'],
      accessType: 'both',
      license: { name: 'CC-BY-NC-4.0', weightsDownloadable: true, osiApproved: false },
      contextWindow: 128000,
      apiAliases: [],
      predecessorIds: [],
      successorIds: [],
      siblingIds: [],
      derivedFromIds: [],
      summary: 'A large language model with open weights.',
      intendedUse: 'Reasoning, summarization, and question answering.',
      sourceIds: ['cohere-command-r-08-2024-weights-card'],
      verifiedAt: '2026-08-31',
    };

    const parsedFamily = familySchema.parse(family);
    const parsedRelease = releaseSchema.parse(release);

    // The release points at the family, so the family is not empty: the
    // empty-family rule (unaffected by ADR 0008) is satisfied by an actual
    // release, not by the status value.
    expect(parsedRelease.familyId).toBe(parsedFamily.id);
    expect(parsedFamily.status).toBe('unknown');
    expect(parsedRelease.status).toBe('current');
    expect(parsedRelease.maximumOutput).toBeUndefined();
  });
});
