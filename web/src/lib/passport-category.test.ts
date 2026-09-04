import { describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import { buildModelPassport } from './passport';
import { categorySpecs } from '../data/category-specs';
import {
  IMAGE_SPEC_DIMENSION_LABELS,
  IMAGE_SPEC_DIMENSION_ORDER,
} from '../data/category-spec-schema';

const BASE = '/ModelTree/';
const TODAY = '2026-09-02';

const view = (releaseId: string) => buildModelPassport(dataset, releaseId, BASE, TODAY);

const IMAGE_RELEASE = 'openai-gpt-image-2';
const LANGUAGE_RELEASE = 'meta-llama-4-scout';

const factNamed = (releaseId: string, term: string) => {
  const entry = view(releaseId).technicalFacts.find((candidate) => candidate.term === term);
  if (!entry) throw new Error(`no technical fact "${term}" on ${releaseId}`);
  return entry;
};

const imageReleaseIds = dataset.releases
  .filter((release) => release.categories.includes('image'))
  .map((release) => release.id);

/**
 * AC4 — "Category filters and Passports expose only meaningful dimensions."
 *
 * The distinction under test is between a fact that is missing and a question
 * that does not apply. Before this change an image model's passport rendered
 * "Maximum output: Not recorded", which reads as a research gap and is not one.
 */
describe('token-denominated dimensions apply only where tokens are counted', () => {
  it('refuses a token output limit for a release that emits no text', () => {
    const fact = factNamed(IMAGE_RELEASE, 'Maximum output');

    expect(fact.notApplicable).toBe(true);
    expect(fact.unknown).toBe(false);
    expect(fact.value).toMatch(/^Not applicable/);
  });

  it('still asks for a context window where the model takes a text prompt', () => {
    // The trap this test pins: an image model is not "a model with no tokens".
    // GPT-Image-2 takes text in, so a context window is a real quantity for it
    // and marking it inapplicable would suppress a fact worth recording.
    const release = dataset.releases.find((candidate) => candidate.id === IMAGE_RELEASE);
    const fact = factNamed(IMAGE_RELEASE, 'Context window');

    expect(release?.inputModalities).toContain('text');
    expect(fact.notApplicable).toBe(false);
  });

  it('leaves a language model unchanged in both dimensions', () => {
    for (const term of ['Context window', 'Maximum output']) {
      expect(factNamed(LANGUAGE_RELEASE, term).notApplicable).toBe(false);
    }
  });

  it('derives applicability from modalities, never from the category', () => {
    for (const release of dataset.releases) {
      const output = view(release.id).technicalFacts
        .find((candidate) => candidate.term === 'Maximum output');

      expect(output?.notApplicable).toBe(!release.outputModalities.includes('text'));
    }
  });

  it('never marks a fact both unknown and inapplicable', () => {
    for (const release of dataset.releases) {
      for (const fact of view(release.id).technicalFacts) {
        expect(fact.unknown && fact.notApplicable).toBe(false);
      }
    }
  });

  it('names the state in words, so colour is not the only carrier', () => {
    // Accessibility acceptance criterion: the three states must be
    // distinguishable without perceiving the class that tints them.
    const notApplicable = factNamed(IMAGE_RELEASE, 'Maximum output');
    const notRecorded = factNamed(IMAGE_RELEASE, 'Context window');

    expect(notApplicable.value).toMatch(/not applicable/i);
    expect(notApplicable.value.length).toBeGreaterThan('Not applicable'.length);
    expect(notRecorded.value).toMatch(/not recorded/i);
    expect(notApplicable.value).not.toBe(notRecorded.value);
  });
});

describe('the category-specific block', () => {
  it('renders for every image release the pilot documents', () => {
    for (const spec of categorySpecs) {
      const block = view(spec.releaseId).categorySpec;

      expect(block, `${spec.releaseId} should carry a spec block`).not.toBeNull();
      expect(block?.category).toBe(spec.category);
      expect(block?.facts.length).toBeGreaterThan(0);
    }
  });

  it('is absent on a release no source documented', () => {
    expect(view(LANGUAGE_RELEASE).categorySpec).toBeNull();
  });

  it('carries a source and a check date for every fact', () => {
    for (const spec of categorySpecs) {
      const block = view(spec.releaseId).categorySpec;

      expect(block?.verifiedAt).toBeTruthy();
      for (const fact of block?.facts ?? []) {
        expect(fact.source, `${spec.releaseId}/${fact.dimension}`).not.toBeNull();
        expect(fact.quote.length).toBeGreaterThan(0);
        expect(fact.statement.length).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the creator\'s words and ModelTree\'s reading in separate fields', () => {
    const block = view(IMAGE_RELEASE).categorySpec;
    const entry = block?.facts.find((candidate) => candidate.dimension === 'output-sizing');

    expect(entry?.quote).toBe('It supports flexible image sizes and high-fidelity image inputs.');
    expect(entry?.statement).not.toBe(entry?.quote);
  });

  it('names the dimensions no cited source states, rather than hiding them', () => {
    // Meta's announcement documents editing and multi-reference composition and
    // states no resolution. ADR 0007 predicted exactly this shortfall, and the
    // page has to say so instead of rendering a shorter list that looks complete.
    const block = view('meta-muse-image').categorySpec;
    const undocumented = block?.undocumented.map((entry) => entry.dimension) ?? [];

    expect(undocumented).toContain('output-sizing');
    expect(undocumented).toContain('aspect-ratio-control');
  });

  it('accounts for every dimension exactly once, as documented or as absent', () => {
    for (const spec of categorySpecs) {
      const block = view(spec.releaseId).categorySpec;
      const seen = [
        ...(block?.facts.map((entry) => entry.dimension) ?? []),
        ...(block?.undocumented.map((entry) => entry.dimension) ?? []),
      ];

      expect([...seen].sort()).toEqual([...IMAGE_SPEC_DIMENSION_ORDER].sort());
    }
  });

  it('renders dimensions in one fixed order for every release', () => {
    for (const spec of categorySpecs) {
      const block = view(spec.releaseId).categorySpec;
      const order = block?.facts.map((entry) => entry.dimension) ?? [];
      const expected = IMAGE_SPEC_DIMENSION_ORDER.filter((dimension) => order.includes(dimension));

      expect(order).toEqual(expected);
    }
  });

  it('labels and defines every dimension it shows', () => {
    for (const spec of categorySpecs) {
      const block = view(spec.releaseId).categorySpec;

      for (const entry of [...(block?.facts ?? []), ...(block?.undocumented ?? [])]) {
        expect(entry.label).toBe(
          IMAGE_SPEC_DIMENSION_LABELS[entry.dimension as keyof typeof IMAGE_SPEC_DIMENSION_LABELS],
        );
        expect(entry.definition.length).toBeGreaterThan(0);
      }
    }
  });

  it('builds a passport for every image release without throwing', () => {
    expect(imageReleaseIds.length).toBeGreaterThan(0);

    for (const releaseId of imageReleaseIds) {
      expect(() => view(releaseId)).not.toThrow();
    }
  });
});
