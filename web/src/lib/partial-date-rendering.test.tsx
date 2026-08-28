import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import ModelCatalog from '../components/ModelCatalog';
import ModelPassport from '../components/ModelPassport';
import { rawDataset } from '../data/raw';
import { validateDataset } from '../data/validate';
import { buildCatalogIndex } from './catalog';
import { formatReleaseDate } from './format';
import { buildLineageEcosystems } from './lineage-view';
import { buildModelTree } from './model-tree';
import { buildModelPassport } from './passport';

const BASE = '/ModelTree/';
const TODAY = '2026-08-28';

/**
 * Criteria 3 and 6 of the partial-date issue, measured on the real dataset.
 *
 * Every committed record dated inside one chosen month is coarsened to that
 * month, and the surfaces are then checked for the day that record used to
 * print. The month is cleared entirely rather than one record coarsened, because
 * the others in it keep their days and would satisfy a page-wide probe on their
 * own.
 *
 * The probe is the *exact rendered day string* of each coarsened record, taken
 * from the unmodified dataset, rather than a regex for "a day in March". That
 * distinction is load-bearing: a general pattern also matches `verifiedAt`,
 * prose like "introduced on 2026-03-05", and vendor aliases such as
 * `gpt-5.4-2026-03-05`, none of which are this issue's business and all of which
 * must keep their days.
 */
const MONTH = '2026-03';

function coarsen() {
  const input = structuredClone(rawDataset) as Record<string, any>;
  const coarsened: Array<{ id: string; renderedDay: string }> = [];

  for (const release of input.releases as any[]) {
    if (!release.releaseDate.startsWith(`${MONTH}-`)) continue;
    coarsened.push({
      id: release.id,
      renderedDay: formatReleaseDate(release.releaseDate, release.datePrecision),
    });
    release.releaseDate = MONTH;
    release.datePrecision = 'month';
  }

  for (const family of input.families as any[]) {
    if (!family.firstReleaseDate.startsWith(`${MONTH}-`)) continue;
    family.firstReleaseDate = MONTH;
    family.datePrecision = 'month';
  }

  return { dataset: validateDataset(input), coarsened };
}

/** Every `releaseDate`/`firstReleaseDate` a view model carries, at any depth. */
function datesIn(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) datesIn(item, found);
  } else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const field of ['releaseDate', 'firstReleaseDate']) {
      if (typeof record[field] === 'string') found.push(record[field] as string);
    }
    for (const nested of Object.values(record)) datesIn(nested, found);
  }
  return found;
}

const original = validateDataset(structuredClone(rawDataset));
const { dataset, coarsened } = coarsen();

describe('a month-precision record renders as a month everywhere it appears', () => {
  it('coarsened a non-empty set of real records that the validator then accepted', () => {
    // Without this the whole file could pass by having changed nothing at all.
    expect(coarsened.length).toBeGreaterThan(0);

    for (const { id } of coarsened) {
      const stored = dataset.releases.find((release) => release.id === id)!;
      expect(stored.releaseDate).toBe(MONTH);
      expect(stored.datePrecision).toBe('month');
    }
  });

  it('renders the month, and not the day it used to render, in the catalog', () => {
    // Only the coarsened rows are handed to the component. The catalog paginates
    // at `CATALOG_PAGE_SIZE`, so rendering the whole index would leave these
    // rows off the first page and the assertions below would hold for the
    // uninteresting reason that nothing was rendered.
    const index = buildCatalogIndex(dataset, BASE);
    const models = index.models.filter((row) => row.releaseDate === MONTH);
    expect(models.length).toBeGreaterThan(0);

    const html = renderToStaticMarkup(<ModelCatalog models={models} facets={index.facets} />);

    expect(html).toContain('Mar 2026');
    for (const { id, renderedDay } of coarsened) {
      expect(html, `${id} must no longer print ${renderedDay}`).not.toContain(renderedDay);
    }
  });

  it('renders the month, and not the day it used to render, on each passport', () => {
    for (const { id, renderedDay } of coarsened) {
      const html = renderToStaticMarkup(
        <ModelPassport view={buildModelPassport(dataset, id, BASE, TODAY)} />,
      );

      expect(html, `${id} should show its month`).toContain('Mar 2026');
      expect(html, `${id} must no longer print ${renderedDay}`).not.toContain(renderedDay);
    }
  });

  it('carries no widened date in any view model that stores one', () => {
    const widened = new RegExp(`^${MONTH}-\\d{2}$`);
    const surfaces: Array<[string, unknown]> = [
      ['model tree', buildModelTree(dataset)],
      ['lineage', buildLineageEcosystems(dataset)],
      ['catalog index', buildCatalogIndex(dataset, BASE)],
    ];

    const carryingTheMonth: string[] = [];

    for (const [name, view] of surfaces) {
      const dates = datesIn(view);

      // Positive control: this surface really does carry dates, so the filter
      // below is looking at something.
      expect(dates.length, `${name} should carry dates`).toBeGreaterThan(0);
      expect(dates.filter((date) => widened.test(date)), `${name} widened the month back to a day`)
        .toEqual([]);
      if (dates.includes(MONTH)) carryingTheMonth.push(name);
    }

    // Not every surface shows every release -- lineage only covers releases with
    // recorded relationships -- so requiring the month on all three would assert
    // a fact about today's data rather than about precision. Requiring it
    // somewhere still rules out the reading where no surface saw the record and
    // the absence of a widened date meant nothing.
    expect(carryingTheMonth.length, 'no surface carried the coarsened month at all')
      .toBeGreaterThan(0);
  });
});

describe('the day-probes are capable of firing', () => {
  /*
   * The differential control. Every assertion above is an absence, which is
   * indistinguishable from a probe that could never have matched. So the exact
   * same strings are searched for in the unmodified render, where those records
   * keep their days and the strings must therefore be present.
   */
  it('finds each day string in the catalog rendered from unmodified data', () => {
    const index = buildCatalogIndex(original, BASE);
    const models = index.models.filter((row) => row.releaseDate.startsWith(`${MONTH}-`));
    expect(models.length).toBeGreaterThan(0);

    const html = renderToStaticMarkup(<ModelCatalog models={models} facets={index.facets} />);

    for (const { id, renderedDay } of coarsened) {
      expect(html, `${id}: the probe "${renderedDay}" never matched, so its absence proves nothing`)
        .toContain(renderedDay);
    }
  });

  it('finds each day string on the passport rendered from unmodified data', () => {
    for (const { id, renderedDay } of coarsened) {
      const html = renderToStaticMarkup(
        <ModelPassport view={buildModelPassport(original, id, BASE, TODAY)} />,
      );

      expect(html, `${id}: the probe "${renderedDay}" never matched, so its absence proves nothing`)
        .toContain(renderedDay);
    }
  });

  it('leaves every date outside the coarsened month untouched', () => {
    // The other half of "no rendered output changed": coarsening one month must
    // not have moved anything else.
    const before = datesIn(buildCatalogIndex(original, BASE)).filter((d) => !d.startsWith(MONTH));
    const after = datesIn(buildCatalogIndex(dataset, BASE)).filter((d) => !d.startsWith(MONTH));

    expect(before.length).toBeGreaterThan(0);
    expect(after.sort()).toEqual(before.sort());
  });
});
