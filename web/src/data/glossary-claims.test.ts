import { describe, expect, it } from 'vitest';
import { dataset } from './dataset';
import { glossaryEntryById } from './glossary';
import {
  licenseSchema,
  lifecycleStatus,
  parameterCountSchema,
  releaseSchema,
} from './schema';

/**
 * Binds the glossary's editorial prose to the declarations it describes.
 *
 * Most glossary entries rest on an external primary source, and
 * `glossary.test.ts` checks that every entry has one. A handful of entries do
 * something different and riskier: they describe *this repository* — how the
 * schema records a fact, or what figure the dataset holds for a named release.
 * Those sentences are derived claims, and their source is a file this branch
 * never edits. Nothing about a source URL and a check date protects them,
 * because the thing that can falsify them is a later commit here rather than a
 * publisher changing a page.
 *
 * That is a live failure mode rather than a theoretical one: a glossary entry
 * reciting `109` stays green on its own branch forever while a data refresh
 * corrects the dataset to something else, and the site then states two numbers
 * for one model with nothing going red. The assertions below exist so that a
 * change to the schema or to a recited release reddens here and a human
 * re-reads the prose, instead of the disagreement shipping.
 *
 * The figures below are read out of the dataset rather than written as
 * literals. Writing `109` here would move the unbound constant into the test
 * rather than bind it, and the test would then agree with itself while
 * disagreeing with the data.
 *
 * `sources[].quote` is deliberately excluded from all of this. A quote records
 * what a publisher's page said on its `lastCheckedDate`; it stays correct even
 * when this repository later revises its own figure, so binding a quote to live
 * data would manufacture a failure out of a document that is still accurate.
 */

/**
 * An entry's editorial voice — everything the repository asserts in its own
 * words, and nothing it merely quotes. See the note on `quote` above.
 */
function editorialText(id: string): string {
  const entry = glossaryEntryById.get(id);
  if (!entry) {
    throw new Error(
      `glossary entry "${id}" is missing, but this file guards a claim it makes. `
      + 'If the entry was renamed or removed, update or delete the matching assertion '
      + 'rather than leaving an unguarded claim behind.',
    );
  }

  return [
    entry.term,
    entry.short,
    entry.definition,
    ...entry.distinctions.flatMap((distinction) => [distinction.from, distinction.note]),
    ...entry.examples.flatMap((example) => [example.notation, example.reading]),
    ...entry.conflicts.map((conflict) => conflict.note),
  ].join(' \u0000 ');
}

/**
 * Matches a figure written as its own number, allowing a unit to follow it —
 * the dataset holds `109` and the prose writes `109B` or `109 billion`. A word
 * boundary is the wrong tool here, because `B` is a word character and `\b109\b`
 * therefore fails against `109B`. Digit lookarounds still refuse a match inside
 * a longer number, so `109` cannot be satisfied by `1090`.
 */
function statesFigure(text: string, figure: number): boolean {
  return new RegExp(`(?<![\\d.])${figure}(?![\\d.])`).test(text);
}

function release(id: string) {
  const found = dataset.releases.find((candidate) => candidate.id === id);
  if (!found) {
    throw new Error(
      `release "${id}" is no longer in the dataset, but a glossary entry uses it as a `
      + 'worked example. Re-point the example at a release that exists.',
    );
  }
  return found;
}

describe('glossary figures agree with the dataset record they describe', () => {
  it('states the same total and active parameter counts as the Llama 4 Scout release', () => {
    const scout = release('meta-llama-4-scout');
    const total = scout.parameters?.totalBillions;
    const active = scout.parameters?.activeBillions;

    expect(total, 'Scout has no recorded total, so the glossary cannot recite one').toBeDefined();
    expect(active, 'Scout has no recorded active count').toBeDefined();

    for (const id of ['total-parameters', 'active-parameters', 'mixture-of-experts']) {
      const text = editorialText(id);
      if (!text.includes('Scout')) continue;

      expect(
        statesFigure(text, total as number),
        `glossary entry "${id}" cites Llama 4 Scout but does not state the dataset's total `
        + `of ${total}B. One of the two has changed and they now disagree.`,
      ).toBe(true);

      expect(
        statesFigure(text, active as number),
        `glossary entry "${id}" cites Llama 4 Scout but does not state the dataset's active `
        + `count of ${active}B.`,
      ).toBe(true);
    }
  });

  it('states the same total parameter count as the Llama 4 Maverick release', () => {
    const maverick = release('meta-llama-4-maverick');
    const total = maverick.parameters?.totalBillions;
    expect(total).toBeDefined();

    const citing = ['total-parameters', 'active-parameters', 'mixture-of-experts', 'expert-count-suffix']
      .filter((id) => editorialText(id).includes('Maverick'));

    expect(citing.length, 'no entry cites Maverick; drop this assertion if that is intended')
      .toBeGreaterThan(0);

    for (const id of citing) {
      expect(
        statesFigure(editorialText(id), total as number),
        `glossary entry "${id}" cites Llama 4 Maverick but not the dataset's total of ${total}B.`,
      ).toBe(true);
    }
  });

  it('describes the same context window the dataset records for Scout', () => {
    const scout = release('meta-llama-4-scout');
    const window = scout.contextWindow;
    expect(window, 'Scout has no recorded context window').toBeDefined();

    const millions = (window as number) / 1_000_000;
    const text = editorialText('context-window');

    expect(
      text,
      `the context-window entry cites Scout but not the dataset's ${millions}M-token window. `
      + 'The dataset figure has moved and the prose has not.',
    ).toContain(`${millions}M`);
  });
});

describe('glossary claims about the schema still hold', () => {
  it('records downloadable weights and OSI approval as two separate booleans', () => {
    // The open-weight entry tells a reader these are two independent properties,
    // and that a model can satisfy one and fail the other. That sentence is only
    // true while the schema keeps them as two booleans under these exact names.
    const both = licenseSchema.safeParse({
      name: 'Example licence',
      weightsDownloadable: true,
      osiApproved: false,
    });

    expect(both.success, 'a licence cannot record open weights alongside no OSI approval').toBe(true);
    expect(both.success && both.data.weightsDownloadable).toBe(true);
    expect(both.success && both.data.osiApproved).toBe(false);

    expect(
      licenseSchema.safeParse({ name: 'Example licence', osiApproved: false }).success,
      'weightsDownloadable is no longer a required field under that name',
    ).toBe(false);

    expect(
      licenseSchema.safeParse({ name: 'Example licence', weightsDownloadable: true }).success,
      'osiApproved is no longer a required field under that name',
    ).toBe(false);

    expect(
      licenseSchema.safeParse({
        name: 'Example licence',
        weightsDownloadable: 'yes',
        osiApproved: false,
      }).success,
      'weightsDownloadable is no longer a boolean, so the entry calling it one is now wrong',
    ).toBe(false);

    expect(editorialText('open-weight')).toContain('separate');
  });

  it('records total and active parameters as two distinct fields', () => {
    // total-parameters and mixture-of-experts both tell a reader this repository
    // never collapses the two figures into one. A rename or a merge would leave
    // that sentence describing a schema that no longer exists.
    const parsed = parameterCountSchema.parse({ totalBillions: 109, activeBillions: 17 });

    expect(
      Object.keys(parsed).sort(),
      'the parameter record no longer carries both fields under these names',
    ).toEqual(['activeBillions', 'totalBillions']);
    expect(parsed.totalBillions).not.toBe(parsed.activeBillions);
  });

  it('stores a context window as a token count, never as an abbreviation', () => {
    // The context-window entry says the repository stores the figure rather than
    // the abbreviation, so that "128K" and 128000 cannot drift apart.
    const scout = release('meta-llama-4-scout');

    expect(
      releaseSchema.safeParse(scout).success,
      'the committed Scout release no longer satisfies the release schema',
    ).toBe(true);

    expect(
      releaseSchema.safeParse({ ...scout, contextWindow: '10M' }).success,
      'contextWindow now accepts an abbreviation, so the entry saying it cannot is wrong',
    ).toBe(false);
  });

  it('records the release track as a lifecycle status rather than reading it from a name', () => {
    expect(
      lifecycleStatus.options,
      'preview is no longer a lifecycle status, but the preview-version entry says it is',
    ).toContain('preview');
  });

  it('keeps model, product, and serving platform as separate collections', () => {
    // The model-api-id entry rests on this separation: it is why one model has
    // several ids and why an id is not an identity.
    expect(Array.isArray(dataset.releases)).toBe(true);
    expect(Array.isArray(dataset.products)).toBe(true);
    expect(Array.isArray(dataset.servingPlatforms)).toBe(true);

    expect(dataset.releases).not.toBe(dataset.products);
    expect(dataset.products).not.toBe(dataset.servingPlatforms);
    expect(editorialText('model-api-id')).toContain('separate');
  });
});
