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
 *   that genuinely has no licence record, and on one whose gap falls in the
 *   middle of the constant rather than at its end.
 *
 * The visible label text is the one deliberate exception to "checked against
 * something outside this module". Pinning it against a literal is the whole
 * point: those strings are published copy, and a test that derived the expected
 * words from the map would move with any rewording and report nothing.
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

  it('prints these exact words, so a rewording cannot ship unreviewed', () => {
    // Complementary to the assertion above rather than a stronger version of
    // it. That one pins the *key set* against the schema and requires each
    // value to be non-empty, and catches a modality added with no label; this
    // one pins the words, and catches a label whose text was changed. Neither
    // subsumes the other, so both stay.
    //
    // The words are worth pinning because they are published. `buildModelDna`
    // renders this map into the Input and Output segments, so an edit here is a
    // copy change on every model page whose release declares that modality.
    // The failure mode is specific: this project publishes no composite score
    // and no universal ranking, `gate-dataset.mjs` refuses ranking-flavoured
    // field names in the *dataset*, and nothing covered a presentation constant
    // compiled into the bundle. A value reading "Video (frontier-grade
    // generation)" is an evaluative claim about capability, and until this
    // assertion existed it reached the page with the suite green.
    //
    // So failing on a wording change is the point of the test, not a cost of
    // it: the failure is the prompt to review the new words.
    expect(MODALITY_LABELS).toEqual({
      text: 'Text',
      image: 'Image',
      audio: 'Audio',
      video: 'Video',
    });
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

describe('a gap that is not the last dimension still holds its place', () => {
  // Why this fixture exists, given the suite above already checks ordering on
  // three fixtures and on every shipped release: `weights` is simultaneously
  // the *last* dimension in MODEL_DNA_DIMENSIONS and the *only* optional one,
  // so on every one of those records "the constant's order" and "recorded
  // first, unrecorded last" name the same sequence. Ordering the segments by
  // recordedness is therefore a no-op on all of them, and would pass the whole
  // ordering suite unnoticed. A gap in the middle separates the two orderings,
  // and nothing else here does.
  const GAP_ID = 'tier';
  const gapIndex = MODEL_DNA_DIMENSIONS.findIndex((dimension) => dimension.id === GAP_ID);

  /**
   * The complete fixture, with its `variant` reading empty — what
   * `buildModelDna` treats as nothing recorded.
   *
   * Built here rather than added to `passport-dataset.ts` because
   * `releaseSchema` gives `variant` a `.min(1)`, so no publishable record can
   * carry this gap and the records in that file are parsed as real ones
   * elsewhere. That is not a reason to skip the case: the property under test
   * belongs to the builder rather than to the dataset. `buildModelDna` decides
   * position from the constant and recordedness from the reading, separately,
   * for all nine dimensions — and a builder that only holds position for the
   * one dimension today's data can leave empty is not the builder this module's
   * second and third rules describe.
   */
  function gapView() {
    const { release, organization, family } = fixtureRelease(COMPLETE_RELEASE_ID);
    return buildModelDna({ ...release, variant: '' }, organization, family, BASE);
  }

  it('puts its gap somewhere other than the last dimension', () => {
    // The control. Were `tier` ever moved to the end of the constant or dropped
    // from it, this fixture would quietly become another one where the two
    // orderings agree, and every assertion below would keep passing while
    // proving nothing. Then this test fails and says why.
    expect(gapIndex).toBeGreaterThanOrEqual(0);
    expect(gapIndex).toBeLessThan(MODEL_DNA_DIMENSIONS.length - 1);
  });

  it('records every dimension that follows the gap', () => {
    // The other half of the control: reordering can only be detected if there
    // is something recorded behind the gap for it to move past.
    const after = gapView().segments.slice(gapIndex + 1);

    expect(after.length).toBeGreaterThan(0);
    for (const entry of after) expect(entry.recorded).toBe(true);
  });

  it('leaves the unrecorded dimension in its constant position', () => {
    const view = gapView();

    expect(view.segments.map((entry) => entry.id)).toEqual(
      MODEL_DNA_DIMENSIONS.map((dimension) => dimension.id),
    );
    expect(view.segments[gapIndex].id).toBe(GAP_ID);
    expect(view.segments).toHaveLength(MODEL_DNA_DIMENSIONS.length);
  });

  it('says the dimension is not recorded rather than moving or dropping it', () => {
    const entry = gapView().segments[gapIndex];

    expect(entry.recorded).toBe(false);
    expect(entry.value).toBe(MODEL_DNA_NOT_RECORDED);
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
