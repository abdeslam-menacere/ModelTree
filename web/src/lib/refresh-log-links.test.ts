import { describe, expect, it } from 'vitest';
import { refreshLog } from '../data/refresh-log';
import type { RefreshRun } from '../data/refresh-log-schema';
import { dataset } from '../data/dataset';
import { buildModelTree, modelTreeReleaseIds } from './model-tree';
import {
  postedDocumentLinks,
  postedRecordLink,
  postedRecordLinks,
  runCommit,
  type LinkableDataset,
} from './refresh-log-links';

const OPTIONS = { base: '/', treeReleaseIds: ['r-new', 'r-old'] };

const DATA: LinkableDataset = {
  organizations: [{ id: 'acme', name: 'Acme', shortName: 'Acme' }],
  families: [
    { id: 'acme-muse', name: 'Acme Muse' },
    { id: 'acme-hidden', name: 'Acme Hidden' },
  ],
  releases: [
    {
      id: 'r-old',
      slug: 'acme-muse-1',
      displayName: 'Acme Muse 1',
      familyId: 'acme-muse',
      organizationId: 'acme',
      releaseDate: '2025-01-01',
    },
    {
      id: 'r-new',
      slug: 'acme-muse-2',
      displayName: 'Acme Muse 2',
      familyId: 'acme-muse',
      organizationId: 'acme',
      releaseDate: '2026-01-01',
    },
    {
      id: 'r-untreed',
      slug: 'acme-hidden-1',
      displayName: 'Acme Hidden 1',
      familyId: 'acme-hidden',
      organizationId: 'acme',
      releaseDate: '2026-02-01',
    },
  ],
};

function run(overrides: Partial<RefreshRun> = {}): RefreshRun {
  return {
    id: '2026-01-02-aaaaaa',
    title: 'Data refresh 2026-01-02',
    ranOn: '2026-01-02',
    outcome: 'no-change',
    summary: 'Nothing to change.',
    scope: 'Every creator',
    stages: [{ stage: 'preflight', status: 'ran', note: 'Clean tree.' }],
    found: { scouts: 1, pagesFetched: 4, claimsProposed: 0, bundles: [], claimsByKind: [], notCovered: [] },
    evaluated: {
      reviewers: 0,
      verdictsCast: 0,
      acceptedByPanel: 0,
      rejectedByPanel: 0,
      dissents: [],
      gates: [{
        gate: 'gate-dataset',
        scope: 'working tree',
        exitCode: 0,
        outcome: 'pass',
        required: true,
        detail: 'Coherent.',
      }],
    },
    posted: { editsApplied: 0, documents: [], records: [] },
    withheld: [],
    caveats: ['Form, not remote content.'],
    followUps: [],
    references: [{ kind: 'issue', label: 'Issue #1', url: 'https://example.com/1' }],
    recordedAt: '2026-01-02',
    ...overrides,
  } as RefreshRun;
}

describe('postedRecordLink', () => {
  it('links a release to the passport page the build generates for its slug', () => {
    const link = postedRecordLink(
      { id: 'r-new', collection: 'releases', note: 'New release.' },
      DATA,
      OPTIONS,
    );

    expect(link).toMatchObject({
      label: 'Acme Muse 2',
      href: '/models/acme-muse-2/',
      target: 'passport',
      resolved: true,
    });
  });

  it('reaches a family through its newest release, because the tree selects releases', () => {
    const link = postedRecordLink(
      { id: 'acme-muse', collection: 'families', note: 'New family.' },
      DATA,
      OPTIONS,
    );

    expect(link).toMatchObject({ label: 'Acme Muse', href: '/tree/?model=r-new', target: 'tree' });
  });

  it('reaches a creator the same way', () => {
    const link = postedRecordLink(
      { id: 'acme', collection: 'organizations', note: 'Field corrected.' },
      DATA,
      OPTIONS,
    );

    expect(link).toMatchObject({ label: 'Acme', href: '/tree/?model=r-new', resolved: true });
  });

  it('names a family the tree cannot open without offering a link into it', () => {
    const link = postedRecordLink(
      { id: 'acme-hidden', collection: 'families', note: 'New family.' },
      DATA,
      OPTIONS,
    );

    expect(link).toMatchObject({ label: 'Acme Hidden', resolved: true });
    expect(link.href).toBeUndefined();
    expect(link.target).toBeUndefined();
  });

  it('reports a record that has left the dataset instead of linking to a missing page', () => {
    const link = postedRecordLink(
      { id: 'r-renamed', collection: 'releases', note: 'New release.' },
      DATA,
      OPTIONS,
    );

    expect(link).toEqual({
      record: { id: 'r-renamed', collection: 'releases', note: 'New release.' },
      label: 'r-renamed',
      resolved: false,
    });
  });

  it('does not guess at a collection it has no route for', () => {
    const link = postedRecordLink(
      { id: 'openai-deprecations', collection: 'sources', note: 'New source.' },
      DATA,
      OPTIONS,
    );

    expect(link).toMatchObject({ label: 'openai-deprecations', resolved: false });
    expect(link.href).toBeUndefined();
  });

  it('honours a base path the site is served under', () => {
    const link = postedRecordLink(
      { id: 'r-new', collection: 'releases', note: 'New release.' },
      DATA,
      { ...OPTIONS, base: '/ModelTree/' },
    );

    expect(link.href).toBe('/ModelTree/models/acme-muse-2/');
  });

  it('does not run a base path without its trailing slash into the route', () => {
    const link = postedRecordLink(
      { id: 'r-new', collection: 'releases', note: 'New release.' },
      DATA,
      { ...OPTIONS, base: '/ModelTree' },
    );

    expect(link.href).toBe('/ModelTree/models/acme-muse-2/');
  });
});

describe('postedRecordLinks', () => {
  it('keeps the run order, one link per recorded record', () => {
    const links = postedRecordLinks(
      run({
        posted: {
          editsApplied: 2,
          documents: [],
          records: [
            { id: 'acme-muse', collection: 'families', note: 'New family.' },
            { id: 'r-new', collection: 'releases', note: 'New release.' },
          ],
        },
      }),
      DATA,
      OPTIONS,
    );

    expect(links.map(({ label }) => label)).toEqual(['Acme Muse', 'Acme Muse 2']);
  });

  it('returns nothing for a run that posted nothing', () => {
    expect(postedRecordLinks(run(), DATA, OPTIONS)).toEqual([]);
  });
});

describe('runCommit', () => {
  it('reads the repository and sha out of a commit reference', () => {
    expect(runCommit(run({
      references: [
        { kind: 'issue', label: 'Issue #1', url: 'https://example.com/1' },
        { kind: 'commit', label: '0e9867b', url: 'https://github.com/owner/repo/commit/0e9867b' },
      ],
    }))).toEqual({ owner: 'owner', repo: 'repo', sha: '0e9867b' });
  });

  it('ignores a commit reference that is not a GitHub commit url', () => {
    expect(runCommit(run({
      references: [{ kind: 'commit', label: 'somewhere', url: 'https://example.com/commit/0e9867b' }],
    }))).toBeUndefined();
  });

  it('is undefined when the run recorded no commit at all', () => {
    expect(runCommit(run())).toBeUndefined();
  });
});

describe('postedDocumentLinks', () => {
  const documents = [
    { document: 'releases.json', recordsBefore: 22, recordsAfter: 31, note: 'Nine releases added.' },
  ];

  it('links a document at the commit the run landed, not at the current branch', () => {
    const links = postedDocumentLinks(run({
      posted: { editsApplied: 9, documents, records: [] },
      references: [
        { kind: 'commit', label: '0e9867b', url: 'https://github.com/owner/repo/commit/0e9867b' },
      ],
    }));

    expect(links).toHaveLength(1);
    expect(links[0]?.href).toBe(
      'https://github.com/owner/repo/blob/0e9867b/web/src/data/releases.json',
    );
  });

  it('still lists the document when there is no commit to anchor it to', () => {
    const links = postedDocumentLinks(run({
      posted: { editsApplied: 9, documents, records: [] },
    }));

    expect(links[0]?.document.document).toBe('releases.json');
    expect(links[0]?.href).toBeUndefined();
  });
});

describe('the committed log against the live dataset', () => {
  const options = {
    base: '/',
    treeReleaseIds: modelTreeReleaseIds(buildModelTree(dataset)),
  };

  it('resolves every record the log says was posted, so no entry links nowhere', () => {
    const unresolved = refreshLog
      .flatMap((entry) => postedRecordLinks(entry, dataset, options))
      .filter(({ resolved }) => !resolved)
      .map(({ record }) => `${record.collection}/${record.id}`);

    expect(unresolved).toEqual([]);
  });

  it('only offers passport links the model route actually builds', () => {
    const slugs = new Set(dataset.releases.map(({ slug }) => slug));
    const passports = refreshLog
      .flatMap((entry) => postedRecordLinks(entry, dataset, options))
      .filter(({ target }) => target === 'passport');

    expect(passports.length).toBeGreaterThan(0);
    for (const { href } of passports) {
      expect(slugs.has(href!.replace('/models/', '').replace('/', ''))).toBe(true);
    }
  });
});
