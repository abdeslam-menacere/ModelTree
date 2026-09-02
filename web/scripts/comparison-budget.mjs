// Measures the `/compare` payload and the comparison picker index against their
// ceilings, for **the tree this file sits in** (issue #753).
//
// The two subjects are not the same kind of thing, and the report says so on
// every line (#693). The `/compare` payload is **shipped**: compare.astro
// serializes it into the page and every reader downloads it, so its ceilings
// bound real page weight. The picker index is **UNSHIPPED**:
// `buildComparisonPickerIndex` has no production consumer — no .astro page, no
// component and no client bundle imports it — so its ceilings bound bytes
// nobody receives. They are kept deliberately, as a design constraint on the
// shape a /compare picker would ship if it is built (#693, reading (b)), and
// they still bind: nothing here lowers or bypasses one. What the labelling is
// for is the decision a reader makes on a breach. A picker breach read as a
// page-weight regression invites cutting dataset records or raising the
// ceiling, and this repository has paid for both — three raises of 1,024 bytes,
// #740's three dropped creators, and #754 to recover them.
//
// This is the half of the merged-budget instrument that has to be tree-local.
// `merged-budget.mjs` materializes two trees — `HEAD`, and the merge of `HEAD`
// with `refs/remotes/origin/main` — and runs *each tree's own copy of this
// script* inside it. That is deliberate: if trunk changed `comparison.ts`, the
// merged figure has to be produced by the merged instrument, not by the
// branch's. A driver that carried one measurer to both trees would report the
// branch's idea of the payload shape as though it were the merged one, which is
// the same class of defect the issue is about, moved one level up.
//
// Run on its own it answers "where do I stand right now", which is what
// `npm run budget:compare` is for. It is the merged figure that binds, so
// prefer `npm run budget:merged`; this one is here because the driver needs it
// and because a single-tree number is still worth having when there is no
// remote to compare against.
//
// Why it drives the site's TypeScript through Vite rather than importing it as
// plain Node modules: `src/data/dataset.ts` and `src/lib/comparison.ts` are
// TypeScript with extensionless imports and JSON imports, which Node's own
// loader will not resolve. `ssrLoadModule` loads them exactly the way the app
// does, so the figures are computed over the same validated dataset the site
// renders. `scripts/data-health.mjs` takes the same route for the same reason.
//
// Two rules this file exists to keep, both from the issue's acceptance criteria:
//
//   * **The instruments are the repository's own.** `measureComparisonPayload`
//     and `buildComparisonPickerIndex` are imported and called, never
//     reimplemented. A replicated byte count is a second thing to keep in sync
//     and it drifts silently — which is exactly the failure mode being closed,
//     so reproducing it here would be self-defeating.
//   * **The ceilings are read out of `src/lib/comparison.test.ts`.** They are
//     not restated here as literals. A literal copied out of that file is the
//     same drift by another route: the test would move and this would keep
//     reporting headroom against a ceiling nobody enforces any more.
//
// The one measurement this file does compute itself is the picker index's byte
// length, because `comparison.ts` exports no measurer for it — the test counts
// `TextEncoder().encode(JSON.stringify(index)).length` inline. That expression
// is mirrored here character for character, and `merged-budget.test.ts` pins the
// mirror by asserting this script's picker figure equals the test's own method
// over the live dataset. If the test's method changes, that assertion fails.
//
// Exit codes: 0 every measured figure is within its ceiling, 1 at least one is
// not, 2 the measurement could not be taken. **2 is never a pass.**

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRootOf = (url) => dirname(dirname(fileURLToPath(url)));

/**
 * What a breach of an unshipped ceiling means, and what it must not be answered
 * with. Stated once and reused by every renderer, so the report a reader sees
 * carries the same instruction as the assertion message in
 * `src/lib/comparison.test.ts` rather than a paraphrase of it.
 */
export const UNSHIPPED_ESCALATION = [
  'The picker index is UNSHIPPED: no page delivers these bytes. buildComparisonPickerIndex has',
  'no production consumer — compare.astro ships buildComparisonPayload — so its ceilings are a',
  'design constraint on a /compare picker that has not been built yet (#693, reading (b)), not',
  'a regression in anything a reader downloads. A tranche blocked here must NOT be resolved by',
  'cutting dataset records (#740 cut three creators against this ceiling; #754 exists to recover',
  'them) and must NOT be resolved by raising the ceiling, already raised three times at 1,024',
  "bytes each. Trim the row shape, or raise it as a design question about the future row's",
  'shape. The ceiling still binds either way; it is not bypassable from here.',
];

/**
 * Where each ceiling lives in `comparison.test.ts`, keyed by the expression the
 * assertion is made about.
 *
 * The *values* are read from that file; only the binding between an instrument's
 * output and the assertion that constrains it is stated here, because it has to
 * be stated somewhere and no file can derive it. A subject that stops appearing,
 * or starts appearing twice, is a refusal (exit 2) rather than a guess — see
 * {@link readCeilings}.
 *
 * `shipped` records whether the measured artefact is bytes a reader actually
 * downloads. It is the one field here that is not about parsing: it exists so a
 * breach of the picker ceilings cannot be read as a page-weight regression, which
 * is the confusion that has cost this repository three ceiling raises, a dropped
 * data tranche and a recovery issue (#693).
 */
export const CEILING_SUBJECTS = [
  {
    id: 'payload.totalBytes',
    subject: 'size.totalBytes',
    label: '/compare payload, total',
    unit: 'bytes',
    shipped: true,
  },
  {
    id: 'payload.bytesPerRelease',
    subject: 'size.bytesPerRelease',
    label: '/compare payload, per release',
    unit: 'bytes/release',
    shipped: true,
  },
  {
    id: 'picker.totalBytes',
    subject: 'bytes',
    label: 'picker index, total',
    unit: 'bytes',
    shipped: false,
  },
  {
    id: 'picker.bytesPerRelease',
    subject: 'bytesPerRelease',
    label: 'picker index, per release',
    unit: 'bytes/release',
    shipped: false,
  },
];

const UPPER_BOUND_MATCHER = '.toBeLessThanOrEqual(';

/**
 * The numeric upper bound asserted about `subject`, read out of test source.
 *
 * Anchored on `expect(<subject>,` so that `bytes` cannot match the `bytes` in
 * `size.totalBytes` — the anchor pins what precedes the subject, not just the
 * subject. Between the anchor and the `toBeLessThanOrEqual` call sits the
 * assertion's failure message, which is why the span is scanned rather than
 * matched exactly; an intervening `expect(` means the two belong to different
 * assertions and the candidate is dropped rather than paired across them.
 *
 * Returns every match, so the caller can refuse an ambiguous file instead of
 * silently taking the first.
 */
function upperBoundsFor(source, subject) {
  const anchor = new RegExp(String.raw`expect\(\s*${subject.replace(/\./g, '\\.')}\s*,`, 'g');
  const found = [];

  for (let match = anchor.exec(source); match !== null; match = anchor.exec(source)) {
    const rest = source.slice(match.index + match[0].length);
    const callAt = rest.indexOf(UPPER_BOUND_MATCHER);
    if (callAt === -1) continue;
    if (rest.slice(0, callAt).includes('expect(')) continue;

    const literal = /^\s*([0-9][0-9_]*)\s*\)/.exec(rest.slice(callAt + UPPER_BOUND_MATCHER.length));
    if (literal === null) continue;

    const value = Number(literal[1].replace(/_/g, ''));
    if (Number.isSafeInteger(value) && value > 0) found.push(value);
  }

  return found;
}

/**
 * The four ceilings, read from the text of `src/lib/comparison.test.ts`.
 *
 * Every failure here is a refusal, never a default. A ceiling this could not
 * read is a ceiling it cannot report headroom against, and inventing one — or
 * falling back to a literal — would produce a confident number measured against
 * a bound nothing enforces. That is the defect class this whole tool exists to
 * close, so it is the one thing it may not do.
 *
 * @param {string} source the contents of `src/lib/comparison.test.ts`
 * @returns {Record<string, number>} every ceiling in {@link CEILING_SUBJECTS}
 */
export function readCeilings(source) {
  /** @type {Record<string, number>} */
  const ceilings = {};
  /** @type {string[]} */
  const problems = [];

  for (const { id, subject } of CEILING_SUBJECTS) {
    const found = upperBoundsFor(source, subject);
    if (found.length === 1) {
      ceilings[id] = found[0];
    } else if (found.length === 0) {
      problems.push(
        `no \`expect(${subject}, ...).toBeLessThanOrEqual(<number>)\` assertion for ${id}`,
      );
    } else {
      problems.push(
        `${found.length} upper-bound assertions about \`${subject}\` (${found.join(', ')}), `
        + `so which one bounds ${id} is ambiguous`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      'cannot read the byte ceilings out of src/lib/comparison.test.ts, so there is nothing to '
      + `report headroom against:\n  - ${problems.join('\n  - ')}\n`
      + 'The ceilings are read from that file rather than restated here, so a change to how it '
      + 'asserts them stops this tool loudly instead of letting it measure against a stale copy.',
    );
  }

  return ceilings;
}

/**
 * Bytes the picker index would ship, and the per-row figure.
 *
 * `comparison.ts` exports no measurer for this — `comparison.test.ts` counts
 * `new TextEncoder().encode(JSON.stringify(index)).length` inline and rounds the
 * per-row figure — so the expression is mirrored here rather than invented, and
 * the mirror is pinned by a test that computes the ceiling's own expression over
 * the live dataset and asserts this agrees. If the test's method changes, that
 * assertion fails rather than this drifting away in silence.
 *
 * The payload has an exported measurer, `measureComparisonPayload`, so that one
 * is called and never reimplemented.
 *
 * @param {readonly unknown[]} index the rows from `buildComparisonPickerIndex`
 */
export function measurePickerIndex(index) {
  const bytes = new TextEncoder().encode(JSON.stringify(index)).length;
  return {
    bytes,
    bytesPerRelease: index.length === 0 ? 0 : Math.round(bytes / index.length),
  };
}

/**
 * Measure one tree: load its dataset and its comparison module, and size both
 * the shipped `/compare` payload and the picker index.
 *
 * @param {string} webRoot the `web/` directory of the tree to measure
 */
export async function measureTree(webRoot) {
  const ceilings = readCeilings(
    readFileSync(join(webRoot, 'src', 'lib', 'comparison.test.ts'), 'utf8'),
  );

  // Imported lazily and by name so this module can be loaded by a test for its
  // pure helpers without booting a Vite server.
  const { createServer } = await import('vite');
  const server = await createServer({
    root: webRoot,
    configFile: false,
    logLevel: 'error',
    server: { middlewareMode: true },
    appType: 'custom',
  });

  try {
    const { dataset } = await server.ssrLoadModule('/src/data/dataset.ts');
    const { buildComparisonPayload, measureComparisonPayload, buildComparisonPickerIndex } =
      await server.ssrLoadModule('/src/lib/comparison.ts');

    const payload = measureComparisonPayload(buildComparisonPayload(dataset));

    const index = buildComparisonPickerIndex(dataset);
    const picker = measurePickerIndex(index);

    const values = {
      'payload.totalBytes': payload.totalBytes,
      'payload.bytesPerRelease': payload.bytesPerRelease,
      'picker.totalBytes': picker.bytes,
      'picker.bytesPerRelease': picker.bytesPerRelease,
    };

    return {
      releaseCount: dataset.releases.length,
      pickerRowCount: index.length,
      metrics: CEILING_SUBJECTS.map(({ id, label, unit, shipped }) => {
        const value = values[id];
        const ceiling = ceilings[id];
        return {
          id,
          label,
          unit,
          shipped,
          value,
          ceiling,
          headroom: ceiling - value,
          within: value <= ceiling,
        };
      }),
    };
  } finally {
    await server.close();
  }
}

const group = (value) => value.toLocaleString('en-US');

/**
 * Whether a metric measures bytes a reader downloads, defaulting from
 * {@link CEILING_SUBJECTS} when a caller built the metric without the field.
 * Unknown ids are treated as shipped, because the annotation is a claim and an
 * unfounded "UNSHIPPED" is the one direction that would excuse a real breach.
 */
export function isShipped(metric) {
  if (typeof metric.shipped === 'boolean') return metric.shipped;
  const subject = CEILING_SUBJECTS.find(({ id }) => id === metric.id);
  return subject === undefined ? true : subject.shipped;
}

export function renderMeasurement(measurement) {
  const lines = [
    `${measurement.releaseCount} releases, ${measurement.pickerRowCount} picker rows`,
    '',
  ];
  for (const metric of measurement.metrics) {
    lines.push(
      `  ${metric.within ? 'ok  ' : 'OVER'} ${metric.label.padEnd(29)} `
      + `${group(metric.value).padStart(9)} of ${group(metric.ceiling).padStart(9)} ${metric.unit} `
      + `(${metric.headroom >= 0 ? '' : '-'}${group(Math.abs(metric.headroom))} `
      + `${metric.headroom >= 0 ? 'spare' : 'over'})`
      + (isShipped(metric) ? '  [shipped]' : '  [UNSHIPPED — no page delivers these bytes]'),
    );
  }

  // Printed only on a breach of an unshipped ceiling, because that is the moment
  // someone is about to decide what gives way. It changes no verdict: the metric
  // is still OVER and `main` still returns 1.
  if (measurement.metrics.some((metric) => !metric.within && !isShipped(metric))) {
    lines.push('', ...UNSHIPPED_ESCALATION);
  }

  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const args = { json: false };
  for (const flag of argv.slice(2)) {
    if (flag === '--json') args.json = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
    else {
      process.stderr.write(`comparison-budget: unknown flag ${flag}\n`);
      process.exit(2);
    }
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write('usage: node scripts/comparison-budget.mjs [--json]\n');
    return 0;
  }

  let measurement;
  try {
    measurement = await measureTree(webRootOf(import.meta.url));
  } catch (error) {
    process.stderr.write(`comparison-budget: ${error?.message ?? error}\n`);
    return 2;
  }

  process.stdout.write(
    args.json ? `${JSON.stringify(measurement, null, 2)}\n` : renderMeasurement(measurement),
  );
  return measurement.metrics.every((metric) => metric.within) ? 0 : 1;
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exit(await main(process.argv));
}
