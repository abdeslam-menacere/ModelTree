import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import {
  COMPLETE_RELEASE_ID,
  DANGLING_RELATION_ID,
  FIXTURE_TODAY,
  OPEN_WEIGHT_RELEASE_ID,
  PROPRIETARY_RELEASE_ID,
  SPARSE_RELEASE_ID,
  passportFixtures,
} from '../../tests/fixtures/passport-dataset';
import {
  absentPositioning,
  completePositioning,
  multiSourcePositioning,
  partialPositioning,
  SECOND_BASE_SOURCE,
} from '../../tests/fixtures/passport-positioning';
import type { VariantPositioning } from '../data/variant-positioning-schema';
import { buildModelPassport } from '../lib/passport';
import ModelPassport from './ModelPassport';

const BASE = '/ModelTree/';
const TODAY = '2026-08-27';

const renderFixture = (releaseId: string) =>
  renderToStaticMarkup(
    <ModelPassport view={buildModelPassport(passportFixtures, releaseId, BASE, FIXTURE_TODAY)} />,
  );

const renderReal = (releaseId: string) =>
  renderToStaticMarkup(
    <ModelPassport view={buildModelPassport(dataset, releaseId, BASE, TODAY)} />,
  );

/** Counts real matches so a zero elsewhere reads as absence, not a broken probe. */
const count = (html: string, pattern: RegExp) => html.match(pattern)?.length ?? 0;

describe('the rendered passport carries what the sections promise', () => {
  const html = renderFixture(COMPLETE_RELEASE_ID);

  it('renders every section heading the view model marks present', () => {
    const view = buildModelPassport(passportFixtures, COMPLETE_RELEASE_ID, BASE, FIXTURE_TODAY);
    // This component owns seven of the ten sections; usage, fit, and sources are
    // rendered by the page from their own components.
    const owned = ['identity', 'lineage', 'technical', 'access', 'availability', 'pricing', 'history'];

    for (const id of owned) {
      const section = view.sections.find((candidate) => candidate.id === id)!;
      expect(html, `${id} heading should render`).toContain(`id="${section.headingId}"`);
      expect(html).toContain(`>${section.title}<`);
    }
  });

  it('labels every section by a heading that exists in the same markup', () => {
    const labelled = [...html.matchAll(/aria-labelledby="([^"]+)"/g)].map((match) => match[1]);
    // Positive control: the page really does use `aria-labelledby`, so the loop
    // below is checking something.
    expect(labelled.length).toBeGreaterThan(5);

    for (const id of labelled) {
      expect(html, `${id} must resolve to a heading`).toContain(`id="${id}"`);
    }
  });

  it('gives every id in the markup exactly one definition', () => {
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('AC1 — an absent section leaves the page, and says so', () => {
  it('renders the availability, pricing, and history sections when records exist', () => {
    const html = renderFixture(COMPLETE_RELEASE_ID);

    expect(html).toContain('id="availability-title"');
    expect(html).toContain('id="pricing-title"');
    expect(html).toContain('id="history-title"');
    // Nothing is missing, so the coverage roll-up must not appear at all.
    expect(html).not.toContain('not-recorded-title');
  });

  it('drops those sections and names them in the roll-up when records do not', () => {
    const html = renderFixture(SPARSE_RELEASE_ID);

    expect(html).not.toContain('id="availability-title"');
    expect(html).not.toContain('id="pricing-title"');
    expect(html).not.toContain('id="history-title"');
    expect(html).not.toContain('id="lineage-title"');

    expect(html).toContain('id="not-recorded-title"');
    for (const title of ['Where it is served', 'What it costs', 'What has changed', 'Where it fits']) {
      expect(html, `${title} should be named as absent`).toContain(`<dt>${title}</dt>`);
    }
  });

  it('never leaves an empty table behind when a section is dropped', () => {
    const html = renderFixture(SPARSE_RELEASE_ID);
    // A section that renders its own chrome but no rows is the failure this
    // guards: no table element should survive at all.
    expect(count(html, /<table/g)).toBe(0);
    expect(count(html, /<tbody><\/tbody>/g)).toBe(0);
  });

  it('numbers the sections it renders contiguously', () => {
    const numbers = [...renderFixture(SPARSE_RELEASE_ID)
      .matchAll(/class="section-number"[^>]*>(\d+)</g)]
      .map((match) => match[1]);

    expect(numbers.length).toBeGreaterThan(0);
    expect(numbers).toEqual(numbers.map((_, index) => String(index + 1).padStart(2, '0')));
  });
});

describe('AC3 — the pricing table states every required field', () => {
  const html = renderFixture(PROPRIETARY_RELEASE_ID);

  it('heads a column for each of currency, unit, region and tier, effective, and source', () => {
    for (const heading of ['Currency', 'Rates', 'Unit', 'Region and tier', 'Effective', 'Source']) {
      expect(html, `${heading} column should exist`)
        .toMatch(new RegExp(`<th scope="col"[^>]*>${heading}</th>`));
    }
  });

  it('prints the currency code, the unit, and the effective range in the body', () => {
    expect(html).toContain('<td>EUR</td>');
    expect(html).toMatch(/per 1K tokens|per 1k tokens/i);
    expect(html).toContain('Jan 20, 2026 to May 31, 2026');
    expect(html).toContain('From Jun 1, 2026');
  });

  it('marks a superseded price rather than showing two prices as equally current', () => {
    expect(count(html, /Superseded/g)).toBe(1);
  });

  it('names the region and tier where recorded and marks them absent where not', () => {
    expect(html).toContain('eu-west · Batch');
    expect(html).toMatch(/class="passport-unknown"[^>]*>Not recorded</);
  });

  it('links a source from every priced row', () => {
    // Scoped to the pricing table: this fixture also renders an availability
    // table, whose row headers would otherwise be counted here.
    const start = html.indexOf('Published prices recorded for');
    const pricingTable = html.slice(start, html.indexOf('</table>', start));
    expect(start).toBeGreaterThan(-1);

    const rows = count(pricingTable, /<th scope="row"[^>]*>/g);
    expect(rows).toBe(2);
    expect(count(pricingTable, /Example Cloud pricing/g)).toBe(rows);
  });

  it('flags a price that has not been re-checked recently', () => {
    expect(html).toMatch(/Not re-checked for \d+ days/);
  });

  it('says prices are never converted or normalised', () => {
    expect(html).toMatch(/not converted between currencies or/i);
  });
});

describe('AC4 — licence wording distinguishes downloadable weights from open source', () => {
  it('does not describe a non-OSI licence as open source', () => {
    const html = renderFixture(OPEN_WEIGHT_RELEASE_ID);

    expect(html).toContain('Weights are documented as downloadable.');
    expect(html).toContain('not recorded as OSI-approved');
    // Positive control first: "OSI" is genuinely on the page, so the absence of
    // the approving phrasing below is a real absence.
    expect(count(html, /OSI/g)).toBeGreaterThan(0);
    expect(html).not.toMatch(/is recorded as OSI-approved open source/);
  });

  it('states OSI approval where the record carries it', () => {
    const html = renderFixture(COMPLETE_RELEASE_ID);
    expect(html).toContain('recorded as OSI-approved open source');
    expect(html).toContain('Apache-2.0');
  });

  it('explains an absent licence instead of leaving the block empty', () => {
    const html = renderFixture(PROPRIETARY_RELEASE_ID);

    expect(html).not.toContain('<h3>Licence</h3>');
    expect(html).toMatch(/No licence record is held/);
    expect(html).toMatch(/not a claim that the model is unlicensed/);
  });

  it('links out to the methodology definition of access', () => {
    const html = renderFixture(COMPLETE_RELEASE_ID);
    expect(html).toContain(`href="${BASE}methodology/#access"`);
    expect(html).toMatch(/How ModelTree defines access and licensing/);
  });
});

describe('AC2 — lineage names what each relationship claims', () => {
  const html = renderFixture(COMPLETE_RELEASE_ID);

  it('renders one labelled group per relationship kind', () => {
    for (const kind of ['predecessor', 'successor', 'sibling', 'derivation']) {
      expect(html, `${kind} group should render`).toContain(`data-relationship="${kind}"`);
    }
  });

  it('links each related release at its canonical route', () => {
    expect(html).toContain(`href="${BASE}models/earlier-model/"`);
    expect(html).toContain(`href="${BASE}models/later-model/"`);
    expect(html).toContain(`href="${BASE}models/variant-model/"`);
    expect(html).toContain(`href="${BASE}models/foundation-model/"`);
  });

  it('discloses a relationship it cannot resolve rather than hiding it', () => {
    expect(html).toContain(DANGLING_RELATION_ID);
    expect(html).toMatch(/not yet in ModelTree/);
  });
});

describe('actions', () => {
  const html = renderFixture(COMPLETE_RELEASE_ID);

  it('offers compare, evidence, and report', () => {
    for (const kind of ['compare', 'evidence', 'report']) {
      expect(html).toContain(`data-action="${kind}"`);
    }
  });

  it('gives each action link text that says where it goes', () => {
    // "Click here" links are the failure mode; each label must stand alone.
    const labels = [...html.matchAll(/data-action="[^"]+"\s*>([^<]+)/g)].map((m) => m[1].trim());
    expect(labels).toHaveLength(3);
    for (const label of labels) expect(label.length).toBeGreaterThan(8);
  });

  it('marks the one action that leaves the site', () => {
    const nav = html.slice(0, html.indexOf('</nav>'));
    expect(count(nav, /lucide-external-link/g)).toBe(1);
  });
});

describe('tables are navigable', () => {
  const html = renderFixture(COMPLETE_RELEASE_ID);

  it('captions every table and scopes every header cell', () => {
    const tables = count(html, /<table/g);
    expect(tables).toBe(2);
    expect(count(html, /<caption/g)).toBe(tables);
    expect(count(html, /<th scope="col"/g)).toBeGreaterThan(0);
    expect(count(html, /<th scope="row"/g)).toBeGreaterThan(0);
  });

  it('makes each horizontally scrollable table reachable by keyboard', () => {
    // A scroll container that cannot take focus is unreachable to a keyboard
    // user, so the overflow styling requires the tabindex to be here.
    const scrollers = [...html.matchAll(/<div class="passport-table-scroll"[^>]*>/g)]
      .map((match) => match[0]);

    expect(scrollers).toHaveLength(2);
    for (const scroller of scrollers) {
      expect(scroller).toContain('tabindex="0"');
      expect(scroller).toContain('role="region"');
      expect(scroller).toMatch(/aria-label="[^"]+"/);
    }
  });
});

describe('the shipped dataset renders both branches across its releases', () => {
  it('renders availability and history only where a record backs them', () => {
    expect(dataset.releases.length).toBeGreaterThan(0);

    let present = 0;
    let absent = 0;

    for (const release of dataset.releases) {
      const html = renderReal(release.id);
      const deployed = dataset.deployments.some((item) => item.releaseId === release.id);
      const evented = dataset.releaseEvents.some((item) => item.releaseId === release.id);

      // Positive control: identity always renders, so a presence or an absence
      // below is about that section and not about a render that failed.
      expect(html, `${release.slug} should render identity`).toContain('id="identity-title"');
      expect(html.includes('id="availability-title"'), release.slug).toBe(deployed);
      expect(html.includes('id="history-title"'), release.slug).toBe(evented);
      // No release carries a sourced price, so this section never renders and
      // something is therefore always left unrecorded.
      expect(html, release.slug).not.toContain('id="pricing-title"');
      expect(html, release.slug).toContain('id="not-recorded-title"');

      if (deployed && evented) present += 1;
      if (!deployed && !evented) absent += 1;
    }

    // Both branches must be reached, or the per-release assertions above are
    // satisfied by data that only ever exercises one of them.
    expect(present).toBeGreaterThan(0);
    expect(absent).toBeGreaterThan(0);
  });

  it('renders a table exactly when a deployment backs one', () => {
    // Availability and pricing are the only sections built as tables
    // (ModelPassport.tsx:291 and :350), and no release has a sourced price, so
    // a deployment is the whole of what puts a table on the page.
    for (const release of dataset.releases) {
      const deployed = dataset.deployments.some((item) => item.releaseId === release.id);
      expect(count(renderReal(release.id), /<table/g), `${release.slug}`).toBe(deployed ? 1 : 0);
    }
  });

  it('offers all three actions on every real release', () => {
    for (const release of dataset.releases) {
      const html = renderReal(release.id);
      for (const kind of ['compare', 'evidence', 'report']) {
        expect(html, `${release.slug} should offer ${kind}`).toContain(`data-action="${kind}"`);
      }
    }
  });
});

/**
 * The three coverage states, rendered.
 *
 * Rendering is where the constraints in issue #38 are actually kept or broken:
 * a view model can hold the creator's words and ModelTree's separately and still
 * ship markup that runs them together. Each state is asserted against real HTML
 * for that reason.
 */
describe('sibling tier positioning is rendered so the two voices stay apart', () => {
  const renderPositioned = (releaseId: string, records: VariantPositioning) =>
    renderToStaticMarkup(
      <ModelPassport
        view={buildModelPassport(passportFixtures, releaseId, BASE, FIXTURE_TODAY, records)}
      />,
    );

  const complete = renderPositioned(COMPLETE_RELEASE_ID, completePositioning);

  it('quotes the creator inside a blockquote that names who said it and when', () => {
    expect(complete).toContain('<blockquote class="tier-official">');
    expect(complete).toContain('Our general-purpose model for long-running document work');
    // The attribution is text inside the quote's own footer, so it is read out
    // with the quote rather than inferred from a colour or a position.
    expect(complete).toMatch(/<footer>Example Lab wrote this, current as of [^<]*Aug 20, 2026/);
  });

  it('labels ModelTree\'s reading in words rather than by styling', () => {
    expect(complete).toContain('>ModelTree editorial summary<');
    expect(complete).toContain('>ModelTree editorial note<');

    // The label has to be inside the element a screen reader reaches, not a
    // class name on it: strip the stylesheet and the sentence still says whose
    // words these are.
    const editorial = [...complete.matchAll(/<p class="tier-editorial">(.*?)<\/p>/gs)]
      .map((match) => match[1])
      .find((block) => block.includes('ModelTree editorial summary')) ?? '';
    expect(editorial).toContain('ModelTree editorial summary');
    expect(editorial).toContain('Example Lab describes the base name');
  });

  it('marks which tier this release is, in text', () => {
    // `complete-release` carries variant `base`, so `base` is marked and `mini`
    // is not. A count of one proves the marker is specific rather than global.
    expect(count(complete, /tier-this-release/g)).toBe(1);
    expect(complete).toContain('— this release');
  });

  it('names the methodology page rule it is bound by', () => {
    expect(complete).toContain(`href="${BASE}methodology/#guidance"`);
  });

  /**
   * A name cited to several pages.
   *
   * `sources` is `min(1)` and unbounded, and the block used to render
   * `sources[0]`, so a second and third page could be recorded, verified, and
   * gated — and then never shown. That is the evidence trail reading shorter
   * than the evidence, at the one point where a reader is being asked to trust
   * it, and nothing anywhere said so.
   */
  describe('a tier name whose positioning rests on more than one page', () => {
    const multi = renderPositioned(COMPLETE_RELEASE_ID, multiSourcePositioning);
    const baseEntryBlock = multi.match(/<div class="tier-entry" data-variant="base">[\s\S]*?(?=<div class="tier-entry")/)?.[0] ?? '';

    it('quotes every page rather than the first one', () => {
      expect(baseEntryBlock, 'expected the base tier entry to render').not.toBe('');
      expect(baseEntryBlock).toContain('Our general-purpose model for long-running document work');
      expect(baseEntryBlock).toContain(SECOND_BASE_SOURCE.quote);
    });

    it('gives each page its own blockquote, link and check date', () => {
      expect(count(baseEntryBlock, /<blockquote class="tier-official">/g)).toBe(2);
      expect(baseEntryBlock).toContain('href="https://example-lab.test/docs/models"');
      expect(baseEntryBlock).toContain(`href="${SECOND_BASE_SOURCE.url}"`);
      // Both pages carry the same publisher, so what tells them apart has to be
      // their own text: the title and the date this one was last checked.
      expect(baseEntryBlock).toContain('Model line-up');
      expect(baseEntryBlock).toContain(SECOND_BASE_SOURCE.title);
      expect(baseEntryBlock).toContain('Aug 21, 2026');
    });

    it('says in words how many pages the name rests on', () => {
      // A reader should not have to count blockquotes to learn the evidence is
      // plural, and a screen reader reaches the sentence before the quotes.
      expect(baseEntryBlock).toContain('2 pages are recorded for this name');
    });

    it('leaves a single-source name in the same family showing one quotation', () => {
      const miniBlock = multi.match(/<div class="tier-entry" data-variant="mini">[\s\S]*?<\/div>/)?.[0] ?? '';
      expect(miniBlock, 'expected the mini tier entry to render').not.toBe('');
      expect(count(miniBlock, /<blockquote class="tier-official">/g)).toBe(1);
      expect(miniBlock).not.toContain('pages are recorded for this name');
    });
  });

  it('states an unpositioned name as unknown instead of dropping or guessing it', () => {
    const partial = renderPositioned(COMPLETE_RELEASE_ID, partialPositioning);

    expect(partial).toContain('data-variant="mini"');
    expect(partial).toContain('No statement from Example of what this name is for is');
    // The guessing this replaces: nothing infers a meaning from the name itself.
    expect(partial).toContain('does not infer a tier&#x27;s meaning from its name');
  });

  it('says a whole family is unrecorded once, listing the names it cannot explain', () => {
    const absent = renderPositioned(COMPLETE_RELEASE_ID, absentPositioning);

    expect(absent).toContain('has published no statement ModelTree could verify');    expect(absent).toContain('base, mini');
    // Said once for the family, not repeated under every name.
    expect(count(absent, /tier-entry/g)).toBe(0);
  });

  it('names no creator but this release\'s own, in any coverage state', () => {
    // The issue's flat non-goal. `Example Cloud` is the fixture's other
    // organization and appears elsewhere on the page, so this is scoped to the
    // block under test rather than to the whole document.
    for (const html of [complete, renderPositioned(COMPLETE_RELEASE_ID, partialPositioning),
      renderPositioned(COMPLETE_RELEASE_ID, absentPositioning)]) {
      const block = html.match(/<div class="tier-positioning">.*?<\/section>/s)?.[0] ?? '';
      expect(block.length, 'expected the tier block to render').toBeGreaterThan(0);
      expect(block).not.toContain('Example Cloud');
      expect(block).not.toContain('ExCloud');
    }
  });

  it('ships no client island, so the passport route stays free of new script', () => {
    // `[slug].astro` renders this component with no `client:` directive; the
    // markup is proof the block needs none, since it renders whole from the
    // server with no hydration marker in it.
    expect(complete).not.toContain('astro-island');
    expect(complete).not.toContain('client:');
  });
});

describe('rendered markup snapshots', () => {
  it('complete', () => expect(renderFixture(COMPLETE_RELEASE_ID)).toMatchSnapshot());
  it('sparse', () => expect(renderFixture(SPARSE_RELEASE_ID)).toMatchSnapshot());
  it('proprietary', () => expect(renderFixture(PROPRIETARY_RELEASE_ID)).toMatchSnapshot());
  it('open weight', () => expect(renderFixture(OPEN_WEIGHT_RELEASE_ID)).toMatchSnapshot());
});
