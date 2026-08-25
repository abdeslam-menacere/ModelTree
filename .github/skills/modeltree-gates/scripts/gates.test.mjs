#!/usr/bin/env node
// Self-tests for the deterministic gates. Run with:
//   node --test .github/skills/modeltree-gates/scripts/
//
// The point of these is narrow and specific: a gate that has only ever been
// seen to pass is indistinguishable from a gate that cannot fail. Every rule
// below is proved to fire by breaking the data in exactly the way it exists to
// catch, and the live repository dataset is asserted to pass, so the suite
// fails both when a gate goes blind and when a gate goes paranoid.
//
// No dependencies. Node's built-in runner only.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const DATA = join(REPO, 'web', 'src', 'data');
const GATE_DATASET = join(HERE, 'gate-dataset.mjs');
const GATE_EVIDENCE = join(HERE, 'gate-evidence.mjs');
const GATE_SCOPE = join(HERE, 'gate-scope.mjs');
const GATE_SOURCE_APPROVAL = join(HERE, 'gate-source-approval.mjs');

// A date the fixtures are anchored to, so a passing suite today still passes in
// a year. Real "today" is never used: these tests would then drift.
const TODAY = '2026-08-25';

function run(script, args) {
  try {
    const stdout = execFileSync('node', [script, ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (error) {
    if (typeof error.status !== 'number') throw error;
    return { code: error.status, stdout: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

/** A scratch copy of the real dataset, mutated by `edit`, then gated. */
function gateMutatedDataset(edit) {
  const dir = mkdtempSync(join(tmpdir(), 'modeltree-gate-'));
  try {
    cpSync(DATA, dir, { recursive: true });
    const read = (file) => JSON.parse(readFileSync(join(dir, file), 'utf8'));
    const write = (file, value) => writeFileSync(join(dir, file), JSON.stringify(value, null, 2));
    edit({ read, write });
    return run(GATE_DATASET, ['--data', dir, '--today', TODAY, '--json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Asserts the gate failed, and failed for the stated reason rather than any reason. */
function assertFailed(result, gate, fragment) {
  assert.equal(result.code, 1, `expected exit 1, got ${result.code}:\n${result.stdout}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.passed, false);
  const matching = report.failures.filter((failure) => failure.gate === gate);
  assert.ok(
    matching.length > 0,
    `expected a "${gate}" failure, got: ${report.failures.map((f) => f.gate).join(', ') || '(none)'}`,
  );
  if (fragment) {
    assert.ok(
      matching.some((failure) => failure.message.includes(fragment)),
      `expected a "${gate}" failure mentioning "${fragment}", got:\n${matching.map((f) => f.message).join('\n')}`,
    );
  }
}

// ---------------------------------------------------------------------------

describe('gate-dataset', () => {
  test('the repository dataset passes as it stands', () => {
    const result = run(GATE_DATASET, ['--data', DATA, '--today', TODAY, '--json']);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.failures, [], 'the live dataset must pass its own gates');
    assert.equal(result.code, 0);
    assert.ok(report.counts.releases > 0, 'the fixture-free dataset should not be empty');
  });

  test('an unchanged copy of the dataset also passes, so the harness itself is honest', () => {
    const result = gateMutatedDataset(() => {});
    assert.equal(result.code, 0, result.stdout);
  });

  test('a broken source reference is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      releases[0].sourceIds = ['a-source-that-was-never-added'];
      write('releases.json', releases);
    });
    assertFailed(result, 'references', 'does not resolve to a source');
  });

  test('a verification date in the future is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      releases[0].verifiedAt = '2027-01-01';
      write('releases.json', releases);
    });
    assertFailed(result, 'dates', 'is in the future');
  });

  test('a date that never existed is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      releases[0].releaseDate = '2026-02-30';
      write('releases.json', releases);
    });
    assertFailed(result, 'dates', 'is not a real YYYY-MM-DD date');
  });

  test('a release that predates the model it descends from is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      // Make the second release descend from the first, then date it earlier.
      releases[1].predecessorIds = [releases[0].id];
      releases[1].releaseDate = '2000-01-01';
      write('releases.json', releases);
    });
    assertFailed(result, 'dates', 'precedes predecessor');
  });

  test('a release that is its own predecessor is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      releases[0].predecessorIds = [releases[0].id];
      write('releases.json', releases);
    });
    assertFailed(result, 'lineage', 'contains the release itself');
  });

  test('a predecessor cycle between two releases is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      releases[0].predecessorIds = [releases[1].id];
      releases[1].predecessorIds = [releases[0].id];
      write('releases.json', releases);
    });
    assertFailed(result, 'lineage');
  });

  test('a release attributed away from its family owner is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      const organizations = read('organizations.json');
      const other = organizations.find((organization) => organization.id !== releases[0].organizationId);
      releases[0].organizationId = other.id;
      write('releases.json', releases);
    });
    assertFailed(result, 'entity-boundary', 'belongs to');
  });

  test('a publisher squatting on a creator id without being its voice is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const publishers = read('publishers.json');
      const impostor = publishers.find((publisher) => publisher.organizationId);
      delete impostor.organizationId;
      write('publishers.json', publishers);
    });
    assertFailed(result, 'entity-boundary', 'without declaring organizationId');
  });

  test('an http source url is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const sources = read('sources.json');
      sources[0].url = 'http://openai.com/news/';
      write('sources.json', sources);
    });
    assertFailed(result, 'urls', 'is not https');
  });

  test('a source hosted on localhost is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const sources = read('sources.json');
      sources[0].url = 'https://localhost/news/';
      write('sources.json', sources);
    });
    assertFailed(result, 'urls', 'cannot stand behind a public fact');
  });

  test('a fact with no primary source is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const families = read('families.json');
      families[0].sourceIds = [];
      write('families.json', families);
    });
    assertFailed(result, 'evidence', 'no primary source');
  });

  test('a composite score field is caught wherever it is buried', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      releases[0].parameters = { ...releases[0].parameters, overallScore: 91 };
      write('releases.json', releases);
    });
    assertFailed(result, 'no-composite-score', 'ranking or composite score');
  });

  test('a source checked before it was published is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const sources = read('sources.json');
      const dated = sources.find((source) => source.publishedDate);
      dated.lastCheckedDate = '2000-01-01';
      write('sources.json', sources);
    });
    assertFailed(result, 'dates', 'precedes publishedDate');
  });

  test('a malformed dataset document fails rather than being skipped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'modeltree-gate-'));
    try {
      cpSync(DATA, dir, { recursive: true });
      writeFileSync(join(dir, 'releases.json'), '{not json');
      const result = run(GATE_DATASET, ['--data', dir, '--today', TODAY, '--json']);
      assertFailed(result, 'well-formed', 'not valid JSON');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a missing data directory exits 2 rather than passing', () => {
    const result = run(GATE_DATASET, ['--data', join(tmpdir(), 'modeltree-does-not-exist'), '--json']);
    assert.equal(result.code, 2, 'a gate that cannot run must not report success');
  });
});

// ---------------------------------------------------------------------------

const HASH = `sha256:${'a'.repeat(64)}`;

function claim(overrides = {}) {
  return {
    id: 'openai-gpt-5-7-release-date',
    kind: 'change',
    collection: 'releases',
    targetId: 'openai-gpt-5-7',
    field: 'releaseDate',
    currentValue: '2026-08-01',
    proposedValue: '2026-08-20',
    statement: 'GPT-5.7 was released on 20 August 2026.',
    evidence: [{
      sourceId: 'openai-gpt-5-7-announcement',
      url: 'https://openai.com/index/gpt-5-7/',
      contentHash: HASH,
      fetchedAt: '2026-08-25',
      quote: 'Today we are releasing GPT-5.7 to all API customers.',
      retrieval: 'fetch',
    }],
    verdicts: [
      { reviewer: 'provenance', vote: 'accept', rationale: 'The announcement states the date directly.' },
      { reviewer: 'consistency', vote: 'accept', rationale: 'Consistent with the family timeline.' },
      { reviewer: 'editorial', vote: 'accept', rationale: 'Release, not product; boundary respected.' },
    ],
    ...overrides,
  };
}

function gateBundle(bundle) {
  const dir = mkdtempSync(join(tmpdir(), 'modeltree-claims-'));
  try {
    const path = join(dir, 'claims.json');
    writeFileSync(path, JSON.stringify(bundle, null, 2));
    return run(GATE_EVIDENCE, ['--claims', path, '--today', TODAY, '--json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('gate-evidence', () => {
  test('a fully evidenced, unanimously accepted claim passes', () => {
    const result = gateBundle({ runId: 'r1', creator: 'openai', policy: 'pilot', claims: [claim()] });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(JSON.parse(result.stdout).applicable, 1);
  });

  test('a search snippet is refused as evidence', () => {
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({ evidence: [{ ...claim().evidence[0], retrieval: 'search-snippet' }] })],
    });
    assertFailed(result, 'evidence', 'a search snippet is never evidence');
  });

  test('evidence with no content hash is refused', () => {
    const evidence = { ...claim().evidence[0] };
    delete evidence.contentHash;
    const result = gateBundle({ policy: 'pilot', claims: [claim({ evidence: [evidence] })] });
    assertFailed(result, 'evidence', 'digest of the fetched page');
  });

  test('a hash that is not a sha256 digest is refused', () => {
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({ evidence: [{ ...claim().evidence[0], contentHash: 'sha256:short' }] })],
    });
    assertFailed(result, 'evidence', 'digest of the fetched page');
  });

  test('a quote too short to show the source stating the claim is refused', () => {
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({ evidence: [{ ...claim().evidence[0], quote: 'yes' }] })],
    });
    assertFailed(result, 'evidence', 'shorter than');
  });

  test('a claim with no evidence at all is refused', () => {
    const result = gateBundle({ policy: 'pilot', claims: [claim({ evidence: [] })] });
    assertFailed(result, 'evidence', 'no evidence at all');
  });

  test('a 1-of-3 minority cannot apply a change', () => {
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({
        verdicts: [
          { reviewer: 'provenance', vote: 'accept', rationale: 'ok' },
          { reviewer: 'consistency', vote: 'reject', rationale: 'contradicts the family timeline' },
          { reviewer: 'editorial', vote: 'reject', rationale: 'conflates product with release' },
        ],
      })],
    });
    assertFailed(result, 'review', 'only reached 1 of 2 required accepts');
  });

  test('a 2-of-3 majority is enough for a pilot creator', () => {
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({
        verdicts: [
          { reviewer: 'provenance', vote: 'accept', rationale: 'stated directly' },
          { reviewer: 'consistency', vote: 'accept', rationale: 'consistent' },
          { reviewer: 'editorial', vote: 'reject', rationale: 'phrasing' },
        ],
      })],
    });
    assert.equal(result.code, 0, result.stdout);
  });

  test('the same 2-of-3 majority is NOT enough for a long-tail creator', () => {
    const result = gateBundle({
      policy: 'long-tail',
      claims: [claim({
        verdicts: [
          { reviewer: 'provenance', vote: 'accept', rationale: 'stated directly' },
          { reviewer: 'consistency', vote: 'accept', rationale: 'consistent' },
          { reviewer: 'editorial', vote: 'reject', rationale: 'phrasing' },
        ],
      })],
    });
    assertFailed(result, 'review', 'only reached 2 of 3 required accepts');
  });

  test('an incomplete panel is refused even when every reported vote accepts', () => {
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({
        verdicts: [
          { reviewer: 'provenance', vote: 'accept', rationale: 'stated directly' },
          { reviewer: 'consistency', vote: 'accept', rationale: 'consistent' },
        ],
      })],
    });
    assertFailed(result, 'review', 'never reported');
  });

  test('one reviewer voting twice cannot manufacture a majority', () => {
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({
        verdicts: [
          { reviewer: 'provenance', vote: 'accept', rationale: 'stated directly' },
          { reviewer: 'provenance', vote: 'accept', rationale: 'stated directly again' },
          { reviewer: 'editorial', vote: 'accept', rationale: 'fine' },
        ],
      })],
    });
    assertFailed(result, 'review', 'voted twice');
  });

  test('a verdict with no rationale is refused as unauditable', () => {
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({
        verdicts: [
          { reviewer: 'provenance', vote: 'accept', rationale: '' },
          { reviewer: 'consistency', vote: 'accept', rationale: 'consistent' },
          { reviewer: 'editorial', vote: 'accept', rationale: 'fine' },
        ],
      })],
    });
    assertFailed(result, 'review', 'no rationale');
  });

  test('a change that changes nothing is refused', () => {
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({ currentValue: '2026-08-20', proposedValue: '2026-08-20' })],
    });
    assertFailed(result, 'shape', 'equals the current value');
  });

  test('a claim aimed at a file outside the dataset is refused', () => {
    const result = gateBundle({ policy: 'pilot', claims: [claim({ collection: 'schema' })] });
    assertFailed(result, 'shape', 'is not a dataset document');
  });

  test('two claims sharing an id are refused', () => {
    const result = gateBundle({ policy: 'pilot', claims: [claim(), claim()] });
    assertFailed(result, 'shape', 'appears more than once');
  });

  test('evidence fetched in the future is refused', () => {
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({ evidence: [{ ...claim().evidence[0], fetchedAt: '2027-01-01' }] })],
    });
    assertFailed(result, 'evidence', 'is in the future');
  });

  test('an unchanged finding needs evidence but not a majority', () => {
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({
        kind: 'unchanged',
        verdicts: [
          { reviewer: 'provenance', vote: 'reject', rationale: 'no change found' },
          { reviewer: 'consistency', vote: 'reject', rationale: 'no change found' },
          { reviewer: 'editorial', vote: 'reject', rationale: 'no change found' },
        ],
      })],
    });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(JSON.parse(result.stdout).applicable, 0, 'an unchanged finding applies nothing');
  });

  test('a missing bundle exits 2 rather than passing', () => {
    const result = run(GATE_EVIDENCE, ['--claims', join(tmpdir(), 'no-such-bundle.json'), '--json']);
    assert.equal(result.code, 2);
  });

  test('an unknown policy exits 2 rather than falling back to the loose one', () => {
    const result = gateBundle({ policy: 'whatever', claims: [claim()] });
    assert.equal(result.code, 2, result.stdout);
  });

  // The sibling of the test above, and the more dangerous half. An unknown
  // policy is a typo; a *missing* one is the field simply not being reported by
  // the agent whose work this gate exists to check. Defaulting it picks the
  // looser threshold from silence, so a long-tail claim that never reached
  // unanimity would publish under the pilot bar. `tools/updater` refuses the
  // same way -- naming a long-tail profile without choosing its threshold exits
  // 2 -- because the threshold a change was decided under must be a choice.
  test('a missing policy exits 2 rather than defaulting to the loose one', () => {
    const bundle = { runId: 'r1', creator: 'some-long-tail-creator', claims: [claim()] };
    assert.ok(!Object.hasOwn(bundle, 'policy'), 'the fixture must not carry a policy');
    const result = gateBundle(bundle);
    assert.equal(result.code, 2, result.stdout);
  });

  // The failure this protects against, stated as the scenario rather than as a
  // property: a long-tail creator, a 2-accept/1-reject panel, and no policy.
  // That is 2 of the 3 accepts unanimity requires, and it must not pass.
  test('a 2-of-3 panel with no policy cannot publish by defaulting to pilot', () => {
    const result = gateBundle({
      runId: 'r1',
      creator: 'some-long-tail-creator',
      claims: [claim({
        verdicts: [
          { reviewer: 'provenance', vote: 'accept', rationale: 'stated directly' },
          { reviewer: 'consistency', vote: 'accept', rationale: 'consistent' },
          { reviewer: 'editorial', vote: 'reject', rationale: 'phrasing' },
        ],
      })],
    });
    assert.notEqual(result.code, 0, `a claim that never chose a threshold must not pass: ${result.stdout}`);
  });
});

// ---------------------------------------------------------------------------

describe('gate-source-approval', () => {
  // The gate reads its anchors from git at `--base`, so these run against the
  // committed tree. `sources.json` is unmodified by this change, so HEAD and the
  // working tree agree and reading the file here is a fair way to name a source
  // the dataset really does stand behind.
  const REAL_SOURCES = JSON.parse(readFileSync(join(DATA, 'sources.json'), 'utf8'));
  const REAL = REAL_SOURCES[0];
  const REAL_ORIGIN = new URL(REAL.url).origin;

  /** A bundle gated against the real repository. */
  function gateSources(bundle, extra = []) {
    const dir = mkdtempSync(join(tmpdir(), 'modeltree-approval-'));
    try {
      const path = join(dir, 'claims.json');
      writeFileSync(path, JSON.stringify(bundle, null, 2));
      return run(GATE_SOURCE_APPROVAL, ['--claims', path, '--json', ...extra]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Evidence citing `sourceId`, read from `url`. */
  function evidence(sourceId, url) {
    return {
      sourceId,
      url,
      contentHash: HASH,
      fetchedAt: TODAY,
      quote: 'Today we are releasing this model to all API customers.',
      retrieval: 'fetch',
    };
  }

  /** A `sources` claim adding `id` at `url`, unanimously accepted by the panel. */
  function addSource(id, url) {
    return claim({
      id: `add-${id}`,
      kind: 'add',
      collection: 'sources',
      targetId: id,
      field: undefined,
      currentValue: null,
      proposedValue: {
        id,
        url,
        title: 'A source',
        type: 'official-announcement',
        publisherId: 'openai',
        lastCheckedDate: TODAY,
      },
      statement: `${url} is a primary source for this creator.`,
      evidence: [evidence(id, url)],
    });
  }

  test('a claim resting on a source already in the dataset passes', () => {
    const result = gateSources({
      runId: 'r1',
      creator: 'openai',
      policy: 'pilot',
      claims: [claim({ evidence: [evidence(REAL.id, REAL.url)] })],
    });
    assert.equal(result.code, 0, result.stdout);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.inheritedSources, [REAL.id]);
    assert.ok(report.anchors.approvedOrigins.length > 0, 'the gate must have a trust anchor');
  });

  // The probe that found this hole. Before this gate existed, exactly this
  // bundle produced `all gates passed over 105 records` and exit 0: a source
  // nobody approved, added and cited in the same run, satisfying referential
  // integrity the whole way. It is the load-bearing case in #167 and the reason
  // ADR 0003 holds this as a precondition rather than an accepted cost.
  test('a fabricated source on an unrelated domain, cited from a real release, is refused', () => {
    const url = 'https://contoso-model-notes.example/claude-4-6';
    const result = gateSources({
      runId: 'r1',
      creator: 'anthropic',
      policy: 'pilot',
      claims: [
        addSource('contoso-model-notes', url),
        claim({ evidence: [evidence('contoso-model-notes', url)] }),
      ],
    });
    assertFailed(result, 'source-approval', 'a run cannot approve its own source');
    const report = JSON.parse(result.stdout);
    assert.ok(
      report.failures.some((failure) => failure.where === 'claim:openai-gpt-5-7-release-date#evidence[0]'),
      'the claim that cites the invented source must be named, not only the claim that adds it',
    );
  });

  // The gates run after review and cannot be outvoted (ADR 0003). A unanimous
  // panel is the strongest thing the run can produce, and it changes nothing.
  test('no panel majority can approve a source on an origin nobody stands behind', () => {
    const url = 'https://contoso-model-notes.example/claude-4-6';
    const unanimous = [
      { reviewer: 'provenance', vote: 'accept', rationale: 'The page states it plainly.' },
      { reviewer: 'consistency', vote: 'accept', rationale: 'Agrees with the timeline.' },
      { reviewer: 'editorial', vote: 'accept', rationale: 'Entity boundary respected.' },
    ];
    const source = addSource('contoso-model-notes', url);
    const result = gateSources({
      runId: 'r1',
      creator: 'anthropic',
      policy: 'pilot',
      claims: [
        { ...source, verdicts: unanimous },
        claim({ evidence: [evidence('contoso-model-notes', url)], verdicts: unanimous }),
      ],
    });
    assertFailed(result, 'source-approval', 'a run cannot approve its own source');
  });

  // The other direction, and the reason the rule is drawn at the origin rather
  // than at "no new source record". `sources.json` holds one entry per page, so
  // every new release announcement is a new source record. A rule that refused
  // those would refuse the refresh its entire purpose.
  test('a new page on an origin the dataset already stands behind is allowed', () => {
    const url = `${REAL_ORIGIN}/a-page-published-since-the-last-refresh`;
    const result = gateSources({
      runId: 'r1',
      creator: 'openai',
      policy: 'pilot',
      claims: [
        addSource('a-newly-announced-page', url),
        claim({ evidence: [evidence('a-newly-announced-page', url)] }),
      ],
    });
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).proposedSources, ['a-newly-announced-page']);
  });

  test('a claim citing a source that is neither in the dataset nor proposed is refused', () => {
    const result = gateSources({
      runId: 'r1',
      creator: 'openai',
      policy: 'pilot',
      claims: [claim({ evidence: [evidence('a-source-nobody-ever-added', REAL.url)] })],
    });
    assertFailed(result, 'source-approval', 'nothing approved it');
  });

  // Without this, an approved id is just a label a run can staple onto any page
  // it likes, and the binding is decorative.
  test('evidence read from a different origin than the source it cites is refused', () => {
    const result = gateSources({
      runId: 'r1',
      creator: 'openai',
      policy: 'pilot',
      claims: [claim({ evidence: [evidence(REAL.id, 'https://mirror-of-everything.example/page')] })],
    });
    assertFailed(result, 'source-approval', 'evidence must come from the source it cites');
  });

  test('repointing an approved source at a new origin is refused', () => {
    const url = 'https://contoso-model-notes.example/relocated';
    const result = gateSources({
      runId: 'r1',
      creator: 'openai',
      policy: 'pilot',
      claims: [
        claim({
          id: 'repoint-the-source',
          kind: 'change',
          collection: 'sources',
          targetId: REAL.id,
          field: 'url',
          currentValue: REAL.url,
          proposedValue: url,
          statement: 'The source moved.',
          evidence: [evidence(REAL.id, url)],
        }),
      ],
    });
    assertFailed(result, 'source-approval', 'a run cannot approve its own source');
  });

  /** A throwaway git repository, so the test never depends on the real tree. */
  function scratchRepo(build, bundle, extra = []) {
    const dir = mkdtempSync(join(tmpdir(), 'modeltree-approval-repo-'));
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    try {
      git('init', '-q');
      git('config', 'user.email', 'gate@example.com');
      git('config', 'user.name', 'Gate Test');
      execFileSync('node', ['-e', 'require("fs").mkdirSync("web/src/data",{recursive:true})'], { cwd: dir });
      writeFileSync(join(dir, 'README.md'), 'scratch\n');
      build({ dir, git });
      const path = join(dir, 'claims.json');
      writeFileSync(path, JSON.stringify(bundle, null, 2));
      return run(GATE_SOURCE_APPROVAL, ['--claims', path, '--repo', dir, '--json', ...extra]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // The whole gate turns on this. `sources.json` is a file the run is about to
  // write, so a gate that read it from disk could be satisfied by the run's own
  // uncommitted patch - which would not close the circle, only move it. The
  // anchor is the committed blob, and this proves it.
  test('a source written into the working tree does not approve itself', () => {
    const evil = { id: 'evil-source', url: 'https://evil.example/a', title: 'E', type: 'official-announcement', publisherId: 'p', lastCheckedDate: TODAY };
    const good = { id: 'good-source', url: 'https://good.example/a', title: 'G', type: 'official-announcement', publisherId: 'p', lastCheckedDate: TODAY };
    const result = scratchRepo(
      ({ dir, git }) => {
        const file = join(dir, 'web', 'src', 'data', 'sources.json');
        writeFileSync(file, JSON.stringify([good], null, 2));
        git('add', '-A');
        git('commit', '-qm', 'base');
        // The run applies its own patch before the gate runs.
        writeFileSync(file, JSON.stringify([good, evil], null, 2));
      },
      {
        runId: 'r1',
        creator: 'someone',
        policy: 'pilot',
        claims: [claim({ evidence: [evidence('evil-source', evil.url)] })],
      },
    );
    assertFailed(result, 'source-approval', 'nothing approved it');
  });

  test('a base ref carrying no dataset exits 2 rather than passing', () => {
    const result = scratchRepo(
      ({ git }) => {
        git('add', '-A');
        git('commit', '-qm', 'no dataset here');
      },
      { runId: 'r1', creator: 'someone', policy: 'pilot', claims: [claim()] },
    );
    assert.equal(result.code, 2, `a gate with no trust anchor must not report success:\n${result.stdout}`);
  });

  // ADR 0003's "no escape hatch" guardrail, as a test rather than as a promise.
  test('there is no flag that lets a refused bundle through', () => {
    const url = 'https://contoso-model-notes.example/claude-4-6';
    const bundle = {
      runId: 'r1',
      creator: 'anthropic',
      policy: 'pilot',
      claims: [addSource('contoso-model-notes', url), claim({ evidence: [evidence('contoso-model-notes', url)] })],
    };
    for (const flag of ['--force', '--skip', '--skip-gates', '--yes']) {
      const result = gateSources(bundle, [flag]);
      assert.equal(result.code, 2, `${flag} must not be recognised, and must never be a pass`);
    }
  });
});

// ---------------------------------------------------------------------------

describe('gate-scope', () => {
  /** A throwaway git repository, so the test never depends on the real tree's state. */
  function scratchRepo(build) {
    const dir = mkdtempSync(join(tmpdir(), 'modeltree-scope-'));
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    try {
      git('init', '-q');
      git('config', 'user.email', 'gate@example.com');
      git('config', 'user.name', 'Gate Test');
      execFileSync('node', ['-e', 'require("fs").mkdirSync("web/src/data",{recursive:true})'], { cwd: dir });
      writeFileSync(join(dir, 'web', 'src', 'data', 'releases.json'), '[]');
      writeFileSync(join(dir, 'README.md'), 'scratch\n');
      git('add', '-A');
      git('commit', '-qm', 'base');
      build({ dir, git });
      return run(GATE_SCOPE, ['--repo', dir, '--json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('a dataset-only change is in class', () => {
    const result = scratchRepo(({ dir }) => {
      writeFileSync(join(dir, 'web', 'src', 'data', 'releases.json'), '[{"id":"x"}]');
    });
    assert.equal(result.code, 0, result.stdout);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.inClass, ['web/src/data/releases.json']);
  });

  test('a schema change alongside a dataset change disqualifies the whole thing', () => {
    const result = scratchRepo(({ dir }) => {
      writeFileSync(join(dir, 'web', 'src', 'data', 'releases.json'), '[{"id":"x"}]');
      writeFileSync(join(dir, 'web', 'src', 'data', 'schema.ts'), 'export const x = 1;\n');
    });
    assert.equal(result.code, 1, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).outOfClass, ['web/src/data/schema.ts']);
  });

  test('an untracked new file cannot sneak past by never being added', () => {
    const result = scratchRepo(({ dir }) => {
      writeFileSync(join(dir, 'sneaky.mjs'), 'console.log(1)\n');
    });
    assert.equal(result.code, 1, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).outOfClass, ['sneaky.mjs']);
  });

  test('a same-named data file outside web/src/data does not qualify', () => {
    const result = scratchRepo(({ dir }) => {
      execFileSync('node', ['-e', 'require("fs").mkdirSync("elsewhere",{recursive:true})'], { cwd: dir });
      writeFileSync(join(dir, 'elsewhere', 'releases.json'), '[]');
    });
    assert.equal(result.code, 1, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).outOfClass, ['elsewhere/releases.json']);
  });

  test('a clean tree reports nothing to publish rather than passing silently', () => {
    const result = scratchRepo(() => {});
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).empty, true);
  });
});
