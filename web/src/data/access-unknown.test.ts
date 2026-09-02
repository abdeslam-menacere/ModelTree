import { describe, expect, it } from 'vitest';
import { accessType, releaseSchema } from './schema';
import type { ModelRelease } from './schema';
import { accessLabel } from '../lib/format';
import { accessTypeGlossary } from '../lib/methodology';

/**
 * The decision recorded in
 * `docs/adr/0011-access-type-carries-an-explicit-unknown-member.md`: add an
 * explicit `unknown` member to `accessType`, so a release whose sources state
 * nothing about how it is obtained can be recorded honestly instead of being
 * withheld or guessed.
 *
 * This proves the decision against the inputs it exists to unblock. Unlike ADR
 * 0008's proof, it re-verifies no claim hashes and does not pretend to: the
 * `.modeltree-refresh` archives are git-ignored and absent from a fresh
 * checkout. The evidence base is `web/src/data/refresh-runs.json`, which is
 * committed, and the records below are self-contained reconstructions of
 * releases that file records as withheld, quoted by run id so a reader can find
 * the entry.
 *
 * The direction matters and is the reason this file is not a copy of
 * `lifecycle-unknown.test.ts`. The *common* `accessType` rejection in the
 * ledger is a claim proposing `open-weight` from a licence name or a download
 * link, and the run that produced most of them calls that "a scouting defect
 * and not a structural one" -- a better quote fixes it, and `unknown` must not
 * absorb it. The cases below are the opposite direction, where no better quote
 * exists because no creator publishes the sentence "our weights are not
 * downloadable". The last test in this file guards that boundary.
 */

describe('accessType carries an explicit unknown member', () => {
  it('adds unknown without dropping or reordering any pre-existing member (ADR 0011)', () => {
    // Every published release maps to one of the first four. They must survive
    // in order, or this is a breaking change to shipped data rather than an
    // addition -- and the gate in
    // `.github/skills/modeltree-gates/scripts/gate-dataset.mjs` reports this
    // list in the order it is declared.
    expect(accessType.options).toEqual([
      'proprietary-hosted',
      'open-weight',
      'source-available',
      'both',
      'unknown',
    ]);
  });

  it('renders unknown as its own label and glossary entry, never a blank', () => {
    // The blank-badge regression ADR 0008 recorded, checked for this field
    // rather than assumed from that one. `passport.ts` throws at build time when
    // an access value has no glossary entry, so a missing definition fails the
    // build; an *empty* one would not, which is what the length assertion is
    // for.
    expect(accessLabel('unknown')).toBe('Unknown');
    const entry = accessTypeGlossary.find((candidate) => candidate.value === 'unknown');
    expect(entry).toBeDefined();
    expect(entry?.label).toBe('Unknown');
    expect(entry?.definition.trim().length).toBeGreaterThan(0);
    // And it must not read as a claim that no weights exist. That claim is
    // `proprietary-hosted`, which needs a source of its own; conflating the two
    // is the misreading this member is most likely to cause on the page.
    expect(entry?.definition).not.toBe(
      accessTypeGlossary.find((candidate) => candidate.value === 'proprietary-hosted')?.definition,
    );
  });

  it('accepts a hosted-direction release whose sources state no access type', () => {
    // Run 2026-09-01-b41087, withheld: "the record sets accessType to
    // proprietary-hosted, but none of the five cited quotes says anything about
    // how the model is released or whether weights are downloadable, so that
    // field had no quoted fact behind it." Before ADR 0011 there was no value to
    // put there; the record's only options were a guess or the bin.
    const release: ModelRelease = {
      id: 'gemini-2-5-flash-lite',
      slug: 'gemini-2-5-flash-lite',
      canonicalName: 'Gemini 2.5 Flash-Lite',
      displayName: 'Gemini 2.5 Flash-Lite',
      organizationId: 'google',
      familyId: 'gemini-2-5',
      version: '2.5',
      variant: 'Flash-Lite',
      releaseDate: '2025-07-22',
      datePrecision: 'day',
      status: 'current',
      featured: false,
      categories: ['language-reasoning'],
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      accessType: 'unknown',
      contextWindow: 1000000,
      apiAliases: ['gemini-2.5-flash-lite'],
      predecessorIds: [],
      successorIds: [],
      siblingIds: [],
      derivedFromIds: [],
      summary: 'The most cost-efficient model in the Gemini 2.5 line.',
      intendedUse: 'High-throughput, latency-sensitive tasks.',
      sourceIds: ['google-gemini-2-5-flash-lite-announcement'],
      verifiedAt: '2026-09-01',
    };

    const parsed = releaseSchema.parse(release);
    expect(parsed.accessType).toBe('unknown');
    // No licence is required, and that is the coherent outcome rather than a
    // loophole: `claimsWeights` in releaseSchema.superRefine covers
    // `open-weight` and `both`, so a release the dataset cannot classify is one
    // it does not assert downloadable weights for.
    expect(parsed.license).toBeUndefined();
  });

  it('accepts a release withheld because its only statement belonged to a platform', () => {
    // Run 2026-08-27-4f1c9e, withheld: "No approved-origin page states an
    // accessType or an input/output modality set for MAI-Thinking-1... The only
    // availability statement found -- 'available in public preview on Microsoft
    // Foundry' -- describes a serving platform, not the model's access type, and
    // treating it as one would collapse creator and platform into a single
    // entity. Recorded as unknown rather than inferred."
    //
    // The run reached for the word and had nowhere to put it. Note what is NOT
    // being relaxed: the entity boundary still holds, the platform quote still
    // supports nothing, and the modality gap that run also recorded is a
    // separate blocker this ADR does not touch -- the fixture states modalities
    // because a record needs them, not because that gap was resolved here.
    const release: ModelRelease = {
      id: 'mai-thinking-1',
      slug: 'mai-thinking-1',
      canonicalName: 'Microsoft MAI-Thinking-1',
      displayName: 'MAI-Thinking-1',
      organizationId: 'microsoft',
      familyId: 'mai',
      version: '1',
      variant: 'Thinking',
      releaseDate: '2026-08',
      datePrecision: 'month',
      status: 'preview',
      featured: false,
      categories: ['language-reasoning'],
      inputModalities: ['text'],
      outputModalities: ['text'],
      accessType: 'unknown',
      apiAliases: [],
      predecessorIds: [],
      successorIds: [],
      siblingIds: [],
      derivedFromIds: [],
      summary: 'A reasoning model in Microsoft’s MAI line.',
      intendedUse: 'Reasoning tasks.',
      sourceIds: ['microsoft-mai-thinking-1-announcement'],
      verifiedAt: '2026-08-27',
    };

    expect(() => releaseSchema.parse(release)).not.toThrow();
    expect(releaseSchema.parse(release).accessType).toBe('unknown');
  });

  it('refuses unknown on a release that records downloadable weights', () => {
    // The contradiction the new member makes possible, and the boundary that
    // keeps it from absorbing the open-weight scouting defect. A licence record
    // asserting the weights *are* downloadable states the access type, so the
    // record is not unknown whichever half is right. Nothing else in the schema
    // would notice, which is why this rule exists rather than being left to
    // review.
    const contradictory = {
      id: 'gpt-neo-2-7b',
      slug: 'gpt-neo-2-7b',
      canonicalName: 'EleutherAI GPT-Neo 2.7B',
      displayName: 'GPT-Neo 2.7B',
      organizationId: 'eleutherai',
      familyId: 'gpt-neo',
      version: '1',
      variant: '2.7B',
      releaseDate: '2021-03',
      datePrecision: 'month',
      status: 'unknown',
      featured: false,
      categories: ['language-reasoning'],
      inputModalities: ['text'],
      outputModalities: ['text'],
      accessType: 'unknown',
      license: { name: 'MIT', weightsDownloadable: true, osiApproved: false },
      apiAliases: [],
      predecessorIds: [],
      successorIds: [],
      siblingIds: [],
      derivedFromIds: [],
      summary: 'A transformer model trained on the Pile.',
      intendedUse: 'Text generation research.',
      sourceIds: ['eleutherai-gpt-neo-readme'],
      verifiedAt: '2026-08-31',
    };

    const result = releaseSchema.safeParse(contradictory);
    expect(result.success).toBe(false);
    const issue = result.success
      ? undefined
      : result.error.issues.find((candidate) => candidate.path.join('.') === 'accessType');
    expect(issue?.message).toContain('cannot be unknown when the release records downloadable weights');
  });
});
