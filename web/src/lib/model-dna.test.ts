/**
 * Tests for the Model DNA view model (issue #37).
 *
 * These check the three properties the strip's honesty rests on, and each is
 * checked against something outside this module rather than against a copy of
 * the same list:
 *
 * - every dimension's declared field is really a `releaseSchema` field, checked
 *   against a parsed release rather than against a hand-written key list;
 * - the order is the constant's order, checked against every release in the
 *   shipped dataset, not just a fixture;
 * - an unrecorded dimension keeps its place and says so, checked on a release
 *   that genuinely has no licence record.
 */
import { describe, expect, it } from 'vitest';

import { modality, releaseSchema } from '../data/schema';
import { dataset } from '../data/dataset';
import {
  MODALITY_LABELS,
  MODEL_DNA_DIMENSIONS,
  MODEL_DNA_NOT_RECORDED,
  buildModelDna,
} from './model-dna';
import {
  COMPLETE_RELEASE_ID,
  OPEN_WEIGHT_RELEASE_ID,
  SPARSE_RELEASE_ID,
  passportFixtures,
} from '../../tests/fixtures/passport-dataset';

const BASE = '/ModelTree/';

function fixtureRelease(releaseId: string) {
  const release = passportFixtures.releases.find((candidate) => candidate.id === releaseId);
  if (!release) throw new Error(`fixture release ${releaseId} is missing`);

  const organization = passportFixtures.organizations.find(
    (candidate) => candidate.id === release.organizationId,
  );
  const family = passportFixtures.families.find((candidate) => candidate.id === release.familyId);
  if (!organization || !family) {
    throw new Error(`fixture release ${releaseId} has no creator/family`);
  }

  return { release, organization, family };
}

function fixtureDna(releaseId: string) {
  const { release, organization, family } = fixtureRelease(releaseId);
  return buildModelDna(release, organization, family, BASE);
}

function segment(releaseId: string, id: string) {
  const found = fixtureDna(releaseId).segments.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no ${id} segment`);
  return found;
}

describe('every segment maps to a validated schema field', () => {
  /**
   * Parsed output rather than `.shape`: `releaseSchema` carries a `.superRefine`,
   * and parsing sidesteps any question about what that returns. Zod strips keys
   * it does not know, so a key surviving a parse is definitionally part of the
   * validated shape.
   */
  const parsedKeys = new Set(Object.keys(releaseSchema.parse(passportFixtures.releases[0])));

  it.each(MODEL_DNA_DIMENSIONS.map((dimension) => [dimension.id, dimension.field]))(
    '%s reads the validated field %s',
    (_id, field) => {
      expect(parsedKeys.has(field as string)).toBe(true);
    },
  );

  it('would notice a field name that is not on the schema', () => {
    // The control for the assertion above: without it, a parse that returned
    // every key imaginable would pass the whole suite silently.
    expect(parsedKeys.has('capabilityScore')).toBe(false);
    expect(parsedKeys.has('dnaRank')).toBe(false);
  });

  it('reads no measured or priced field, so no segment can imply a score', () => {
    // Structural, not stylistic. These are the numeric fields on a release; a
    // dimension reading one of them would be a measurement wearing an identity
    // label, which is exactly what the issue's non-goals rule out.
    const measured = ['contextWindow', 'maximumOutput', 'parameters', 'activeParameters'];
    const fields = MODEL_DNA_DIMENSIONS.map((dimension) => dimension.field as string);

    for (const name of measured) {
      expect(fields).not.toContain(name);
    }
  });

  it('gives each dimension its own field and its own id', () => {
    const ids = MODEL_DNA_DIMENSIONS.map((dimension) => dimension.id);
    const fields = MODEL_DNA_DIMENSIONS.map((dimension) => dimension.field);

    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(fields).size).toBe(fields.length);
  });

  it('labels every modality the schema allows', () => {
    // Totality, so a modality added to the schema cannot render as `undefined`
    // through this strip.
    for (const option of modality.options) {
      expect(MODALITY_LABELS[option]).toBeTruthy();
    }
    expect(Object.keys(MODALITY_LABELS).sort()).toEqual([...modality.options].sort());
  });
});

describe('ordering is fixed by the constant', () => {
  it('renders the fixture releases in the constant order', () => {
    const expected = MODEL_DNA_DIMENSIONS.map((dimension) => dimension.id);

    for (const id of [COMPLETE_RELEASE_ID, SPARSE_RELEASE_ID, OPEN_WEIGHT_RELEASE_ID]) {
      expect(fixtureDna(id).segments.map((entry) => entry.id)).toEqual(expected);
    }
  });

  it('renders every release in the shipped dataset in the same order', () => {
    // The property the acceptance criterion actually asks for is that the order
    // does not vary *between models*, which a two-fixture check cannot show.
    const expected = MODEL_DNA_DIMENSIONS.map((dimension) => dimension.id);
    expect(dataset.releases.length).toBeGreaterThan(0);

    for (const release of dataset.releases) {
      const organization = dataset.organizations.find(
        (candidate) => candidate.id === release.organizationId,
      );
      const family = dataset.families.find((candidate) => candidate.id === release.familyId);
      if (!organization || !family) continue;

      const view = buildModelDna(release, organization, family, BASE);
      expect(view.segments.map((entry) => entry.id)).toEqual(expected);
      expect(view.segments).toHaveLength(MODEL_DNA_DIMENSIONS.length);
    }
  });
});

describe('values come from the record', () => {
  it('states the identity fields of a complete release', () => {
    const { release } = fixtureRelease(COMPLETE_RELEASE_ID);

    expect(segment(COMPLETE_RELEASE_ID, 'generation').value).toBe(release.version);
    expect(segment(COMPLETE_RELEASE_ID, 'tier').value).toBe(release.variant);
    expect(segment(COMPLETE_RELEASE_ID, 'creator').value).toBeTruthy();
    expect(segment(COMPLETE_RELEASE_ID, 'family').value).toBeTruthy();
    expect(segment(COMPLETE_RELEASE_ID, 'input').value).toContain('Text');
  });

  it('reads weights from the licence record when there is one', () => {
    const weights = segment(OPEN_WEIGHT_RELEASE_ID, 'weights');
    expect(weights.recorded).toBe(true);
    expect(weights.value).toBe('Downloadable');
  });
});

describe('a dimension with nothing recorded keeps its place and says so', () => {
  const weights = segment(SPARSE_RELEASE_ID, 'weights');

  it('is present rather than dropped', () => {
    const ids = fixtureDna(SPARSE_RELEASE_ID).segments.map((entry) => entry.id);
    expect(ids).toContain('weights');
    expect(ids).toHaveLength(MODEL_DNA_DIMENSIONS.length);
  });

  it('says so in words', () => {
    expect(weights.recorded).toBe(false);
    expect(weights.value).toBe(MODEL_DNA_NOT_RECORDED);
  });

  it('never guesses "Not downloadable" from a missing licence record', () => {
    // The single inference this dimension must not make: absence of a record is
    // not evidence about the model.
    expect(weights.value).not.toBe('Not downloadable');
    expect(weights.value).not.toBe('Downloadable');
  });

  it('gives the schema-level reason for the absence', () => {
    expect(weights.absenceNote).toBeTruthy();
    expect(weights.absenceNote).toContain('licence record');
  });

  it('leaves recorded segments with no absence note', () => {
    for (const entry of fixtureDna(COMPLETE_RELEASE_ID).segments) {
      if (entry.recorded) expect(entry.absenceNote).toBeNull();
    }
  });
});

describe('the view is complete text, and nothing else', () => {
  it('gives every segment a non-empty label, value and definition', () => {
    for (const entry of fixtureDna(SPARSE_RELEASE_ID).segments) {
      expect(entry.label.trim()).not.toBe('');
      expect(entry.value.trim()).not.toBe('');
      expect(entry.definition.trim()).not.toBe('');
      expect(entry.field.trim()).not.toBe('');
    }
  });

  it('carries no numeric score, rank or ordering key on any segment', () => {
    for (const entry of fixtureDna(COMPLETE_RELEASE_ID).segments) {
      const values = Object.values(entry as unknown as Record<string, unknown>);
      expect(values.some((value) => typeof value === 'number')).toBe(false);
    }
  });

  it('honours the deploy base path on every definition link', () => {
    for (const entry of fixtureDna(COMPLETE_RELEASE_ID).segments) {
      if (entry.definitionHref === null) {
        // A dimension with no page defining it carries no link text either, so
        // no link can render with nothing behind it.
        expect(entry.definitionLinkText).toBeNull();
        continue;
      }
      expect(entry.definitionHref.startsWith(BASE)).toBe(true);
      expect(entry.definitionLinkText).toBeTruthy();
    }
  });

  it('normalises a base path given without its trailing slash', () => {
    const { release, organization, family } = fixtureRelease(COMPLETE_RELEASE_ID);

    const view = buildModelDna(release, organization, family, '/ModelTree');
    for (const entry of view.segments) {
      if (entry.definitionHref) expect(entry.definitionHref).not.toContain('ModelTreemethodology');
    }
  });

  it('states the dimension count in the note without contradicting the strip', () => {
    const view = fixtureDna(SPARSE_RELEASE_ID);
    expect(view.note).toContain(String(view.segments.length));
    expect(view.note.toLowerCase()).toContain('score');
    expect(view.headingId).toBe('model-dna-title');
  });
});
