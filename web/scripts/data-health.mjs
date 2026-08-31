// Generates the ModelTree data-health artifacts (issue #28).
//
// Run from web/ with `npm run data-health`. It writes a machine-readable
// `reports/data-health.json` and a human-readable `reports/data-health.md`, and
// — when running under GitHub Actions — appends the human report to the step
// summary. Both artifacts are pure functions of the versioned dataset already in
// the repository: no network, no environment, no secrets.
//
// Why it drives the site's TypeScript through Vite rather than importing it as
// plain Node modules: `src/data/dataset.ts` and `src/lib/data-health.ts` are
// TypeScript with extensionless imports, which Node's own loader will not
// resolve. `ssrLoadModule` loads them exactly the way the app does, so the report
// is computed over the same validated dataset the site renders — not a second,
// drifting copy.
//
// Exit codes: 0 when the dataset is coherent (ordinary staleness is reported, never
// failed); 1 only when a hard integrity violation is present (a verifiedAt in the
// future). That mirrors the split the web test suite already enforces on pull
// requests — age is a fact, a self-contradictory verification date is a fault.

import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const reportsDir = join(webRoot, 'reports');

async function main() {
  const referenceDate = new Date().toISOString().slice(0, 10);

  const server = await createServer({
    root: webRoot,
    configFile: false,
    logLevel: 'error',
    server: { middlewareMode: true },
    appType: 'custom',
  });

  let report;
  let integrityViolations;
  let markdown;
  try {
    const { dataset } = await server.ssrLoadModule('/src/data/dataset.ts');
    const { buildDataHealthReport, renderDataHealthMarkdown, collectIntegrityViolations } =
      await server.ssrLoadModule('/src/lib/data-health.ts');

    report = buildDataHealthReport(dataset, referenceDate);
    integrityViolations = collectIntegrityViolations(dataset, referenceDate);
    report.integrityViolations = integrityViolations;

    markdown = renderDataHealthMarkdown(report);
  } finally {
    await server.close();
  }

  await mkdir(reportsDir, { recursive: true });
  await writeFile(join(reportsDir, 'data-health.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(join(reportsDir, 'data-health.md'), markdown, 'utf8');

  const { summary } = report;
  process.stdout.write(
    `Data-health report (policy ${report.policyVersion}, reference ${referenceDate}): `
    + `${summary.total} records — ${summary.healthy} healthy, ${summary.stale} stale `
    + `(${summary.staleFeatured} featured, ${summary.staleLongTail} long-tail), `
    + `${summary.conflicted} conflicted; ${summary.coverageGapReleases} releases with coverage gaps.\n`,
  );

  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown, 'utf8');
  }

  if (integrityViolations.length > 0) {
    process.stdout.write(
      `\nHard integrity violations (${integrityViolations.length}):\n`
      + integrityViolations.map((v) => `  - ${v.kind} ${v.id}: ${v.message}`).join('\n')
      + '\n',
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`data-health report failed: ${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
