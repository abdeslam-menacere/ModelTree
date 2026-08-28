import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ATLAS_OPEN,
  ATLAS_PRO,
  BOREALIS_AIR,
  COMPARISON_BASE,
  COMPARISON_TODAY,
  comparisonFixtures,
  comparisonFixturesWithoutOperations,
} from '../../tests/fixtures/comparison-dataset';
import { dataset } from '../data/dataset';
import {
  buildComparisonPayload,
  buildModelComparison,
  MAX_COMPARISON_MODELS,
  NO_RANKING_NOTE,
  VALUE_STATE_LABELS,
  type ComparisonDataset,
} from '../lib/comparison';
import ModelComparison from './ModelComparison';

const renderWith = (data: ComparisonDataset, slugs: string[], today = COMPARISON_TODAY) =>
  renderToStaticMarkup(
    <ModelComparison dataset={data} initialSlugs={slugs} base={COMPARISON_BASE} today={today} />,
  );

/** Counts real matches, so a zero elsewhere reads as absence and not a dead probe. */
const count = (html: string, pattern: RegExp) => html.match(pattern)?.length ?? 0;

const seedPayload = buildComparisonPayload(dataset);
const seedSlugs = seedPayload.releases.map((release) => release.slug);

describe('the comparison table is a table', () => {
  const html = renderWith(comparisonFixtures, [ATLAS_PRO, BOREALIS_AIR]);

  it('gives every group a real table with a caption and column headers', () => {
    const view = buildModelComparison(
      comparisonFixtures,
      [ATLAS_PRO, BOREALIS_AIR],
      COMPARISON_BASE,
      COMPARISON_TODAY,
    );

    expect(view.presentGroups.length).toBeGreaterThan(0);
    expect(count(html, /<table class="comparison-table">/g)).toBe(view.presentGroups.length);
    expect(count(html, /<caption/g)).toBe(view.presentGroups.length);
    // One "Attribute" header plus one per model, in every group.
    expect(count(html, /<th scope="col">/g)).toBe(view.presentGroups.length * 3);
  });

  it('makes each attribute a row header rather than a plain cell', () => {
    const view = buildModelComparison(
      comparisonFixtures,
      [ATLAS_PRO, BOREALIS_AIR],
      COMPARISON_BASE,
      COMPARISON_TODAY,
    );
    const rows = view.presentGroups.flatMap((group) => group.rows);

    expect(rows.length).toBeGreaterThan(5);
    expect(count(html, /<th scope="row"/g)).toBe(rows.length);
  });

  it('names the model on every cell, so the stacked layout stays readable', () => {
    const view = buildModelComparison(
      comparisonFixtures,
      [ATLAS_PRO, BOREALIS_AIR],
      COMPARISON_BASE,
      COMPARISON_TODAY,
    );
    const cells = view.presentGroups.flatMap((group) => group.rows).length * view.models.length;

    expect(count(html, /<td data-model="/g)).toBe(cells);
    for (const model of view.models) {
      expect(html).toContain(`data-model="${model.displayName}"`);
    }
  });
});

describe('what the page says about ranking', () => {
  const html = renderWith(comparisonFixtures, [ATLAS_PRO, BOREALIS_AIR, ATLAS_OPEN]);

  it('states plainly that the order is not a ranking', () => {
    expect(html).toContain(NO_RANKING_NOTE);
    expect(count(html, /which is not a ranking/g)).toBeGreaterThan(0);
  });

  it('renders no position number, medal, or winner anywhere', () => {
    // "winner", "score" and "ranking" do appear — only inside sentences that
    // refuse them. So the check strips those sentences and requires nothing to
    // survive, which a check for the words being absent could not do: that would
    // pass just as well if the refusals were deleted. Each phrase is counted
    // before it is stripped, so a stripper that matches nothing fails loudly
    // instead of quietly weakening the assertion.
    const denials = [
      NO_RANKING_NOTE,
      'which is not a ranking',
      'adds no ranking of its own',
      'ranks a model above another',
    ];

    let residue = html;
    for (const denial of denials) {
      expect(residue, denial).toContain(denial);
      residue = residue.split(denial).join('');
    }
    // Tags go last, so the assertion is about what a reader sees rather than
    // about class names: `comparison-no-ranking` is a selector, not a claim.
    residue = residue.replace(/<[^>]*>/g, ' ');

    expect(count(residue, /\bwinner\b/gi)).toBe(0);
    expect(count(residue, /\bbest overall\b/gi)).toBe(0);
    expect(count(residue, /overall score/gi)).toBe(0);
    expect(count(residue, /composite/gi)).toBe(0);
    expect(count(residue, /leaderboard/gi)).toBe(0);
    expect(count(residue, /\brank(s|ed|ing)?\b/gi)).toBe(0);
  });

  it('places the columns in the order asked for, both ways round', () => {
    const forward = renderWith(comparisonFixtures, [ATLAS_PRO, BOREALIS_AIR]);
    const backward = renderWith(comparisonFixtures, [BOREALIS_AIR, ATLAS_PRO]);
    const headers = (html: string) =>
      Array.from(html.matchAll(/<th scope="col">([^<]+)<\/th>/g))
        .map((match) => match[1])
        .filter((name) => name !== 'Attribute');

    expect(headers(forward).slice(0, 2)).toEqual(['Atlas Pro', 'Borealis Air']);
    expect(headers(backward).slice(0, 2)).toEqual(['Borealis Air', 'Atlas Pro']);
  });
});

describe('every value carries where it came from', () => {
  it('prints a checked date and at least one source for each stated cell', () => {
    const view = buildModelComparison(
      comparisonFixtures,
      [ATLAS_PRO, BOREALIS_AIR],
      COMPARISON_BASE,
      COMPARISON_TODAY,
    );
    const html = renderWith(comparisonFixtures, [ATLAS_PRO, BOREALIS_AIR]);

    const stated = view.presentGroups
      .flatMap((group) => group.rows)
      .flatMap((row) => row.cells)
      .filter((cell) => cell.state === 'stated');

    expect(stated.length).toBeGreaterThan(8);
    for (const cell of stated) {
      expect(cell.sources.length, `${cell.slug} ${cell.value}`).toBeGreaterThan(0);
      for (const source of cell.sources) {
        expect(html).toContain(source.url);
      }
    }
    expect(count(html, /Checked /g)).toBeGreaterThanOrEqual(stated.length);
  });

  it('links every source out rather than describing it', () => {
    const html = renderWith(comparisonFixtures, [ATLAS_PRO, BOREALIS_AIR]);
    expect(count(html, /rel="nofollow noopener external"/g)).toBeGreaterThan(0);
    expect(count(html, /comparison-source-meta/g)).toBeGreaterThan(0);
  });
});

describe('a gap is named, never blank', () => {
  it('tags each non-stated cell with the state and its reason', () => {
    const view = buildModelComparison(
      comparisonFixtures,
      [ATLAS_PRO, BOREALIS_AIR],
      COMPARISON_BASE,
      COMPARISON_TODAY,
    );
    const html = renderWith(comparisonFixtures, [ATLAS_PRO, BOREALIS_AIR]);
    const gaps = view.presentGroups
      .flatMap((group) => group.rows)
      .flatMap((row) => row.cells)
      .filter((cell) => cell.state !== 'stated');

    expect(gaps.length).toBeGreaterThan(0);
    for (const cell of gaps) {
      expect(html).toContain(`data-state="${cell.state}"`);
      expect(html).toContain(VALUE_STATE_LABELS[cell.state]);
      expect(cell.reason).toBeTruthy();
      expect(cell.value).not.toBe('');
    }
  });

  it('names the sections it cannot show instead of dropping them', () => {
    const view = buildModelComparison(
      comparisonFixturesWithoutOperations,
      [ATLAS_PRO, BOREALIS_AIR],
      COMPARISON_BASE,
      COMPARISON_TODAY,
    );
    const html = renderWith(comparisonFixturesWithoutOperations, [ATLAS_PRO, BOREALIS_AIR]);

    expect(view.absentGroups.length).toBeGreaterThan(0);
    expect(html).toContain('What this comparison does not show');
    for (const group of view.absentGroups) {
      expect(html).toContain(`data-group="${group.id}"`);
      expect(html).toContain(group.absence!.reason);
    }
  });

  it('explains each state it used, on the page', () => {
    const view = buildModelComparison(
      comparisonFixtures,
      [ATLAS_PRO, BOREALIS_AIR],
      COMPARISON_BASE,
      COMPARISON_TODAY,
    );
    const html = renderWith(comparisonFixtures, [ATLAS_PRO, BOREALIS_AIR]);

    expect(view.valueStateLegend.length).toBe(view.usedStates.length);
    for (const entry of view.valueStateLegend) {
      expect(html).toContain(entry.definition);
    }
  });
});

describe('benchmark rows show their comparability', () => {
  const html = renderWith(comparisonFixtures, [ATLAS_PRO, BOREALIS_AIR]);

  it('states the verdict and the policy version it came from', () => {
    const view = buildModelComparison(
      comparisonFixtures,
      [ATLAS_PRO, BOREALIS_AIR],
      COMPARISON_BASE,
      COMPARISON_TODAY,
    );
    const evidence = view.presentGroups
      .flatMap((group) => group.rows)
      .map((row) => row.evidence)
      .filter((item) => item !== null);

    expect(evidence.length).toBeGreaterThan(0);
    for (const item of evidence) {
      expect(html).toContain(item.summary);
      expect(html).toContain(`comparability policy ${item.policyVersion}`);
      expect(html).toContain(item.directionNote);
    }
  });

  it('keeps a blocked score visible with the reason beside it', () => {
    expect(html).toContain('data-state="not-comparable"');
    expect(count(html, /comparison-setup/g)).toBeGreaterThan(0);
  });
});

describe('choosing models', () => {
  it('offers every release as a real link, so no-JavaScript still works', () => {
    const html = renderWith(comparisonFixtures, [ATLAS_PRO]);
    for (const release of comparisonFixtures.releases) {
      expect(html).toContain(`models=`);
      expect(html).toContain(release.displayName);
    }
    expect(count(html, /class="comparison-candidate"/g)).toBe(comparisonFixtures.releases.length);
  });

  it('says what is still needed before a comparison can be drawn', () => {
    expect(renderWith(comparisonFixtures, [])).toContain('No models selected');
    expect(renderWith(comparisonFixtures, [ATLAS_PRO])).toContain('Choose 1 more to compare');
  });

  it('draws no table until two models are chosen', () => {
    expect(count(renderWith(comparisonFixtures, [ATLAS_PRO]), /<table/g)).toBe(0);
    expect(count(renderWith(comparisonFixtures, [ATLAS_PRO, BOREALIS_AIR]), /<table/g)).toBeGreaterThan(0);
  });

  it('reports a rejected slug in an alert that names it', () => {
    const html = renderWith(comparisonFixtures, [ATLAS_PRO, BOREALIS_AIR, 'no-such-model']);
    expect(html).toContain('role="alert"');
    expect(html).toContain('no-such-model');
    expect(html).toContain('data-code="unknown-model"');
  });

  it('names every model dropped for exceeding the limit', () => {
    const html = renderWith(comparisonFixtures, comparisonFixtures.releases.map((r) => r.slug));
    expect(html).toContain('data-code="over-capacity"');
    expect(count(html, /<th scope="col">/g) % (MAX_COMPARISON_MODELS + 1)).toBe(0);
  });
});

describe('against the shipped dataset, which is sparse', () => {
  const slugs = seedSlugs.slice(0, 3);
  const html = renderWith(seedPayload, slugs, '2026-08-27');

  it('never renders pricing or availability blank, whatever the dataset holds', () => {
    // Keyed on what the dataset holds rather than on a measured snapshot. At
    // merge-base fc418bb6 `raw.ts` composed neither pricing nor deployment JSON
    // and both groups read `not-collected`; operational records are exactly what
    // a data refresh lands, and an assertion pinned to the empty shape would fail
    // on the data rather than on the behaviour. What has to hold either way is
    // that neither section is silently blank: it renders rows, or it is named in
    // the open with the state that says why it is missing.
    const view = buildModelComparison(seedPayload, slugs, COMPARISON_BASE, '2026-08-27');
    const backing = { pricing: seedPayload.pricing, availability: seedPayload.deployments } as const;

    for (const id of ['pricing', 'availability'] as const) {
      const group = [...view.presentGroups, ...view.absentGroups].find((g) => g.id === id);
      expect(group, `${id} must appear in the view at all`).toBeDefined();

      if (group!.rows.length > 0) {
        expect(group!.absence, `${id} shows rows, so it must claim no absence`).toBeNull();
        expect(html).toContain(group!.title);
        continue;
      }

      const expected = backing[id].length === 0 ? 'not-collected' : 'unrecorded';
      expect(group!.absence, `${id} has no rows, so it must say why`).not.toBeNull();
      expect(group!.absence!.state).toBe(expected);
      expect(html).toContain('What this comparison does not show');
      expect(html).toMatch(new RegExp(`data-group="${id}"\\s+data-state="${expected}"`));
    }
  });

  it('still gives every stated cell a source and a date', () => {
    const view = buildModelComparison(seedPayload, slugs, COMPARISON_BASE, '2026-08-27');
    const stated = view.presentGroups
      .flatMap((group) => group.rows)
      .flatMap((row) => row.cells)
      .filter((cell) => cell.state === 'stated');

    expect(stated.length).toBeGreaterThan(10);
    for (const cell of stated) {
      expect(cell.verifiedAt, `${cell.slug}`).toBeTruthy();
      expect(cell.sources.length, `${cell.slug}`).toBeGreaterThan(0);
    }
  });

  it('warns a reader without JavaScript rather than showing them nothing', () => {
    expect(html).toContain('<noscript>');
    expect(html).toContain('Every value in this table is also on each model');
  });
});
