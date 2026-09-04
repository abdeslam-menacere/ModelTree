import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// docs/product/LAUNCH-RUNBOOK.md is the audited procedure a maintainer runs to
// launch. It makes concrete, verifiable claims about *this repository* -- the
// exact set of status checks branch protection must require, a command it quotes
// verbatim from a workflow, and the workflow/script files it links -- and those
// claims are the ones that go silently wrong. The runbook shipped naming one
// required check when four are required, reached a review gate, and merged,
// because nothing read the file: the only `docs/` path filter across every
// workflow is `docs/adr/**`. This test reads the runbook and compares each of
// its repository claims against the repository, so a drift reddens a check
// instead of reaching a launch.
//
// It is selected on a runbook-only change because the file is on `web-ci.yml`'s
// in-job scope allowlist (pinned by `web-ci.test.ts`, mirrored in
// `ci-preflight.mjs`), the same mechanism that already makes an edit to
// FRESHNESS-POLICY.md run its own test.
//
// Everything here is a pure file read. Nothing reaches the network or needs a
// GitHub token. The one claim in the runbook that cannot be checked offline --
// the live `required_status_checks.contexts` value on `main` -- is deliberately
// NOT asserted here; it is left to the runbook's own Verify step, which the
// maintainer runs with a token. Asserting it here would either need a secret in
// CI or would have to silently skip when the token is absent, and a check that
// skips silently is the weaker shape of the very defect this test exists to fix.

const repoFile = (rel: string): string =>
  readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8');

const runbook = repoFile('docs/product/LAUNCH-RUNBOOK.md');
const runbookUrl = new URL('../../../docs/product/LAUNCH-RUNBOOK.md', import.meta.url);

/** Sorted, so two sets compare regardless of insertion order. */
const sorted = (values: Iterable<string>): string[] => [...values].sort();

const NUMBER_WORDS: Record<number, string> = {
  1: 'one',
  2: 'two',
  3: 'three',
  4: 'four',
  5: 'five',
  6: 'six',
  7: 'seven',
};

describe('launch runbook — required status-check set', () => {
  // The repository's own in-tree statement of which contexts are required.
  // `aggregate-checks.mjs` carries an EXCLUDED list: three of its entries name
  // `web-ci`, `skills-ci` and `web-e2e` as *"already a required context"*. The
  // fourth required context is the roll-up itself, whose name is read from its
  // own workflow (`aggregate-checks.yml`'s single reported job) rather than
  // matched by phrase -- more than one EXCLUDED entry mentions "this job", so the
  // roll-up's identity comes from the workflow, not from the reason prose. That
  // is four names, all derived from the repository rather than restated, and it
  // is the same set the runbook must instruct a maintainer to require. If the two
  // drift apart, one of them is wrong.
  const aggregate = repoFile('.github/scripts/aggregate-checks.mjs');
  const excludedStart = aggregate.indexOf('const EXCLUDED = [');
  const excludedEnd = aggregate.indexOf('\n];', excludedStart);
  const excludedBlock = aggregate.slice(excludedStart, excludedEnd);

  const excludedEntries = [
    ...excludedBlock.matchAll(
      /check:\s*'([^']+)',\s*why:\s*((?:'(?:[^'\\]|\\.)*'\s*\+?\s*)+)/g,
    ),
  ].map(([, check, why]) => ({ check, why }));

  const aggregateWorkflow = parse(repoFile('.github/workflows/aggregate-checks.yml')) as {
    jobs: Record<string, { name?: string }>;
  };
  const aggregateJobs = Object.entries(aggregateWorkflow.jobs ?? {});
  const rollupName = aggregateJobs.length === 1 ? aggregateJobs[0][1].name ?? aggregateJobs[0][0] : undefined;

  const requiredFromRepo = new Set<string>([
    ...excludedEntries
      .filter((entry) => entry.why.includes('already a required context'))
      .map((entry) => entry.check),
    ...(rollupName === undefined ? [] : [rollupName]),
  ]);

  // The runbook's machine-readable statement of the same set: the `$want` array
  // its Verify step compares live protection against.
  const wantMatch = runbook.match(/\[((?:"[^"]+"\s*,?\s*)+)\]\s+as \$want/);
  const runbookWant = new Set<string>(
    wantMatch === null ? [] : [...wantMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]),
  );

  // Vacuity guards. Both extractions are regex reads, and a regex that stops
  // matching returns an empty set that would compare equal to another empty set
  // -- green while checking nothing. Prove each side found real data first, so
  // the equality below is a discrimination and not a coincidence of two blanks.
  it('extracts a non-empty required set from aggregate-checks.mjs', () => {
    expect(excludedEntries.length).toBeGreaterThan(0);
    expect(aggregateJobs.length, 'aggregate-checks.yml must define exactly one reported job').toBe(1);
    expect(rollupName, 'the roll-up context name must resolve from aggregate-checks.yml').toBeDefined();
    // The script must exclude watching its own context; if it did not, the
    // roll-up would wait on itself. This also cross-checks that the name read
    // from the workflow is the same one the script knows itself by.
    expect(excludedEntries.map((entry) => entry.check)).toContain(rollupName);
    expect(requiredFromRepo.size).toBeGreaterThan(0);
  });

  it("extracts the runbook's own required-context array", () => {
    expect(wantMatch, 'the runbook must carry a `[...] as $want` array in its Verify step').not.toBeNull();
    expect(runbookWant.size).toBeGreaterThan(0);
  });

  it('names exactly the repository\'s required contexts, with nothing missing and nothing extra', () => {
    const missing = sorted([...requiredFromRepo].filter((name) => !runbookWant.has(name)));
    const unexpected = sorted([...runbookWant].filter((name) => !requiredFromRepo.has(name)));

    expect(missing, `the runbook omits required contexts: ${missing.join(', ')}`).toEqual([]);
    expect(
      unexpected,
      `the runbook requires contexts the repository does not: ${unexpected.join(', ')}`,
    ).toEqual([]);
  });

  it('states each required context in its prose, not only in the Verify jq', () => {
    for (const name of requiredFromRepo) {
      expect(runbook, `the runbook prose must name the required check ${name}`).toContain(name);
    }
  });

  it('agrees in its prose count word with the size of the required set', () => {
    const word = NUMBER_WORDS[requiredFromRepo.size];
    expect(word, `add a number word for a required set of ${requiredFromRepo.size}`).toBeDefined();
    expect(
      runbook,
      `the runbook must say "all ${word}" required checks for a set of ${requiredFromRepo.size}`,
    ).toContain(`all ${word}`);
  });
});

describe('launch runbook — quoted workflow command', () => {
  // The runbook quotes web-e2e.yml's skip condition verbatim to explain when the
  // accessibility suite does not run. If that line changes in the workflow and
  // not here, the runbook teaches a maintainer a condition the workflow no longer
  // uses. Read the line out of the workflow rather than restating it, so the
  // assertion is a drift check and not a second copy that can rot in lockstep.
  const webE2e = repoFile('.github/workflows/web-e2e.yml');
  const skipLine = webE2e.match(/grep -Eq '[^']+' <<< "\$changed"/);

  it('finds the scope line in web-e2e.yml', () => {
    expect(skipLine, 'web-e2e.yml must grep the changed-file list with a single-quoted ERE').not.toBeNull();
  });

  it('quotes that scope line byte-identically in the runbook', () => {
    expect(skipLine).not.toBeNull();
    expect(
      runbook,
      'the runbook must quote web-e2e.yml\'s skip condition exactly as the workflow writes it',
    ).toContain(skipLine![0]);
  });
});

describe('launch runbook — linked workflow and script files exist', () => {
  // Every `.github/` workflow or script the runbook links is a claim that a file
  // lives at that path. A rename that misses the runbook leaves a dead link and a
  // maintainer sent to a file that is not there. Resolve each link against the
  // document's own location and assert it exists.
  const linked = [
    ...new Set(
      [...runbook.matchAll(/\]\(([^)]+)\)/g)]
        .map(([, target]) => target.split('#')[0])
        .filter((target) => /\.github\/(workflows\/[A-Za-z0-9-]+\.yml|skills\/.+\.mjs|scripts\/.+\.mjs)$/.test(target)),
    ),
  ];

  it('links at least one workflow or script', () => {
    expect(linked.length).toBeGreaterThan(0);
  });

  it.each(linked)('resolves %s to a file on disk', (target) => {
    expect(existsSync(new URL(target, runbookUrl)), `the runbook links ${target}, which must exist`).toBe(true);
  });
});

describe('docs/product CI coverage boundary', () => {
  // AC#6: the boundary must be documented, not achieved by omission. Every
  // Markdown document under docs/product/ is classified here as either covered
  // (a test reads it, so web-ci's scope allowlist lists it) or explicitly
  // uncovered with a reason. Reading the real directory means a document added
  // later fails this test until someone classifies it, rather than slipping in
  // uncovered the way the runbook itself did.

  // Covered: a web test reads the file, and web-ci.yml's scope lists it so an
  // edit to the file alone runs that test.
  const COVERED: Record<string, string> = {
    'INFORMATION-ARCHITECTURE.md':
      'read by src/data/catalog-inclusion-policy.test.ts, featured-policy.test.ts and organization-type-policy.test.ts',
    'FRESHNESS-POLICY.md': 'read by src/data/freshness-policy.test.ts',
    'LAUNCH-RUNBOOK.md': 'read by this file, tests/workflows/launch-runbook.test.ts',
  };

  // Uncovered, deliberately, with the reason. These are prose whose verifiable
  // facts (where any exist) are enforced by the running system rather than by a
  // string in the document, so a docs-side assertion would restate a check that
  // already exists elsewhere rather than close a gap.
  const UNCOVERED: Record<string, string> = {
    'BACKLOG.md': 'a prioritised task list; it makes no verifiable claim about the repository',
    'DEPLOYMENT-RUNBOOK.md':
      'operational prose; its checkable facts (Pages source, base path) are exercised by pages.yml and the build, not restated here',
    'INTERACTION-CONTRACT.md': 'design prose for intended UX; no path, command, or check claim to compare against the tree',
    'PERFORMANCE-BUDGETS.md':
      'the budget numbers are enforced by the web/scripts budget checks against the built site, not by a copy in this document',
    'PRIVACY-DECISION.md': 'a recorded decision (no analytics); there is no repository fact for it to drift against',
    'PRODUCT-BRIEF.md': 'scope and positioning prose; no verifiable repository claim',
    'WCAG-2.2-AA-AUDIT.md': 'an audit report; its living verification is the web-e2e accessibility suite, not a string in the document',
  };

  const productDir = fileURLToPath(new URL('../../../docs/product/', import.meta.url));
  const actual = readdirSync(productDir).filter((name) => name.endsWith('.md'));

  // The docs/product files web-ci.yml's scope step actually selects, read out of
  // the committed workflow so the covered set below cannot claim coverage the
  // workflow does not grant.
  const webCi = repoFile('.github/workflows/web-ci.yml');
  const allowlistDocs = new Set(
    [...webCi.matchAll(/docs\/product\/([A-Za-z0-9.-]+?)\\\.md\$/g)].map(([, name]) => `${name}.md`),
  );

  it('reads a non-empty directory and a non-empty allowlist', () => {
    expect(actual.length).toBeGreaterThan(0);
    expect(allowlistDocs.size).toBeGreaterThan(0);
  });

  it('classifies every docs/product document as covered or uncovered', () => {
    const classified = new Set([...Object.keys(COVERED), ...Object.keys(UNCOVERED)]);
    const missing = sorted(actual.filter((name) => !classified.has(name)));
    const stale = sorted([...classified].filter((name) => !actual.includes(name)));

    expect(missing, `unclassified docs/product files (add to COVERED or UNCOVERED): ${missing.join(', ')}`).toEqual([]);
    expect(stale, `classified files that no longer exist: ${stale.join(', ')}`).toEqual([]);
  });

  it('never lists a file as both covered and uncovered', () => {
    const both = Object.keys(COVERED).filter((name) => name in UNCOVERED);
    expect(both, `files in both COVERED and UNCOVERED: ${both.join(', ')}`).toEqual([]);
  });

  it("keeps the covered set equal to web-ci.yml's docs/product allowlist", () => {
    const notInWorkflow = sorted(Object.keys(COVERED).filter((name) => !allowlistDocs.has(name)));
    const notInCovered = sorted([...allowlistDocs].filter((name) => !(name in COVERED)));

    expect(
      notInWorkflow,
      `COVERED names files web-ci.yml does not select: ${notInWorkflow.join(', ')}`,
    ).toEqual([]);
    expect(
      notInCovered,
      `web-ci.yml selects docs/product files not recorded as COVERED: ${notInCovered.join(', ')}`,
    ).toEqual([]);
  });
});
