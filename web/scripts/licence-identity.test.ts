// Tests for the `licence-identity` CLI (#1057).
//
// The classifier's own outcomes are proved exhaustively in
// `src/lib/licence-url-identity.test.ts`. What is proved *here* is the thing a
// unit test of a pure function cannot reach: that the shipped command actually
// runs over the real dataset, and that its three exit codes are each reachable
// through the command as invoked.
//
// ## Why the disagreement arm is driven through `--sweep`
//
// A comparator that has never been shown to disagree is not a comparator. But a
// disagreement over the real dataset would ordinarily need a mutated
// `web/src/data/*.json`, and this change never writes there. `--sweep` is the
// way out, and it is not a trick: a sweep summary asserting that a request for
// an Apache URL *landed on* the MIT licence is precisely the server-side
// repoint this check exists to catch. So the exit-1 arm is exercised by the
// real failure mode, over the unmodified dataset, through the real CLI.
//
// Each spawn boots Vite to load the site's TypeScript, so these are seconds
// rather than milliseconds. Three runs is the whole budget: one per exit code.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { extractFinalUrls } from './licence-identity.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const webRoot = dirname(scriptsDir);
const cli = join(scriptsDir, 'licence-identity.mjs');

const temporaryDirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'licence-identity-'));
  temporaryDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of temporaryDirs) rmSync(dir, { recursive: true, force: true });
});

function run(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: webRoot,
    encoding: 'utf8',
    timeout: 180_000,
  });
}

describe('extractFinalUrls', () => {
  it('reads a bare array, a findings envelope and a results envelope alike', () => {
    const entries = [{ url: 'https://a.example/', finalUrl: 'https://b.example/' }];

    expect(extractFinalUrls(entries)).toEqual(entries);
    expect(extractFinalUrls({ findings: entries })).toEqual(entries);
    expect(extractFinalUrls({ results: entries })).toEqual(entries);
  });

  it('accepts `canonical` as the recorded-URL key', () => {
    expect(extractFinalUrls([{ canonical: 'https://a.example/', finalUrl: 'https://b.example/' }]))
      .toEqual([{ url: 'https://a.example/', finalUrl: 'https://b.example/' }]);
  });

  it('skips an entry that is missing either half rather than guessing at it', () => {
    // A sweep entry with no `finalUrl` is a request whose landing URL was never
    // recorded. Defaulting it to the recorded URL would manufacture fetch
    // evidence that does not exist, which is exactly the not-looked /
    // looked-and-found-nothing collapse ADR 0018 forbids.
    expect(extractFinalUrls([
      { url: 'https://a.example/' },
      { finalUrl: 'https://b.example/' },
      { url: 'https://a.example/', finalUrl: '' },
      { url: 42, finalUrl: 'https://b.example/' },
    ])).toEqual([]);
  });

  it('returns nothing for a shape it does not recognise, rather than throwing', () => {
    expect(extractFinalUrls(null)).toEqual([]);
    expect(extractFinalUrls({ somethingElse: [1, 2, 3] })).toEqual([]);
  });
});

describe('the licence-identity CLI over the real dataset', () => {
  it('exits 0, adjudicates the checkable population, and says a green run is expected', () => {
    const dir = scratch();
    const reportPath = join(dir, 'report.md');
    const jsonPath = join(dir, 'report.json');

    const result = run(['--report', reportPath, '--json', jsonPath]);

    expect(result.error).toBeUndefined();
    expect(result.stdout).toMatch(/offline; no requests made/);
    expect(result.stdout).toMatch(/adjudicated/);
    // The point of the run, in the run's own words. If this sentence ever goes
    // missing, a future reader meets a check that reports zero findings with no
    // statement of why zero is the right answer -- which is how a live check
    // gets deleted as dead weight.
    expect(result.stdout).toMatch(/expected result, not a null one/);
    expect(result.status).toBe(0);

    const report = JSON.parse(readFileSync(jsonPath, 'utf8'));
    expect(report.tally.disagrees).toBe(0);
    // Relations, not literals: #1006/#997/#941 are all instances of a hard-coded
    // dataset figure going stale and being "fixed" by editing the expectation.
    //
    // Every licence-bearing record gets an outcome -- that is the denominator
    // discipline this design turns on, so the tally spans `withLicence` and not
    // merely the checkable subset. A record that fell out of the report
    // entirely would be an unnamed abstention, which is the one result this
    // check is not allowed to produce.
    expect(report.records).toHaveLength(report.coverage.withLicence);
    expect(report.tally.agrees + report.tally.disagrees + report.tally['cannot-determine'])
      .toBe(report.coverage.withLicence);
    expect((Object.values(report.reasons) as number[]).reduce((a, b) => a + b, 0))
      .toBe(report.tally['cannot-determine']);

    // Adjudication happens only inside the checkable set, and does not fill it:
    // abstention is the expected majority outcome, not a shortfall.
    const adjudicated = report.tally.agrees + report.tally.disagrees;
    expect(adjudicated).toBeGreaterThan(0);
    expect(adjudicated).toBeLessThan(report.coverage.checkable);
    expect(report.reasons['no-spdx-id']).toBe(report.coverage.urlWithoutSpdxId);
    expect(report.classifiedAgainstFinalUrl).toBe(0);

    expect(readFileSync(reportPath, 'utf8')).toMatch(/Reachability is not correctness/);
  });

  it('exits 1 when a sweep reports a licence URL landing on a different licence', () => {
    // The failure mode in one file: the record still cites Apache-2.0 at the
    // canonical Apache URL and is still correct on its face, but the request for
    // it landed on the MIT licence. Only `finalUrl` can see that.
    const dir = scratch();
    const sweepPath = join(dir, 'sweep.json');
    writeFileSync(sweepPath, JSON.stringify({
      findings: [{
        url: 'https://www.apache.org/licenses/LICENSE-2.0',
        finalUrl: 'https://opensource.org/license/mit',
      }],
    }), 'utf8');

    const result = run(['--sweep', sweepPath, '--report', join(dir, 'r.md'), '--json', join(dir, 'r.json')]);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/classified against a fetched finalUrl/);
    expect(result.stdout).not.toMatch(/expected result, not a null one/);

    const report = JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8'));
    expect(report.tally.disagrees).toBeGreaterThan(0);
    expect(report.classifiedAgainstFinalUrl).toBeGreaterThan(0);
    expect(readFileSync(join(dir, 'r.md'), 'utf8')).toMatch(/Reported, not repaired/);

    // Reported, never repaired: a disagreement changes no dataset file. The
    // control for this assertion is the arm above, where the same command
    // writing the same outputs exits 0 -- so a passing `git` state here is not
    // simply an instrument that never writes anything anywhere.
    const gitStatus = spawnSync('git', ['status', '--porcelain', 'src/data'], {
      cwd: webRoot,
      encoding: 'utf8',
    });
    expect(gitStatus.status).toBe(0);
    expect(gitStatus.stdout.trim()).toBe('');
  });

  it('exits 2 rather than 0 or 1 when it cannot run', () => {
    // Exit 2 is "could not run" and is never a pass. An unknown flag is the
    // cheapest way to reach it; the dataset-write refusal below shares the path.
    const result = run(['--not-a-flag']);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/unknown flag/);
  });

  it('refuses to write a report inside the dataset directory', () => {
    const target = join(webRoot, 'src', 'data', 'licence-identity.md');
    const result = run(['--report', target]);

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/never mutates the dataset/);
    expect(existsSync(target)).toBe(false);
  });
});
