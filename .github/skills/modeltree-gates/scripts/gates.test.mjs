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
import { mkdtempSync, writeFileSync, readFileSync, cpSync, mkdirSync, rmSync } from 'node:fs';
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
  // The dataset the real repository stands behind, used as the anchor content.
  // The tests build their own git repository around it rather than gating this
  // checkout: the anchor is the merge base with `refs/remotes/origin/main`, and
  // a CI checkout has no such ref, so gating the ambient tree would make the
  // suite depend on how it was cloned. Seeding a scratch repository with the
  // real file keeps the anchor real and the test hermetic.
  const REAL_SOURCES = JSON.parse(readFileSync(join(DATA, 'sources.json'), 'utf8'));
  const REAL = REAL_SOURCES[0];
  const REAL_ORIGIN = new URL(REAL.url).origin;

  /** A source on a host nothing in the repository has ever stood behind. */
  const EVIL = {
    id: 'evil-source',
    url: 'https://contoso-model-notes.example/a',
    title: 'E',
    type: 'official-announcement',
    publisherId: 'p',
    lastCheckedDate: TODAY,
  };

  /**
   * A throwaway git repository, so the test never depends on this checkout.
   *
   * `publish` is the piece that matters: it points `refs/remotes/origin/main` at
   * the commit standing in for reviewed history. Everything committed after that
   * is history the run authored, and the gate must not treat it as trust.
   */
  function approvalRepo(build, bundle, extra = []) {
    const dir = mkdtempSync(join(tmpdir(), 'modeltree-approval-'));
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    const publish = () => git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD').trim());
    try {
      git('init', '-q');
      git('config', 'user.email', 'gate@example.com');
      git('config', 'user.name', 'Gate Test');
      mkdirSync(join(dir, 'web', 'src', 'data'), { recursive: true });
      writeFileSync(join(dir, 'README.md'), 'scratch\n');
      const sources = join(dir, 'web', 'src', 'data', 'sources.json');
      const writeSources = (records) => writeFileSync(sources, JSON.stringify(records, null, 2));
      const commit = (message) => {
        git('add', '-A');
        git('commit', '-qm', message);
        return git('rev-parse', 'HEAD').trim();
      };
      build({ dir, git, sources, writeSources, commit, publish });
      const path = join(dir, 'claims.json');
      writeFileSync(path, JSON.stringify(bundle, null, 2));
      return run(GATE_SOURCE_APPROVAL, ['--claims', path, '--repo', dir, '--json', ...extra]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** A bundle gated against the real dataset, committed and published. */
  function gateSources(bundle, extra = []) {
    return approvalRepo(
      ({ writeSources, commit, publish }) => {
        writeSources(REAL_SOURCES);
        commit('the reviewed dataset');
        publish();
      },
      bundle,
      extra,
    );
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
  const scratchRepo = approvalRepo;

  // The whole gate turns on this. `sources.json` is a file the run is about to
  // write, so a gate that read it from disk could be satisfied by the run's own
  // uncommitted patch - which would not close the circle, only move it. The
  // anchor is the committed blob, and this proves it.
  test('a source written into the working tree does not approve itself', () => {
    const good = { id: 'good-source', url: 'https://good.example/a', title: 'G', type: 'official-announcement', publisherId: 'p', lastCheckedDate: TODAY };
    const result = scratchRepo(
      ({ writeSources, commit, publish }) => {
        writeSources([good]);
        commit('base');
        publish();
        // The run applies its own patch before the gate runs.
        writeSources([good, EVIL]);
      },
      {
        runId: 'r1',
        creator: 'someone',
        policy: 'pilot',
        claims: [claim({ evidence: [evidence(EVIL.id, EVIL.url)] })],
      },
    );
    assertFailed(result, 'source-approval', 'nothing approved it');
  });

  // And the same attack one step further on, which is the one that matters most.
  // Patching the working tree was already refused; *committing* the source first
  // was not, back when the anchor defaulted to `HEAD` - the gate then read the
  // run's own commit and reported the fabricated source as inherited trust. The
  // anchor is the merge base with published history, so a commit on this branch
  // cannot move it, and no flag is needed to get this right.
  test('a source the run commits before gating is still not approved, with no --base given', () => {
    const good = { id: 'good-source', url: 'https://good.example/a', title: 'G', type: 'official-announcement', publisherId: 'p', lastCheckedDate: TODAY };
    const result = scratchRepo(
      ({ writeSources, commit, publish }) => {
        writeSources([good]);
        commit('the reviewed base');
        publish();
        writeSources([good, EVIL]);
        commit('the run commits its own source, then calls the gate');
      },
      {
        runId: 'r1',
        creator: 'someone',
        policy: 'pilot',
        claims: [claim({ evidence: [evidence(EVIL.id, EVIL.url)] })],
      },
    );
    assertFailed(result, 'source-approval', 'nothing approved it');
  });

  // `--base` exists to re-gate an older bundle, and may only ever narrow. A
  // required flag would not have been enough here: the agent under test supplies
  // it either way, so what is checked is the ref, not whether it was passed.
  test('--base cannot select a commit this branch authored', () => {
    const good = { id: 'good-source', url: 'https://good.example/a', title: 'G', type: 'official-announcement', publisherId: 'p', lastCheckedDate: TODAY };
    const result = scratchRepo(
      ({ writeSources, commit, publish }) => {
        writeSources([good]);
        commit('the reviewed base');
        publish();
        writeSources([good, EVIL]);
        commit('the run commits its own source');
      },
      {
        runId: 'r1',
        creator: 'someone',
        policy: 'pilot',
        claims: [claim({ evidence: [evidence(EVIL.id, EVIL.url)] })],
      },
      // `HEAD` is the run's own commit, which is exactly the ref that must not
      // be selectable. It was the default until #167's review found it.
      ['--base', 'HEAD'],
    );
    assert.equal(result.code, 2, `a run-authored anchor must not be selectable:\n${result.stdout}`);
    assert.match(result.stdout, /may only narrow/);
  });

  test('--base may pin an older reviewed commit, and pins it for real', () => {
    const good = { id: 'good-source', url: 'https://good.example/a', title: 'G', type: 'official-announcement', publisherId: 'p', lastCheckedDate: TODAY };
    const later = { id: 'later-source', url: 'https://later.example/a', title: 'L', type: 'official-announcement', publisherId: 'p', lastCheckedDate: TODAY };
    const build = ({ writeSources, commit, publish }) => {
      writeSources([good]);
      commit('the first reviewed commit');
      writeSources([good, later]);
      commit('a second reviewed commit');
      publish();
    };
    const cite = (id, url) => ({
      runId: 'r1',
      creator: 'someone',
      policy: 'pilot',
      claims: [claim({ evidence: [evidence(id, url)] })],
    });

    const pinned = scratchRepo(build, cite(good.id, good.url), ['--base', 'HEAD~1']);
    assert.equal(pinned.code, 0, pinned.stdout);
    const report = JSON.parse(pinned.stdout);
    assert.equal(report.anchors.datasetSources, 1, 'the pinned anchor must be the older tree');
    assert.equal(report.anchor.requestedBase, 'HEAD~1');

    // Narrower means narrower: the source added in the *second* reviewed commit
    // is outside a pin at the first, so pinning cannot be turned into widening.
    const outside = scratchRepo(build, cite(later.id, later.url), ['--base', 'HEAD~1']);
    assertFailed(outside, 'source-approval', 'nothing approved it');
  });

  test('a repository with no published main cannot be gated', () => {
    const good = { id: 'good-source', url: 'https://good.example/a', title: 'G', type: 'official-announcement', publisherId: 'p', lastCheckedDate: TODAY };
    const result = scratchRepo(
      ({ writeSources, commit }) => {
        writeSources([good]);
        commit('a base nobody published');
      },
      { runId: 'r1', creator: 'someone', policy: 'pilot', claims: [claim({ evidence: [evidence(good.id, good.url)] })] },
    );
    assert.equal(result.code, 2, `no published history means the gate cannot run:\n${result.stdout}`);
    assert.match(result.stdout, /cannot resolve refs\/remotes\/origin\/main/);
  });

  test('an anchor commit with no dataset file at all exits 2 rather than passing', () => {
    const result = scratchRepo(
      ({ commit, publish }) => {
        commit('no dataset here');
        publish();
      },
      { runId: 'r1', creator: 'someone', policy: 'pilot', claims: [claim()] },
    );
    assert.equal(result.code, 2, `a gate with no trust anchor must not report success:\n${result.stdout}`);
    assert.match(result.stdout, /cannot read web\/src\/data\/sources\.json/);
  });

  // Distinct from the above, and reached only when the file parses: a dataset
  // that is present but stands behind nothing leaves the gate with an empty
  // approved set, which would otherwise refuse every citation for a reason that
  // has nothing to do with the citation.
  test('an anchor that yields no approved origin exits 2 rather than refusing everything', () => {
    const result = scratchRepo(
      ({ writeSources, commit, publish }) => {
        writeSources([]);
        commit('a dataset standing behind nothing');
        publish();
      },
      { runId: 'r1', creator: 'someone', policy: 'pilot', claims: [claim({ evidence: [evidence(EVIL.id, EVIL.url)] })] },
    );
    assert.equal(result.code, 2, `an empty anchor is not a verdict:\n${result.stdout}`);
    assert.match(result.stdout, /no approved origin at/);
  });

  // Malformed shapes are refused, not skipped. A missing `sourceId` already
  // refuses, so a missing `evidence` that silently passed would make absence the
  // most permissive input in a gate about what a run leaves out. `gate-evidence`
  // refuses these too, but relying on that would make this gate closed only
  // while the two are run in a particular order.
  test('a bundle that is not a claim bundle object cannot be gated', () => {
    for (const notABundle of ['a string', 42, null, ['an', 'array']]) {
      const result = gateSources(notABundle);
      assert.equal(result.code, 2, `${JSON.stringify(notABundle)} is not a bundle, and is not a pass`);
    }
  });

  test('a bundle with no claims array cannot be gated', () => {
    const result = gateSources({ runId: 'r1', creator: 'someone', policy: 'pilot' });
    assert.equal(result.code, 2, `a bundle with no claims is not a pass:\n${result.stdout}`);
  });

  test('a claim that is not an object is refused rather than skipped', () => {
    const result = gateSources({ runId: 'r1', creator: 'someone', policy: 'pilot', claims: ['not a claim'] });
    assertFailed(result, 'source-approval', 'is not a claim object');
  });

  test('a claim with no evidence array is refused rather than skipped', () => {
    const result = gateSources({
      runId: 'r1',
      creator: 'someone',
      policy: 'pilot',
      claims: [claim({ evidence: undefined })],
    });
    assertFailed(result, 'source-approval', 'has no evidence array');
  });

  test('evidence entries that are not objects are refused rather than skipped', () => {
    for (const notEvidence of ['https://openai.com/index/gpt-5-7/', null, 7, ['x']]) {
      const result = gateSources({
        runId: 'r1',
        creator: 'someone',
        policy: 'pilot',
        claims: [claim({ evidence: [notEvidence] })],
      });
      assertFailed(result, 'source-approval', 'rather than an evidence object');
    }
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
  // The path #210 reproduced against: a reviewed updater profile. It is absent
  // from ALLOWED_PATHS, which is the only thing making the profiles unforgeable,
  // so it is the right file to prove the gate still refuses.
  const OUT_OF_CLASS = 'tools/updater/profiles/anthropic.json';

  function writeOutOfClass(dir, body = '{"id":"anthropic"}\n') {
    mkdirSync(join(dir, 'tools', 'updater', 'profiles'), { recursive: true });
    writeFileSync(join(dir, 'tools', 'updater', 'profiles', 'anthropic.json'), body);
  }

  /**
   * A throwaway git repository, so the test never depends on the real tree's
   * state. `body` gets the directory, a `git`, and a `gate` that runs the gate
   * against it.
   *
   * `publish` writes `refs/remotes/origin/main`, which is where the gate computes
   * its anchor from. A real clone gets that ref from the remote; setting it here
   * explicitly is what lets a test say which commit counts as reviewed - and
   * omitting it is a degraded case in its own right, not an oversight.
   */
  function withScratchRepo(body, { publish = true } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'modeltree-scope-'));
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    try {
      git('init', '-q');
      git('config', 'user.email', 'gate@example.com');
      git('config', 'user.name', 'Gate Test');
      mkdirSync(join(dir, 'web', 'src', 'data'), { recursive: true });
      writeFileSync(join(dir, 'web', 'src', 'data', 'releases.json'), '[]');
      writeFileSync(join(dir, 'README.md'), 'scratch\n');
      git('add', '-A');
      git('commit', '-qm', 'base');
      if (publish) git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      return body({
        dir,
        git,
        gate: (...args) => run(GATE_SCOPE, ['--repo', dir, ...args]),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** The common shape: build a state, then gate it as JSON. */
  function scratchRepo(build, extraArgs = []) {
    return withScratchRepo(({ dir, git, gate }) => {
      build({ dir, git });
      return gate('--json', ...extraArgs);
    });
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
      mkdirSync(join(dir, 'elsewhere'), { recursive: true });
      writeFileSync(join(dir, 'elsewhere', 'releases.json'), '[]');
    });
    assert.equal(result.code, 1, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).outOfClass, ['elsewhere/releases.json']);
  });

  // -------------------------------------------------------------------------
  // The three-state table from #210. One test per row. The same out-of-class
  // edit is gated uncommitted, committed, and committed with an explicit
  // `--base`; every row must refuse.
  //
  // Each row asserts the **message**, not just the exit code. The broken gate
  // got rows A and C right, so a suite that checked `code === 1` on those and
  // `code === 0` on B would have passed against it in full. Row B's bug is a
  // *wrong success*, and the only thing that distinguishes it from a real pass
  // is what the gate said it examined.
  // -------------------------------------------------------------------------

  test('State A - an uncommitted out-of-class change is refused', () => {
    const result = withScratchRepo(({ dir, gate }) => {
      writeOutOfClass(dir);
      return gate();
    });
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /OUT OF CLASS - 1 file\(s\) outside the dataset documents/);
    assert.ok(result.stdout.includes(OUT_OF_CLASS), `expected ${OUT_OF_CLASS} named:\n${result.stdout}`);
  });

  test('State B - the same change, committed, is refused with no flag passed', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      writeOutOfClass(dir);
      git('add', '-A');
      git('commit', '-qm', 'out of class');
      // The precondition that used to blind the gate: nothing left on disk.
      assert.equal(git('status', '--porcelain').trim(), '', 'the working tree must be clean here');
      return gate();
    });
    assert.equal(result.code, 1, `a committed out-of-class change must be refused:\n${result.stdout}`);
    assert.match(result.stdout, /OUT OF CLASS - 1 file\(s\) outside the dataset documents/);
    assert.ok(result.stdout.includes(OUT_OF_CLASS), `expected ${OUT_OF_CLASS} named:\n${result.stdout}`);
    // The exact wrong success this issue is about. Exit 1 alone would not catch a
    // regression that reported absence of work while examining nothing.
    assert.doesNotMatch(result.stdout, /nothing changed/);
    assert.doesNotMatch(result.stdout, /nothing to publish/);
  });

  test('State C - the same commit with --base origin/main is still refused', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      writeOutOfClass(dir);
      git('add', '-A');
      git('commit', '-qm', 'out of class');
      return gate('--base', 'origin/main');
    });
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /OUT OF CLASS - 1 file\(s\) outside the dataset documents/);
    assert.ok(result.stdout.includes(OUT_OF_CLASS), `expected ${OUT_OF_CLASS} named:\n${result.stdout}`);
  });

  test('a change split across a commit and the working tree is reported whole', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      writeOutOfClass(dir);
      git('add', '-A');
      git('commit', '-qm', 'half of it');
      writeFileSync(join(dir, 'sneaky.mjs'), 'console.log(1)\n');
      return gate('--json');
    });
    assert.equal(result.code, 1, result.stdout);
    // Committed and uncommitted halves both present: neither mode replaced the
    // other, which is what keeps AC 4 and AC 7 from trading off.
    assert.deepEqual(JSON.parse(result.stdout).outOfClass, ['sneaky.mjs', OUT_OF_CLASS]);
  });

  test('nothing changed is a finding about the anchor, not a fallthrough', () => {
    const result = withScratchRepo(({ gate }) => ({ text: gate(), json: gate('--json') }));
    assert.equal(result.text.code, 0, result.text.stdout);
    // It has to say what it established, so a reader can tell this apart from the
    // gate having looked in the wrong place.
    assert.match(result.text.stdout, /nothing changed since [0-9a-f]{10} and the working tree is clean/);
    assert.equal(JSON.parse(result.json.stdout).empty, true);
  });

  test('the anchor is reported as a resolved commit, not as the flag that was passed', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      writeFileSync(join(dir, 'web', 'src', 'data', 'releases.json'), '[{"id":"x"}]');
      return { report: JSON.parse(gate('--json').stdout), head: git('rev-parse', 'HEAD').trim() };
    });
    assert.match(result.report.base, /^[0-9a-f]{40}$/);
    assert.equal(result.report.base, result.head, 'the anchor is the merge base, here HEAD');
    assert.equal(result.report.anchor.publishedRef, 'refs/remotes/origin/main');
    assert.equal(result.report.anchor.requestedBase, null);
    // Byte-identical to gate-source-approval.mjs's, because #168 is open on the
    // absence of drift detection between the two and this is where drift starts.
    assert.equal(result.report.anchor.selectedBy, 'merge-base with refs/remotes/origin/main');
  });

  // -------------------------------------------------------------------------
  // `--base` may only narrow. The flag is supplied by the agent under test, so
  // it must never be able to select a commit this branch authored.
  // -------------------------------------------------------------------------

  test('--base HEAD cannot be used to hide what this branch committed', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      writeOutOfClass(dir);
      git('add', '-A');
      git('commit', '-qm', 'out of class');
      return gate('--base', 'HEAD');
    });
    assert.equal(result.code, 2, `widening --base must exit 2, not pass:\n${result.stdout}`);
    assert.match(result.stdout, /is not an ancestor of the merge base/);
    assert.match(result.stdout, /may only narrow/);
  });

  // The rest of the widening set #167's review proved out by execution on
  // `gate-source-approval.mjs`. Kept in step deliberately: #168 is open because
  // nothing detects drift between the two gates, and a rejection this gate
  // accepts while the other refuses is exactly that drift. Every one exits 2
  // with no fallback - never 0, and never a quiet reversion to the merge base.
  test('--base pointing at a post-merge-base commit that is not HEAD is refused', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      writeOutOfClass(dir);
      git('add', '-A');
      git('commit', '-qm', 'first branch commit');
      const middle = git('rev-parse', 'HEAD').trim();
      writeFileSync(join(dir, 'sneaky.mjs'), 'console.log(1)\n');
      git('add', '-A');
      git('commit', '-qm', 'second branch commit');
      return gate('--base', middle);
    });
    assert.equal(result.code, 2, `a mid-branch commit must not become the anchor:\n${result.stdout}`);
    assert.match(result.stdout, /is not an ancestor of the merge base/);
  });

  test('--base pointing at a tag on a branch commit is refused, not resolved past', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      writeOutOfClass(dir);
      git('add', '-A');
      git('commit', '-qm', 'out of class');
      // An annotated tag: `^{commit}` peels it, so the check runs on the commit
      // it names rather than being sidestepped by the object type.
      git('tag', '-a', 'v-branch', '-m', 'tag on a branch commit');
      return gate('--base', 'v-branch');
    });
    assert.equal(result.code, 2, `a tag naming a branch commit must not widen:\n${result.stdout}`);
    assert.match(result.stdout, /is not an ancestor of the merge base/);
  });

  test('--base pointing at a sibling branch tip is refused', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      git('checkout', '-q', '-b', 'sibling');
      writeFileSync(join(dir, 'sneaky.mjs'), 'console.log(1)\n');
      git('add', '-A');
      git('commit', '-qm', 'sibling work');
      const siblingTip = git('rev-parse', 'HEAD').trim();
      git('checkout', '-q', '-');
      writeOutOfClass(dir);
      git('add', '-A');
      git('commit', '-qm', 'out of class');
      return gate('--base', siblingTip);
    });
    assert.equal(result.code, 2, `a sibling tip is not inherited trust:\n${result.stdout}`);
    assert.match(result.stdout, /is not an ancestor of the merge base/);
  });

  test('--base naming a ref that does not exist exits 2 rather than falling back', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      writeOutOfClass(dir);
      git('add', '-A');
      git('commit', '-qm', 'out of class');
      return gate('--base', 'no-such-ref');
    });
    // The dangerous shape would be falling back to the computed anchor and
    // passing, or worse to the working tree. Neither: it refuses to run.
    assert.equal(result.code, 2, `an unresolvable --base must not fall back:\n${result.stdout}`);
    assert.match(result.stdout, /--base no-such-ref is not a commit in this repository/);
  });

  test('--base may pin an older reviewed commit, and still sees the later change', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      const first = git('rev-parse', 'HEAD').trim();
      writeFileSync(join(dir, 'README.md'), 'scratch, reviewed\n');
      git('add', '-A');
      git('commit', '-qm', 'second reviewed commit');
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      writeOutOfClass(dir);
      git('add', '-A');
      git('commit', '-qm', 'out of class');
      return { pinned: gate('--json', '--base', first), first };
    });
    assert.equal(result.pinned.code, 1, result.pinned.stdout);
    const report = JSON.parse(result.pinned.stdout);
    assert.equal(report.anchor.commit, result.first, 'the pinned ancestor is the anchor');
    // Narrowing widens the diff, so it can only ever add refusals.
    assert.deepEqual(report.outOfClass, ['README.md', OUT_OF_CLASS]);
  });

  test('--base with no value exits 2 rather than swallowing the next argument', () => {
    const result = withScratchRepo(({ gate }) => gate('--base'));
    assert.equal(result.code, 2, result.stdout);
    assert.match(result.stdout, /--base needs a value/);
  });

  // -------------------------------------------------------------------------
  // Degraded anchors. A gate that cannot establish what changed exits 2; it
  // never exits 0. A missing ref that passed would be a worse bug than the one
  // this replaces.
  // -------------------------------------------------------------------------

  test('a repository with no refs/remotes/origin/main refuses rather than passing', () => {
    const result = withScratchRepo(({ dir, gate }) => {
      writeOutOfClass(dir);
      return gate();
    }, { publish: false });
    assert.equal(result.code, 2, `a missing published ref must not pass:\n${result.stdout}`);
    assert.match(result.stdout, /cannot resolve refs\/remotes\/origin\/main/);
  });

  test('a clean tree with no refs/remotes/origin/main still refuses, so absence never reads as a pass', () => {
    const result = withScratchRepo(({ gate }) => gate(), { publish: false });
    assert.equal(result.code, 2, `an unresolvable anchor must never exit 0:\n${result.stdout}`);
    assert.match(result.stdout, /fetch main before gating/);
  });

  test('a HEAD sharing no history with the published ref refuses', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      git('checkout', '-q', '--orphan', 'unrelated');
      writeFileSync(join(dir, 'sneaky.mjs'), 'console.log(1)\n');
      git('add', '-A');
      git('commit', '-qm', 'unrelated root');
      return gate();
    });
    assert.equal(result.code, 2, `an unrelated history must not pass:\n${result.stdout}`);
    assert.match(result.stdout, /shares no history with refs\/remotes\/origin\/main/);
  });

  test('a stale published ref only moves the anchor backwards, which adds refusals', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      // origin/main stays at the first commit while the branch moves on twice.
      writeFileSync(join(dir, 'web', 'src', 'data', 'releases.json'), '[{"id":"x"}]');
      git('add', '-A');
      git('commit', '-qm', 'dataset change, already on main upstream');
      writeOutOfClass(dir);
      git('add', '-A');
      git('commit', '-qm', 'out of class');
      return gate('--json');
    });
    assert.equal(result.code, 1, result.stdout);
    const report = JSON.parse(result.stdout);
    // Everything since the stale anchor, which is a superset of what a current
    // ref would have shown. Staleness costs precision, never safety.
    assert.deepEqual(report.outOfClass, [OUT_OF_CLASS]);
    assert.deepEqual(report.inClass, ['web/src/data/releases.json']);
  });

  test('an unknown flag exits 2 rather than being ignored', () => {
    const result = withScratchRepo(({ gate }) => gate('--force'));
    assert.equal(result.code, 2, result.stdout);
    assert.match(result.stdout, /unknown flag --force/);
  });
});
