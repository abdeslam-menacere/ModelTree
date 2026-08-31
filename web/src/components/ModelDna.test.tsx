/**
 * Tests for the rendered Model DNA strip (issue #37).
 *
 * The library tests check what the view model says. These check what a reader
 * actually receives — that the order survives rendering, that an unrecorded
 * dimension reaches the page as words rather than as a gap, and that no fact in
 * the strip depends on colour, a glyph, or a script to be read.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { dataset } from '../data/dataset';
import {
  COMPLETE_RELEASE_ID,
  OPEN_WEIGHT_RELEASE_ID,
  SPARSE_RELEASE_ID,
  passportFixtures,
} from '../../tests/fixtures/passport-dataset';
import { MODEL_DNA_DIMENSIONS, buildModelDna } from '../lib/model-dna';
import ModelDna from './ModelDna';

const BASE = '/ModelTree/';

function view(releaseId: string) {
  const release = passportFixtures.releases.find((candidate) => candidate.id === releaseId)!;
  const organization = passportFixtures.organizations.find(
    (candidate) => candidate.id === release.organizationId,
  )!;
  const family = passportFixtures.families.find((candidate) => candidate.id === release.familyId)!;
  return buildModelDna(release, organization, family, BASE);
}

const render = (releaseId: string) =>
  renderToStaticMarkup(<ModelDna dna={view(releaseId)} />);

/** The `data-dimension` values in the order they appear in the strip itself. */
function stripOrder(html: string): string[] {
  const strip = html.match(/<ul class="model-dna-strip"[\s\S]*?<\/ul>/)?.[0] ?? '';
  return [...strip.matchAll(/data-dimension="([^"]+)"/g)].map((match) => match[1]);
}

describe('ordering is identical on every model', () => {
  const expected = MODEL_DNA_DIMENSIONS.map((dimension) => dimension.id);

  it('renders the fixed order for a complete release', () => {
    expect(stripOrder(render(COMPLETE_RELEASE_ID))).toEqual(expected);
  });

  it('renders the same order for a sparse release, absences included', () => {
    // The one that matters: a missing dimension must not shift its neighbours,
    // or scanning two models side by side stops working.
    expect(stripOrder(render(SPARSE_RELEASE_ID))).toEqual(expected);
  });

  it('renders the same order for every release in the shipped dataset', () => {
    expect(dataset.releases.length).toBeGreaterThan(0);

    for (const release of dataset.releases) {
      const organization = dataset.organizations.find(
        (candidate) => candidate.id === release.organizationId,
      );
      const family = dataset.families.find((candidate) => candidate.id === release.familyId);
      if (!organization || !family) continue;

      const html = renderToStaticMarkup(
        <ModelDna dna={buildModelDna(release, organization, family, BASE)} />,
      );
      expect(stripOrder(html), `${release.id} should render the fixed order`).toEqual(expected);
    }
  });
});

describe('an unrecorded dimension is stated, not hidden', () => {
  const html = render(SPARSE_RELEASE_ID);

  it('prints the words rather than leaving the segment blank', () => {
    expect(html).toContain('Not recorded');
    expect(stripOrder(html)).toContain('weights');
  });

  it('marks the absence in the markup as well as in the text', () => {
    // Belt and braces: the class is for styling, the words are the fact. If the
    // class were the only signal, the strip would be conveying meaning by
    // appearance alone.
    expect(html).toContain('data-recorded="false"');
    expect(html).toContain('model-dna-absent');
  });

  it('gives the reason for the absence in the text equivalent', () => {
    expect(html).toContain('No licence record is held for this release');
  });

  it('never renders a guess in place of the missing licence record', () => {
    const strip = html.match(/<ul class="model-dna-strip"[\s\S]*?<\/ul>/)![0];
    expect(strip).not.toContain('Not downloadable');
  });

  it('marks every other segment as recorded', () => {
    const recorded = [...html.matchAll(/data-recorded="(true|false)"/g)].map((match) => match[1]);
    expect(recorded).toHaveLength(MODEL_DNA_DIMENSIONS.length);
    expect(recorded.filter((value) => value === 'false')).toEqual(['false']);
  });
});

describe('a recorded licence renders what the record says', () => {
  it('reports downloadable weights for an open-weight release', () => {
    const html = render(OPEN_WEIGHT_RELEASE_ID);
    expect(html).toContain('Downloadable');
    expect(html).toContain('data-recorded="true"');
  });
});

describe('the strip is its own text equivalent', () => {
  const html = render(COMPLETE_RELEASE_ID);

  it('prints every dimension label as text in the strip', () => {
    for (const dimension of MODEL_DNA_DIMENSIONS) {
      expect(html, `${dimension.id} label should render`).toContain(
        `<span class="model-dna-label">${dimension.label}</span>`,
      );
    }
  });

  it('gives every dimension a definition term in the disclosure', () => {
    const terms = [...html.matchAll(/<dt>([^<]+)<\/dt>/g)].map((match) => match[1]);
    expect(terms).toEqual(MODEL_DNA_DIMENSIONS.map((dimension) => dimension.label));
  });

  it('names the record field each segment was read from', () => {
    for (const dimension of MODEL_DNA_DIMENSIONS) {
      expect(html, `${dimension.field} provenance should render`).toContain(
        `<code>${dimension.field}</code>`,
      );
    }
  });

  it('keeps the disclosure in the markup without any script', () => {
    // `<details>` works with no JavaScript and no pointer, which is why the text
    // equivalent is always available rather than available on hydration.
    expect(html).toContain('<details');
    expect(html).not.toContain('client:');
    expect(html).not.toContain('<script');
  });

  it('renders no glyph, icon, or colour swatch', () => {
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('style=');
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('renders no table, so a narrow viewport has nothing to scroll sideways', () => {
    expect(html).not.toContain('<table');
  });
});

describe('the heading and its label resolve', () => {
  const html = render(COMPLETE_RELEASE_ID);

  it('labels the strip by a heading that exists in the same markup', () => {
    const labelled = [...html.matchAll(/aria-labelledby="([^"]+)"/g)].map((match) => match[1]);
    expect(labelled).toHaveLength(1);
    for (const id of labelled) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('defines every id exactly once', () => {
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps list semantics where the marker is styled away', () => {
    expect(html).toContain('role="list"');
  });
});

describe('long values are rendered in full', () => {
  it('never truncates a value in the markup', () => {
    // Truncation in markup is unrecoverable; folding is a stylesheet concern and
    // is asserted in `styles/model-dna.test.ts`. A clipped value would read as a
    // shorter fact than the record states.
    const html = render(COMPLETE_RELEASE_ID);
    const complete = view(COMPLETE_RELEASE_ID);

    for (const segment of complete.segments) {
      expect(html, `${segment.id} value should render whole`).toContain(segment.value);
    }
    expect(html).not.toContain('…');
  });
});

describe('rendered markup snapshots', () => {
  it('complete', () => {
    expect(render(COMPLETE_RELEASE_ID)).toMatchSnapshot();
  });

  it('sparse', () => {
    expect(render(SPARSE_RELEASE_ID)).toMatchSnapshot();
  });
});
