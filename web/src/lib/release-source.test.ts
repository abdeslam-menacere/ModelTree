import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dataset, sourceById } from '../data/dataset';
import type { SourceReference } from '../data/schema';
import {
  buildReleaseSourceIndex,
  countReleaseCitations,
  selectReleaseSource,
} from './release-source';

/**
 * Guards that which source a release cites is decided by something declared,
 * never by where an id happens to sit in `releases.json`.
 *
 * `sourceIds` order is undeclared: `schema.ts` carries 13
 * `sourceIds: z.array(entityId).min(1)` declarations, none with a `.max()` and
 * none with an ordering comment, and nothing sorts the array between the JSON
 * and the page. Permuting it is therefore a semantically null edit, so the
 * cited source must not move when it happens.
 */

const permutations = (ids: readonly string[]): readonly string[][] => [
  [...ids].reverse(),
  [...ids].sort(),
  [...ids].sort().reverse(),
];

/** The pre-fix expression, kept as the control that the dataset still exercises
 * the defect. If this stops finding order dependence, the guard below has gone
 * vacuous and must fail loudly rather than pass for free. */
const legacySelect = (ids: readonly string[]) =>
  ids
    .map((sourceId) => sourceById.get(sourceId))
    .find((candidate) => candidate?.type === 'official-docs')
    ?? sourceById.get(ids[0]);

const source = (id: string, type: SourceReference['type']): SourceReference => ({
  id,
  url: `https://example.invalid/${id}`,
  title: `Title for ${id}`,
  type,
  publisherId: 'example-publisher',
  lastCheckedDate: '2026-01-01',
});

const mapOf = (...entries: SourceReference[]) =>
  new Map(entries.map((entry) => [entry.id, entry]));

describe('release source selection is permutation-invariant', () => {
  it('cites the same source for every release when sourceIds are reordered', () => {
    const committed = buildReleaseSourceIndex(dataset.releases, sourceById);

    for (const permute of [0, 1, 2]) {
      const reordered = buildReleaseSourceIndex(
        dataset.releases.map((release) => ({
          ...release,
          sourceIds: permutations(release.sourceIds)[permute],
        })),
        sourceById,
      );
      expect(reordered).toEqual(committed);
    }
  });

  it('CONTROL: the committed dataset still contains order-dependent releases', () => {
    // A positive control for the negative claim above. Were this zero, the
    // guard would be asserting invariance over a population that cannot vary,
    // and its green would mean nothing.
    const orderDependent = dataset.releases.filter(
      (release) => legacySelect(release.sourceIds)?.id
        !== legacySelect([...release.sourceIds].reverse())?.id,
    );
    expect(orderDependent.length).toBeGreaterThan(0);
  });

  it('CONTROL: reordering actually changes the input array for some release', () => {
    const reordered = dataset.releases.filter(
      (release) => release.sourceIds.join() !== [...release.sourceIds].reverse().join(),
    );
    expect(reordered.length).toBeGreaterThan(0);
  });
});

describe('selectReleaseSource', () => {
  it('is invariant when a release cites several official-docs sources', () => {
    const sources = mapOf(
      source('zeta-docs', 'official-docs'),
      source('alpha-docs', 'official-docs'),
    );
    const forward = selectReleaseSource(['zeta-docs', 'alpha-docs'], sources, 'r');
    const backward = selectReleaseSource(['alpha-docs', 'zeta-docs'], sources, 'r');
    expect(forward.id).toBe(backward.id);
  });

  it('is invariant when a release cites no official-docs source at all', () => {
    // The shape that makes the `?? sourceById.get(sourceIds[0])` arm observable:
    // two or more sources, none of them official-docs. That arm indexes the RAW
    // id array, so sorting only the mapped candidates leaves this red.
    const sources = mapOf(
      source('zeta-announcement', 'official-announcement'),
      source('alpha-announcement', 'official-announcement'),
    );
    const forward = selectReleaseSource(['zeta-announcement', 'alpha-announcement'], sources, 'r');
    const backward = selectReleaseSource(['alpha-announcement', 'zeta-announcement'], sources, 'r');
    expect(forward.id).toBe(backward.id);
  });

  it('is invariant across source types when none is official-docs', () => {
    const sources = mapOf(
      source('a-repo', 'repository'),
      source('b-card', 'model-card'),
      source('c-announcement', 'official-announcement'),
    );
    const ids = ['a-repo', 'b-card', 'c-announcement'];
    const picks = new Set(
      [ids, [...ids].reverse(), [ids[1], ids[0], ids[2]]].map(
        (order) => selectReleaseSource(order, sources, 'r').id,
      ),
    );
    expect([...picks]).toHaveLength(1);
  });

  it('throws when a release resolves to no source at all', () => {
    expect(() => selectReleaseSource(['missing'], mapOf(), 'lonely-release')).toThrow(
      'No source found for lonely-release',
    );
  });
});

describe('the specificity tiebreak', () => {
  const sources = mapOf(
    source('a-overview', 'official-docs'),
    source('z-release-docs', 'official-docs'),
  );
  const ids = ['a-overview', 'z-release-docs'];

  it('prefers the document cited by fewer releases, in either order', () => {
    // `a-overview` wins on id alone, so this fails if the layer goes inert.
    const citations = new Map([['a-overview', 9], ['z-release-docs', 1]]);
    for (const order of [ids, [...ids].reverse()]) {
      expect(selectReleaseSource(order, sources, 'r', citations).id).toBe('z-release-docs');
    }
  });

  it('CONTROL: without the citation counts the id decides instead', () => {
    // The other side of the same instrument. Were this also `z-release-docs`,
    // the test above would be passing for a reason unrelated to specificity.
    for (const order of [ids, [...ids].reverse()]) {
      expect(selectReleaseSource(order, sources, 'r').id).toBe('a-overview');
    }
  });

  it('counts each release once and does not depend on sourceIds order', () => {
    const releases = [
      { sourceIds: ['shared', 'shared', 'narrow'] },
      { sourceIds: ['narrow-two', 'shared'] },
    ] as unknown as Parameters<typeof countReleaseCitations>[0];
    const counts = countReleaseCitations(releases);
    expect(counts.get('shared')).toBe(2);
    expect(counts.get('narrow')).toBe(1);
    expect(counts.get('narrow-two')).toBe(1);
  });
});

describe('every page reads the shared selector', () => {
  const pages = {
    index: new URL('../pages/index.astro', import.meta.url),
    tree: new URL('../pages/tree.astro', import.meta.url),
    provider: new URL('../pages/providers/[slug].astro', import.meta.url),
  } as const;

  for (const [name, url] of Object.entries(pages)) {
    it(`${name}.astro selects through release-source.ts`, () => {
      const text = readFileSync(url, 'utf8');
      expect(text).toContain('buildReleaseSourceIndex');
      expect(text).not.toContain('sourceIds[0]');
      expect(text).not.toContain("candidate?.type === 'official-docs'");
    });
  }
});
