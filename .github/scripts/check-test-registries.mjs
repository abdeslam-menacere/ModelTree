#!/usr/bin/env node
//
// Refuses a `*.test.mjs` file under `.github/` that no CI registry names, and a
// registry entry that names a file which no longer exists.
//
// ## The defect
//
// Nothing under `.github/` runs its tests by globbing. Every place that runs one
// enumerates the filenames by hand:
//
//     .github/workflows/skills-ci.yml            `run: node --test <path>`
//     .github/workflows/source-link-health.yml   `run: node --test <path> <path>`
//     .github/scripts/ci-preflight.mjs           `args: ['--test', '<path>']`
//
// Each list is complete on its own terms and none of them can see the directory
// they are drawn from. A test file added without an entry is therefore not a
// failing test and not a skipped test -- it is a file nothing ever opens, and it
// reports nothing at all. `.github/skills/modeltree-scout/tests/check-bundle-pairing.test.mjs`
// sat in that state: a whole suite of passing tests that had never run in CI
// (abdeslam-menacere/ModelTree#1086). The count is deliberately not written down
// here -- a number in prose goes stale the first time a test is added, and
// check-skill-doc-test-counts.mjs exists because that keeps happening.
//
// ## Decision 1 -- compare each registry against the directory, never against
// another registry
//
// The tempting check is a cross-check: assert that the workflow and the preflight
// name the same files. It is worthless here, and its worthlessness is the whole
// point of the issue. At the moment this check was written the two registries
// **agreed** about `check-bundle-pairing.test.mjs`: both omitted it. Agreement
// between two enumerations says only that they were copied from each other. The
// question is what is on disk, so the directory listing is the reference and each
// registry is measured against it.
//
// ## Decision 2 -- union, not per-registry coverage
//
// A file is covered when **at least one** registry names it. Requiring every
// registry to name every file would be wrong on the repository as it stands:
// `link-health.test.mjs` belongs to the source-link-health workflow and has no
// business in `skills-ci.yml`, whose scope step does not even select for it.
//
// The cost of that choice is worth stating, because it is what a reader will test
// first: removing one of two registrations for the same file **passes**, by
// design. It is the removal of the last one that fails. The fixture corpora in
// `check-test-registries.test.mjs` include single-registry cases, where removing
// the one registration does fail, so the per-registry direction is demonstrated
// somewhere even though the real repository cannot demonstrate it.
//
// ## Decision 3 -- a registration is a path inside a `--test` argument region
//
// One rule covers all three syntaxes above, so there is no YAML parser and no JS
// parser here and nothing to keep in step with either. From each occurrence of
// `--test`, path tokens are consumed across whitespace, quotes and commas until
// the first token that is not a `.github/**/*.test.mjs` path. That terminates on
// `],` in the JS forms and on the next YAML key in the workflow forms.
//
// Requiring `--test` is deliberate and it is the conservative direction. A file
// merely *mentioned* in a registry -- in prose, in a comment, in a `NOT_COVERED`
// note -- is not a file that runs, and counting a mention as a registration would
// be a false pass, which is the failure this check exists to prevent. Erring the
// other way is loud: a registration this rule fails to see is reported as an
// orphan, and a human reads the report.
//
// Whole-line comments are stripped before extraction, so the `# ... node --test
// <directory> ...` notes that both workflows carry above their real commands
// cannot be read as registrations.
//
// ## Decision 4 -- an empty scan is not a pass
//
// Exit 2, never 0, when the directory listing is empty or when any registry
// yields no registrations at all. The asymmetry matters: a broken *extractor*
// fails loudly on its own, because every file on disk would read as an orphan,
// but a broken *listing* fails silently -- nothing on disk, so nothing
// unregistered, so a clean report about a scan that never happened. Not having
// looked and having looked and found nothing stay separately representable
// (`docs/adr/0018-not-looking-and-finding-nothing-are-separately-representable.md`).
//
// ## What this check does not do
//
//   - It does not require the enumerations to become globs. That is a larger
//     change to how CI selects tests -- it alters which tests run -- and the
//     issue that prompted this check leaves it to its own issue rather than
//     folding it in here. This guard works either way: it holds whether the
//     registries stay enumerations or are later replaced by globs.
//   - It does not look outside `.github/`. `web/` runs its tests through vitest,
//     which discovers them by pattern, so the defect class does not arise there.
//   - It does not check that a registered file contains any tests, only that it
//     is named. A registered file defining zero tests is a different defect.
//   - It does not check that a registry which names a file is one that will
//     actually be *selected* for a given pull request. Path filters are a
//     separate concern, documented in `.github/workflows/README.md`.
//
// Node built-ins only -- `skills-ci` installs nothing.
//
// Usage (no arguments, so the job cannot be pointed at an emptier tree):
//
//     node .github/scripts/check-test-registries.mjs
//
// Exit codes: 0 clean, 1 a defect was found, 2 the checker itself is unsound.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * The tree whose test files must be accounted for. `web/` is excluded by
 * decision: vitest discovers its tests by pattern, so no enumeration can drift
 * from it.
 */
const SEARCH_ROOT = ".github";

/** A file is a unit of this check when its name ends here. */
const TEST_SUFFIX = ".test.mjs";

/**
 * Every place that decides whether a test under `.github/` runs. A file is
 * covered when at least one of these names it (decision 2).
 *
 * `source-link-health.yml` is included even though `ci-preflight.mjs` names the
 * same two files. It changes no verdict today, and that is the point: it means a
 * stale path in that workflow is caught rather than knowingly unguarded.
 */
const REGISTRIES = [
  {
    path: ".github/workflows/skills-ci.yml",
    what: "the skills-ci workflow, which runs these on GitHub",
  },
  {
    path: ".github/workflows/source-link-health.yml",
    what: "the source-link-health workflow, which runs these on GitHub",
  },
  {
    path: ".github/scripts/ci-preflight.mjs",
    what: "the local preflight, which runs these before a hand-off",
  },
];

/** A repository-relative path to a test file, as a registry would write it. */
const TEST_PATH = new RegExp(
  `^${SEARCH_ROOT.replace(/\./g, "\\.")}/(?:[A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+${TEST_SUFFIX.replace(/\./g, "\\.")}$`,
);

/** What separates one argument from the next in every syntax covered here. */
const ARGUMENT_SEPARATOR = /[\s'",]/;

const FLAG = "--test";

/**
 * A line that is nothing but a comment, in either syntax the registries use.
 * Only whole-line comments are removed: a `#` inside a YAML `run:` string is
 * part of a command, not a comment, and removing it would corrupt the command.
 */
const WHOLE_LINE_COMMENT = /^\s*(?:#|\/\/)/;

const stripWholeLineComments = (text) =>
  text
    .split("\n")
    .map((line) => (WHOLE_LINE_COMMENT.test(line) ? "" : line))
    .join("\n");

/**
 * Every test path registered by `text`, in order of appearance, deduplicated.
 *
 * Comments are stripped first, then each `--test` opens a region in which
 * argument-shaped tokens are consumed until one is not a test path.
 */
function registrationsIn(text) {
  const source = stripWholeLineComments(text);
  const found = [];

  let from = 0;
  for (;;) {
    const flagAt = source.indexOf(FLAG, from);
    if (flagAt === -1) break;
    from = flagAt + FLAG.length;

    let cursor = from;
    for (;;) {
      while (cursor < source.length && ARGUMENT_SEPARATOR.test(source[cursor])) cursor += 1;
      const start = cursor;
      while (cursor < source.length && !ARGUMENT_SEPARATOR.test(source[cursor])) cursor += 1;
      const token = source.slice(start, cursor);
      if (token === "" || !TEST_PATH.test(token)) break;
      if (!found.includes(token)) found.push(token);
      from = cursor;
    }
  }

  return found;
}

/** Every `*.test.mjs` under `dir`, as repository-relative POSIX paths. */
function testFilesUnder(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...testFilesUnder(full));
    else if (entry.isFile() && entry.name.endsWith(TEST_SUFFIX)) found.push(full);
  }
  return found;
}

/**
 * The comparison, as data in and data out, so the self-check can drive it
 * without a filesystem.
 *
 * @param onDisk     paths the directory listing found
 * @param registered [registryPath, paths] pairs
 */
function analyse(onDisk, registered) {
  const covered = new Map();
  for (const [registry, paths] of registered) {
    for (const path of paths) {
      if (!covered.has(path)) covered.set(path, []);
      covered.get(path).push(registry);
    }
  }

  const orphans = onDisk.filter((path) => !covered.has(path));
  const stale = [];
  for (const [registry, paths] of registered) {
    for (const path of paths) {
      if (!onDisk.includes(path)) stale.push({ registry, path });
    }
  }

  return { orphans, stale, covered };
}

/**
 * Proves both detectors fire and that neither fires on a clean corpus, before a
 * single repository file is read. A run whose detectors are broken proves
 * nothing, and this is the difference between a pass and a silence.
 */
function selfCheck() {
  const broken = [];
  const A = ".github/scripts/a.test.mjs";
  const B = ".github/scripts/b.test.mjs";
  const GONE = ".github/scripts/deleted.test.mjs";

  // --- the comparison, both directions, plus a control that must stay silent ---

  const orphanCase = analyse([A, B], [["r1", [A]]]);
  if (!orphanCase.orphans.includes(B) || orphanCase.stale.length > 0) {
    broken.push(`a file on disk that no registry names was not reported as an orphan: ${JSON.stringify(orphanCase.orphans)}`);
  }

  const staleCase = analyse([A], [["r1", [A, GONE]]]);
  if (staleCase.stale.length !== 1 || staleCase.stale[0].path !== GONE || staleCase.orphans.length > 0) {
    broken.push(`a registry naming a file that does not exist was not reported as stale: ${JSON.stringify(staleCase.stale)}`);
  }

  const cleanCase = analyse([A], [["r1", [A]]]);
  if (cleanCase.orphans.length > 0 || cleanCase.stale.length > 0) {
    broken.push("a corpus with nothing wrong with it was flagged, so a finding from this run would mean nothing");
  }

  // The union of decision 2, stated as a case rather than left to the prose: two
  // registries covering one file each is clean, not two orphans.
  const unionCase = analyse([A, B], [["r1", [A]], ["r2", [B]]]);
  if (unionCase.orphans.length > 0 || unionCase.stale.length > 0) {
    broken.push("coverage was read per-registry rather than as a union, which would flag correctly split registries");
  }

  // --- the extractor, on the three syntaxes in use and on two it must ignore ---

  const forms = [
    ["yaml, one path", `        run: node --test ${A}\n      - name: Something else`, [A]],
    ["yaml, two paths", `        run: node --test ${A} ${B}\n      - name: Something else`, [A, B]],
    ["js, single-line array", `        args: ['--test', '${A}'],\n      },`, [A]],
    ["js, multi-line array", `        args: [\n          '--test',\n          '${A}',\n          '${B}',\n        ],`, [A, B]],
  ];
  for (const [label, sample, expected] of forms) {
    const got = registrationsIn(sample);
    if (got.join("|") !== expected.join("|")) {
      broken.push(`the ${label} form did not read as ${JSON.stringify(expected)} but as ${JSON.stringify(got)}`);
    }
  }

  const ignored = [
    ["a mention with no --test", `        run: node ${A}`],
    ["a whole-line YAML comment", `      # explicitly: \`node --test ${A}\` resolves differently`],
    ["a whole-line JS comment", `      // superseded: args: ['--test', '${A}'],`],
  ];
  for (const [label, sample] of ignored) {
    const got = registrationsIn(sample);
    if (got.length > 0) {
      broken.push(`${label} was read as a registration: ${JSON.stringify(got)}`);
    }
  }

  if (broken.length > 0) {
    console.error("check-test-registries: the detector is unsound, so this run proves nothing.");
    for (const line of broken) console.error(`  ${line}`);
    process.exit(2);
  }
}

const posix = (path) => path.split(sep).join("/");

if (process.argv.length > 2) {
  console.error(
    "check-test-registries: this check takes no arguments, so it cannot be pointed at an "
      + `emptier tree. Unrecognised: ${process.argv.slice(2).join(" ")}`,
  );
  process.exit(2);
}

selfCheck();

const searchRoot = join(REPO_ROOT, SEARCH_ROOT);
try {
  if (!statSync(searchRoot).isDirectory()) throw new Error("not a directory");
} catch (err) {
  console.error(`check-test-registries: cannot read ${SEARCH_ROOT}/: ${err.message}`);
  process.exit(2);
}

const onDisk = testFilesUnder(searchRoot).map((file) => posix(relative(REPO_ROOT, file)));

// Decision 4. A listing of nothing produces a clean report about a scan that
// never happened, so it is refused rather than passed.
if (onDisk.length === 0) {
  console.error(
    `check-test-registries: no ${TEST_SUFFIX} file was found under ${SEARCH_ROOT}/ at all. `
      + "A scan of nothing is not a pass.",
  );
  process.exit(2);
}

const registered = [];
for (const registry of REGISTRIES) {
  let text;
  try {
    text = readFileSync(join(REPO_ROOT, registry.path), "utf8");
  } catch (err) {
    console.error(`check-test-registries: cannot read the registry ${registry.path}: ${err.message}`);
    process.exit(2);
  }

  const paths = registrationsIn(text);
  // Decision 4 again, per registry: a registry that suddenly names nothing has
  // almost certainly changed shape in a way this extractor no longer reads, and
  // that must not present as "everything it used to name is now an orphan".
  if (paths.length === 0) {
    console.error(
      `check-test-registries: ${registry.path} yielded no registration at all. Either it stopped `
        + `running tests, or its syntax changed and the '${FLAG}' rule no longer reads it. Neither is a pass.`,
    );
    process.exit(2);
  }
  registered.push([registry.path, paths]);
}

const { orphans, stale, covered } = analyse(onDisk, registered);

// Printed on every run, passing runs included: which registry carries which file
// is the thing a reader needs in order to act on either finding (ADR 0018).
const coverageReport = () =>
  onDisk
    .map((path) => `  ${path}\n      ${(covered.get(path) ?? ["NOT REGISTERED ANYWHERE"]).join("\n      ")}`)
    .join("\n");

if (orphans.length > 0 || stale.length > 0) {
  console.error(
    "check-test-registries: the test files under .github/ and the registries that run them have "
      + "drifted apart.\n",
  );

  if (orphans.length > 0) {
    console.error(
      `  [orphan] ${orphans.length} test file(s) exist that no registry names, so nothing ever runs them:`,
    );
    for (const path of orphans) console.error(`    ${path}`);
    console.error(
      `\n  Add each to at least one of: ${REGISTRIES.map((registry) => registry.path).join(", ")}.`
        + "\n  A test nothing runs is not a passing test; it reports nothing at all.\n",
    );
  }

  if (stale.length > 0) {
    console.error(`  [stale] ${stale.length} registration(s) name a file that does not exist:`);
    for (const { registry, path } of stale) console.error(`    ${registry} names ${path}`);
    console.error(
      "\n  Either the file moved and the registry did not follow, or the registration outlived the "
        + "file.\n  A registry entry pointing at nothing fails the job it was meant to protect.\n",
    );
  }

  console.error(`Coverage as measured:\n${coverageReport()}`);
  process.exit(1);
}

console.log(
  `check-test-registries: OK -- all ${onDisk.length} ${TEST_SUFFIX} file(s) under ${SEARCH_ROOT}/ are `
    + `named by at least one of ${REGISTRIES.length} registries, and every registration names a file `
    + "that exists.",
);
console.log(`Coverage as measured:\n${coverageReport()}`);
console.log(
  "\nNot checked by this program: whether a registered file defines any tests, and whether the "
    + "registry naming it is selected for any given pull request.",
);
