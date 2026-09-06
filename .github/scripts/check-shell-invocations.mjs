#!/usr/bin/env node
//
// Refuses a shell block in an agent-facing document that Windows PowerShell 5.1
// cannot parse.
//
// ## The defect, and why prose does not hold it
//
// An agent working in this repository runs its commands through Windows
// PowerShell 5.1. A document that writes `cd web && npm run validate` hands that
// agent a **parse** error rather than a runtime one, and the difference is the
// whole reason this is worth mechanising:
//
//   - A parse error discards the *entire* script block, not the one bad line, so
//     an agent that ran three commands gets none of them.
//   - The message blames a token -- "The token '&&' is not a valid statement
//     separator in this version" -- so an agent reading it learns nothing about
//     which tool it was trying to reach.
//   - It is invisible to review. The string is valid on the reviewer's machine,
//     valid in bash, valid in PowerShell 7, and valid in every editor.
//
// abdeslam-menacere/ModelTree#604 fixed this class in
// `.github/copilot-instructions.md` and abdeslam-menacere/ModelTree#614 fixed it
// across `.github/skills/**`. Both fixes are prose, and prose decays: nothing
// stopped the next author from writing the same thing again.
//
// The ratio that argues for a check rather than another sweep is recorded in
// abdeslam-menacere/ModelTree#652. Reading found four in-class sites; parsing
// found six. The two the reading missed were not exotic -- a `git switch main &&
// git pull`, and bash `\` line continuations -- they were simply not what the
// reader's eye was tuned for.
//
// ## Decision 1 -- which documents are covered
//
// Covered: the documents an agent is told to read and act on.
//
//     .github/copilot-instructions.md   the standing brief every agent reads first
//     .github/agents/**/*.md            the agent definitions that prescribe commands
//     .github/skills/**/*.md            the skills an agent executes step by step
//
// That boundary is a property of the reader, not of the directory: these are the
// files whose commands are *dispatched by a machine* that will not notice a
// discarded block. Everything else in the repository is read by a person, who
// sees the error and adapts.
//
// The cost of the boundary was measured before it was drawn, on the working tree
// at `refs/remotes/origin/main` = `c77fb74e3ab6731d857c936dd0d07759c33da7d4`,
// reflog-dated 2026-09-06T02:59:30-04:00 -- see the measurement note below for how
// to re-take it. Every fenced `bash`, `sh` and `powershell` block in the
// repository was parsed with the real Windows PowerShell 5.1 parser
// (`PSVersion 5.1.26100.9168`), after placeholder substitution:
//
//     .github/copilot-instructions.md              19 blocks   0 fail
//     .github/agents/*.md                           2 blocks   0 fail
//     .github/skills/**/*.md                       15 blocks   2 fail
//     ---- outside the covered set ----
//     docs/product/LAUNCH-RUNBOOK.md               17 blocks   5 fail
//     tools/updater/README.md                       6 blocks   3 fail
//     .github/workflows/README.md, README.md        2 blocks   0 fail
//
// The two failures inside the covered set are real and were fixed alongside this
// check. The eight outside it are the reason the boundary is drawn where it is,
// and they are named rather than swept behind it:
//
//   - `docs/product/LAUNCH-RUNBOOK.md` holds five genuine bash *programs* -- `for`
//     loops, `[ ]` tests, `>&2` redirections -- written for a human operator at a
//     bash prompt during a launch. They do not parse as PowerShell and were never
//     meant to. Covering that file would demand either rewriting working bash into
//     PowerShell, which is a change to a document this check has no business
//     touching, or exempting the whole file, which buys nothing.
//   - `tools/updater/README.md` holds three, including a real
//     `python -m venv .venv && .venv/Scripts/activate` on a line that names the
//     macOS/Linux alternative in a trailing comment -- so the `&&` form is the one
//     offered to a Windows reader. It is a developer setup document read by a
//     person, so it is outside the boundary above; it is a live candidate for a
//     follow-up rather than a clean sheet.
//
// `docs/adr/` is deliberately out. An ADR records a decision that was taken; it
// does not prescribe commands to run, and its blocks are transcripts of what a
// measurement printed.
//
// ## Decision 2 -- where the parse runs
//
// It runs here, in Node, as a deterministic scan of the constructs listed under
// "What is detected" -- on the ordinary `ubuntu-latest` runner that already hosts
// `skills-ci`, and identically on every contributor's machine. It is **not** a
// real PowerShell parse, and the alternatives were rejected on specific grounds:
//
//   - **A real Windows PowerShell 5.1 parse on a `windows-latest` runner** is the
//     exact answer and is what the samples below were measured against. It is
//     rejected as the *check* because of what it would do to the local half. This
//     repository's whole pre-merge story is `.github/scripts/ci-preflight.mjs`
//     running CI's own commands before the pull request opens, and that script
//     exits **2** -- could not run -- for anything the machine cannot host. A
//     check that exits 2 on every non-Windows contributor teaches its readers to
//     skim past the one code that must never be read as green; the header of
//     `ci-preflight.mjs` records four sessions doing exactly that over a Python
//     import. Buying exactness in CI at the price of an unrunnable local check is
//     the wrong way round for a defect whose whole nature is that it is invisible
//     until something runs it.
//   - **A real parse with `pwsh` on the Linux runner** is the cheap version of the
//     same idea and is worse than useless here. PowerShell 7 added `&&` and `||`
//     as pipeline chain operators, so the flagship member of this defect class --
//     the `cd web && npm run validate` that abdeslam-menacere/ModelTree#604 was
//     filed about -- parses clean under `pwsh`. A check built on it would be green
//     on the exact string it exists to catch. Not measured here: `pwsh` is not
//     installed on the machine this was written on, so this rests on the
//     PowerShell 7 language change rather than on a local reading. Anyone with
//     `pwsh` can settle it in one command; nothing in this file depends on the
//     answer, because `pwsh` is not what runs.
//
// What the scan gives up in exchange is stated under "What is NOT detected", and
// is not nothing. It is a subset detector: everything it flags is a measured
// Windows PowerShell 5.1 parse error, and there are parse errors it cannot see.
//
// ## What is detected
//
// Each rule below was measured against
// `[System.Management.Automation.Language.Parser]::ParseInput` on
// `PSVersion 5.1.26100.9168`, and each `MUST_FLAG` sample is a string that parser
// rejected. The message each one produces is quoted beside the sample.
//
//   1. `&&` and `||` outside a string or comment, including inside a `$( ... )`
//      within a double-quoted string, where they are measured to fail too.
//   2. A trailing `\` at end of line outside any string -- a bash line
//      continuation -- where the next line opens with `--flag`. PowerShell does
//      not continue the line, so that next line is parsed as a fresh statement
//      and its `--` is read as the pre-decrement operator.
//   3. `<` outside a string or comment and not at the start of a line, after
//      placeholder substitution -- input redirection, or a heredoc, neither of
//      which PowerShell 5.1 has.
//   4. A block that ends inside an unterminated string or here-string.
//
// Rules 2 and 3 are narrower than they first look, and each boundary is a
// measurement rather than caution. `sort < in.txt` is a parse error while a line
// *opening* with `<` is not, which is what keeps an HTML comment inside a fence
// from being read as a defect. A continuation followed by a bareword --
// `npm run test:e2e -- \` then `e2e/a.e2e.ts` -- parses clean, so only the
// `--flag` shape is claimed.
//
// ## Placeholder substitution, which is load-bearing
//
// `<bundle>` is not a defect, and a check that reads it as one is a check that
// gets switched off. Measured: `node a.mjs --claims <bundle> --json` produces
// "The '<' operator is reserved for future use." and the same line with the
// placeholder substituted parses clean. Repository-wide, five `powershell` blocks
// in `.github/copilot-instructions.md` fail the real parser for this reason alone
// and zero fail after substitution -- so without this step the check would open
// with five false positives in the one file every agent reads first.
//
// The substituted span must not begin or end with whitespace. That is what keeps
// `< in.txt >` -- a real redirection, which the parser really does reject -- from
// being read as a placeholder. Every placeholder in the corpus satisfies it,
// including the ones carrying spaces inside, such as `<token with issues:write>`.
//
// ## What is NOT detected, so the promise stays honest
//
//   - **Bash grammar.** `for x in a b; do ... done`, `if [ -n "$x" ]; then ... fi`
//     and `case ... esac` are parse errors in PowerShell that this scan does not
//     see. Nothing in the covered set uses them today; a document that adopts them
//     needs the boundary above revisited, not this list extended in silence.
//   - **Unlabelled fences.** A fence with no info string is not read. Measured
//     repository-wide there are 50 of them, 24 in `.github/copilot-instructions.md`
//     alone, and sampling them shows what they are: commit messages, ASCII
//     diagrams, and transcripts of what a command printed. They are unlabelled
//     *because* they are not prescriptions. Reading them would flag output.
//   - **`pwsh` fences.** None exist today. If one appears it is a claim about
//     PowerShell 7, where `&&` is legal, and it must not be judged by this scan.
//   - **Runtime failure.** A block that parses and then does the wrong thing is
//     outside this check by construction. Two families sit here. The unquoted
//     rev-range one -- `git rev-list --count $mb..HEAD`, where PowerShell splits
//     one argument into two -- parses clean, is pinned in `MUST_NOT_FLAG` so a
//     later widening cannot take it silently, and belongs to an issue of its own.
//     So does the bash continuation whose next line opens with a bareword rather
//     than a flag: `npm run test:e2e -- \` followed by `e2e/a.e2e.ts` parses as
//     two commands and runs the wrong one, quietly, and rule 2 does not claim it.
//
// ## Why this file may quote what it refuses, and the workflow README may too
//
// A substring scanner cannot be pointed at the prose documenting it. This one is
// bounded two ways at once -- to the covered documents above, and to fenced
// blocks tagged `bash`, `sh` or `powershell` inside them -- so `.mjs` source,
// inline code in prose, and a `text` fence are all invisible to it. That is why
// `.github/workflows/README.md` can print a `cd web && npm run validate` as the
// example of what fails: it is outside the covered set, and the example is not in
// a covered fence either. Two independent reasons, neither of them luck.
//
// ## Quoting another tool's input
//
// A block that quotes something *else's* shell -- a `package.json` script body, a
// bash `run:` step from a workflow -- is prescribing nothing to a PowerShell
// agent, and rewriting it would make the document wrong. Two such quotes exist in
// this repository, in `.github/workflows/README.md` and
// `docs/product/DEPLOYMENT-RUNBOOK.md`, and both are inline code in prose in
// uncovered files, so nothing here reaches them.
//
// For the case that is not already structurally out, an exemption is available
// and must carry a reason:
//
//     <!-- shell-parse-exempt: quoted from package.json; npm runs this in sh -->
//     ```bash
//     npm run validate && astro build
//     ```
//
// The marker sits on the line immediately before the fence and covers that one
// block. A marker with an empty reason is a failure, not an exemption: the point
// of the mechanism is that the next reader can audit why a block was skipped.
// Every exemption is counted and named on every run, passing runs included,
// because a block that was not read is not a block that was read and found clean
// (`docs/adr/0018-not-looking-and-finding-nothing-are-separately-representable.md`).
//
// ## Fail-closed
//
// A scanner that silently matches nothing manufactures confidence. Before it
// reads a single file this one runs every rule over samples that must flag and
// samples that must not, and it exits 2 -- never 0 -- if the covered set turns up
// no file or no block.
//
// ## Why nothing here is a pattern handed to a shell
//
// This matches in process. It reads files with `readFileSync` and scans the text
// itself; it imports no `child_process`, and it refuses arguments outright, so
// there is no pattern for a shell to rewrite on the way in. That is a deliberate
// property rather than an incidental one, because the obvious alternative --
// shelling out to `git grep` with the pattern that names this defect class -- is
// itself an instance of the class it would be looking for. A `git grep` pattern
// containing a double quote is mangled by the shell before git sees it, and comes
// back as no output at exit 1: indistinguishable from a clean corpus. Measured
// twice, independently, on this repository: a bare-range sweep reported "no live
// instances" while an argv array over the same tree found three.
//
// The defect selects for the well-aimed detector. A pattern that does not mention
// quoting has no quote in it and runs fine, so the query is mangled in proportion
// to how directly it targets the class -- and a positive control written the
// natural way exercises the working path while the real query is blind.
//
// The control that separates them has to hold the quote constant across arms that
// must come back differing, and `MUST_FLAG` / `MUST_NOT_FLAG` below carry it:
// `$x = "$(git status && git log)"` must flag, `Write-Output "a && b"` and
// `C="$(gh run list --limit 1 \` ... `)"` must not. All three carry a double
// quote, two carry `&&`, and the verdicts differ -- which a matcher blinded by
// quoting could not produce, since blindness here yields no finding at all. Keep
// a quote-carrying sample on both sides of that pair if these lists are edited.
//
// ## How to re-take the measurements above
//
// They are readings against a corpus that moves, so re-take them rather than
// trusting the figures. On a Windows machine, extract the fenced blocks and feed
// each one to the real parser:
//
//     $e = $null; $t = $null
//     [void][System.Management.Automation.Language.Parser]::ParseInput($body, [ref]$t, [ref]$e)
//
// with `$body` substituted the way `substitutePlaceholders` below substitutes it.
// The comparison worth running is one-directional: everything this scan flags
// must be a real parse error. The reverse does not hold and is not claimed.
//
// Node built-ins only -- `skills-ci` installs nothing.
//
// Usage (no arguments, so the job cannot be pointed at an emptier tree):
//
//     node .github/scripts/check-shell-invocations.mjs
//
// Exit codes: 0 clean, 1 a defect was found, 2 the checker itself is unsound.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * The covered set of decision 1, as repository-relative paths. A file is scanned
 * as itself; a directory is walked for markdown. Widening this is the decision
 * argued in the header, never a tidy-up.
 */
const COVERED = [".github/copilot-instructions.md", ".github/agents", ".github/skills"];

/**
 * The fence info strings whose content is a prescription for a shell an agent
 * will drive. `pwsh` is deliberately absent: it names PowerShell 7, whose grammar
 * accepts `&&`.
 */
const COVERED_LANGUAGES = new Set(["bash", "sh", "powershell"]);

/**
 * A documented placeholder, substituted before anything is judged.
 *
 * The first and last characters inside the angle brackets must be non-space, so
 * `< in.txt >` stays a redirection and `<token with issues:write>` stays a
 * placeholder. Newlines are excluded so a stray `<` cannot swallow a whole block.
 */
const PLACEHOLDER = /<[^\s<>](?:[^<>\r\n]*[^\s<>])?>/g;

const substitutePlaceholders = (text) => text.replace(PLACEHOLDER, "PLACEHOLDER");

/** `<!-- shell-parse-exempt: reason -->` on the line immediately before a fence. */
const EXEMPTION = /^<!--\s*shell-parse-exempt:(.*)-->\s*$/;

const REMEDY = {
  "chain-operator":
    "Windows PowerShell 5.1 rejects `&&` and `||` as a parse error, which discards the whole "
    + "block rather than the one line. Sequence the steps as separate lines, or with `;` and an "
    + "explicit `if ($?) { ... }` -- `;` alone is not a translation of `&&`, because it runs the "
    + "next command whether or not the previous one failed.",
  "line-continuation":
    "A trailing `\\` is a bash line continuation. PowerShell does not continue the line: the "
    + "backslash becomes an argument and the next line is parsed as a fresh statement, which is "
    + "where the error surfaces. Put the command on one line.",
  "reserved-angle":
    "`<` is reserved in Windows PowerShell 5.1, so input redirection and heredocs are both parse "
    + "errors. There is no heredoc; pipe a here-string (`@'` ... `'@`) into the command instead. "
    + "If this was meant to be a documented placeholder, write it as `<name>` with no space "
    + "inside the angle brackets, which this check substitutes before judging anything.",
  "unterminated-string":
    "The block ends inside a string that was never closed, so PowerShell cannot parse it at all.",
};

/**
 * The scan of decision 2.
 *
 * It tracks enough PowerShell lexical state to know whether a character is code,
 * and reports the constructs listed in the header. `stringDepth` is separate from
 * the context stack because the two rules differ: `&&` inside `"$( ... )"` is a
 * measured parse error, while a trailing `\` in the same position is not.
 *
 * Returns findings as `{ line, rule, evidence }`, with `line` one-based within
 * the block body.
 */
function scanShell(text) {
  const findings = [];
  const lines = text.split("\n");
  // 'code' | 'sq' | 'dq' | 'here-sq' | 'here-dq'
  const stack = [{ kind: "code", inString: false }];
  const top = () => stack[stack.length - 1];
  const stringDepth = () => stack.filter((frame) => frame.inString).length;
  const seen = new Set();

  const report = (lineIndex, rule) => {
    const key = `${lineIndex}:${rule}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ line: lineIndex + 1, rule, evidence: lines[lineIndex].trim() });
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];

    // A here-string terminator owns its whole line, so it is settled before the
    // line is walked character by character.
    const frame = top();
    if (frame.kind === "here-sq" || frame.kind === "here-dq") {
      const terminator = frame.kind === "here-sq" ? "'@" : '"@';
      if (line.trim().startsWith(terminator)) stack.pop();
      continue;
    }

    let inLineComment = false;

    for (let i = 0; i < line.length; i += 1) {
      const here = top();
      const ch = line[i];
      const next = line[i + 1] ?? "";

      if (inLineComment) break;

      if (here.kind === "sq") {
        if (ch === "'") {
          // `''` is an escaped quote inside a single-quoted string.
          if (next === "'") i += 1;
          else stack.pop();
        }
        continue;
      }

      if (here.kind === "dq") {
        if (ch === "`") {
          i += 1;
          continue;
        }
        if (ch === '"') {
          if (next === '"') i += 1;
          else stack.pop();
          continue;
        }
        // A subexpression inside a double-quoted string is parsed as code, which
        // is why `"$(a && b)"` is a parse error.
        if (ch === "$" && next === "(") {
          stack.push({ kind: "code", inString: true, paren: 0 });
          i += 1;
        }
        continue;
      }

      // Code.
      if (ch === "`") {
        i += 1;
        continue;
      }
      if (ch === "<" && next === "#") {
        const close = line.indexOf("#>", i + 2);
        if (close === -1) break; // A block comment runs to a later line; nothing to judge here.
        i = close + 1;
        continue;
      }
      if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
        inLineComment = true;
        continue;
      }
      if (ch === "'") {
        stack.push({ kind: "sq", inString: true });
        continue;
      }
      if (ch === '"') {
        stack.push({ kind: "dq", inString: true });
        continue;
      }
      if (ch === "@" && (next === "'" || next === '"') && line.slice(i + 2).trim() === "") {
        stack.push({ kind: next === "'" ? "here-sq" : "here-dq", inString: true });
        i = line.length;
        continue;
      }
      if (ch === "$" && next === "(") {
        here.paren = (here.paren ?? 0) + 1;
        i += 1;
        continue;
      }
      if (ch === ")" && here.inString) {
        if ((here.paren ?? 0) > 0) here.paren -= 1;
        else stack.pop();
        continue;
      }
      if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
        report(lineIndex, "chain-operator");
        i += 1;
        continue;
      }
      // `<` is reserved -- but only once a statement is under way. Measured:
      // `sort < in.txt` is an error and a line opening with `<` is not, which is
      // what keeps an HTML comment in a fence from being read as a defect.
      if (ch === "<" && line.slice(0, i).trim() !== "") {
        report(lineIndex, "reserved-angle");
        continue;
      }
      // A bash continuation, judged only in the shape that really breaks the
      // parse. Two measurements bound it: the same continuation inside
      // `"$( ... )"` parses, and a continuation whose next line opens with a
      // bareword parses too. What fails is the next line opening with `--flag`,
      // where `--` is read as the pre-decrement operator.
      if (ch === "\\" && line.slice(i + 1).trim() === "" && stringDepth() === 0) {
        const continued = lines.slice(lineIndex + 1).find((candidate) => candidate.trim() !== "");
        if (continued !== undefined && /^--([A-Za-z_]|$)/.test(continued.trim())) {
          report(lineIndex, "line-continuation");
        }
        i = line.length;
      }
    }
  }

  if (top().kind !== "code" || stack.length > 1) {
    report(Math.max(lines.length - 1, 0), "unterminated-string");
  }

  return findings;
}

/**
 * Fenced blocks, with the exemption marker that may precede one.
 *
 * Both fence characters and any opening length are handled, because a document
 * that quotes a fenced block has to open with a longer run than the one it
 * quotes.
 */
function fencedBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let open = null;

  for (let i = 0; i < lines.length; i += 1) {
    const fence = /^(\s*)(`{3,}|~{3,})[ \t]*(\S*)/.exec(lines[i]);

    if (open === null) {
      if (!fence) continue;
      const marker = EXEMPTION.exec((lines[i - 1] ?? "").trim());
      open = {
        language: fence[3].toLowerCase(),
        char: fence[2][0],
        length: fence[2].length,
        indent: fence[1].length,
        fenceLine: i + 1,
        body: [],
        exemption: marker === null ? null : marker[1].trim(),
      };
      continue;
    }

    if (fence && fence[2][0] === open.char && fence[2].length >= open.length && fence[3] === "") {
      blocks.push(open);
      open = null;
      continue;
    }

    // Strip no more than the fence's own indentation, so a body line indented
    // less than its fence keeps every character it has.
    const strip = Math.min(open.indent, lines[i].length - lines[i].trimStart().length);
    open.body.push(lines[i].slice(strip));
  }

  if (open !== null) blocks.push(open);
  return blocks;
}

// ## Proof, re-run on every invocation, that the rules still fire
//
// Every `MUST_FLAG` sample is a string Windows PowerShell 5.1 really rejects,
// with the message it produced quoted beside it. Every `MUST_NOT_FLAG` sample is
// one it really accepts. A future edit that breaks a rule fails here rather than
// passing every file forever.
const MUST_FLAG = [
  // "The token '&&' is not a valid statement separator in this version."
  ["cd web && npm run validate", "chain-operator"],
  ["git switch main && git pull", "chain-operator"],
  // The same, reached through a subexpression inside a double-quoted string.
  // This is also the positive arm of the quote-carrying control the header
  // describes: it must flag, while the double-quoted samples in MUST_NOT_FLAG
  // must not. Holding the quote constant across arms that come back differing
  // is what a control written without one cannot do.
  ['$x = "$(git status && git log)"', "chain-operator"],
  // "The token '||' is not a valid statement separator in this version."
  ["npm ci || npm install", "chain-operator"],
  // "Missing expression after unary operator '--'." on the following line.
  ["gh run list --workflow=pages.yml \\\n  --json headSha,status", "line-continuation"],
  // "The '<' operator is reserved for future use." -- a heredoc, twice over.
  ["python - <<'PY'\nprint(1)\nPY", "reserved-angle"],
  // The same message, from input redirection. The spaces are what keep this out
  // of the placeholder rule.
  ["sort < in.txt > out.txt", "reserved-angle"],
  // "The string is missing the terminator: '."
  ["echo 'oops", "unterminated-string"],
  // "The string is missing the terminator: '@."
  ["$x = @'\nabc", "unterminated-string"],
];

const MUST_NOT_FLAG = [
  // The load-bearing case. Raw, this is a parse error; substituted, it is not,
  // and every documented placeholder in the repository looks like it.
  "node a.mjs --claims <bundle> --json",
  "gh issue view <n> --repo <owner>/<repo> --json state,stateReason",
  "gh api repos/<owner>/<repo>/issues/<n>/comments --paginate",
  "az deployment create --name <deployment-name> --template-file main.bicep",
  // A placeholder with spaces inside it, which the corpus really contains.
  "gh auth login --with-token <token with issues:write>",
  // `&&` that is content rather than a separator.
  "Write-Output 'a && b'",
  'Write-Output "a && b"',
  "# cd web && npm run validate",
  "$x = @'\na && b\n'@",
  // The continuation shape that PowerShell does parse, measured: inside a
  // double-quoted subexpression. Flagging it would be a false positive.
  "C=\"$(gh run list --limit 1 \\\n  --json headSha --jq '.[0].headSha')\"",
  // And the continuation whose next line opens with a bareword, which also
  // parses. It is a runtime defect, not a parse one, so it is not claimed here.
  "npm run test:e2e -- \\\n  e2e/site-a11y.e2e.ts \\\n  e2e/zoom.e2e.ts",
  // A `<` opening a line parses, so an HTML comment quoted in a fence is not a
  // defect -- measured, and the reason rule 3 is anchored the way it is.
  "<!-- modeltree-run: v1 run=<id> claims=N accepted=N -->",
  // Out of scope by construction: the unquoted rev-range family parses clean and
  // fails at runtime. Pinned so a later widening has to be deliberate.
  "git rev-list --count $(git merge-base HEAD refs/remotes/origin/main)..HEAD",
  'git --no-pager diff --stat "$mb...HEAD"',
  // Ordinary PowerShell that must survive every rule above.
  "git rev-parse 'refs/remotes/origin/main^{tree}'",
  "$out = git merge-tree --write-tree $trunk HEAD; $code = $LASTEXITCODE",
  "node x.mjs 2>&1 | Select-Object -Last 5",
  "$rows | Where-Object { $_.count -lt 3 } | Measure-Object",
  'printf "%d" "${#MERGE_SHA}"',
  "<# a block comment #>\nWrite-Output 1",
  "node --test .github/skills/modeltree-gates/scripts/gates.test.mjs",
  "npm.cmd --version; drydock.cmd --version",
];

// The exemption, proved in both directions on one body. Without the marker the
// block must be judged and must fail; with it the block must not be read at all.
// The body is the shape the issue's out-of-scope list names: a `package.json`
// script quoted in prose, which npm runs through its own shell.
const EXEMPTION_SAMPLE = [
  "<!-- shell-parse-exempt: quoted from package.json; npm runs this in sh -->",
  "```bash",
  "npm run validate && astro build",
  "```",
].join("\n");
const EXEMPTION_SAMPLE_UNMARKED = EXEMPTION_SAMPLE.split("\n").slice(1).join("\n");

function judge(body) {
  return scanShell(substitutePlaceholders(body));
}

function selfCheck() {
  const broken = [];

  for (const [sample, rule] of MUST_FLAG) {
    const rules = judge(sample).map((finding) => finding.rule);
    if (!rules.includes(rule)) {
      broken.push(
        `should have been flagged as ${rule} but was not: ${JSON.stringify(sample)}`
          + ` (flagged: ${rules.length === 0 ? "nothing" : rules.join(", ")})`,
      );
    }
  }

  for (const sample of MUST_NOT_FLAG) {
    const rules = judge(sample).map((finding) => finding.rule);
    if (rules.length > 0) {
      broken.push(`should not have been flagged but was ${rules.join(", ")}: ${JSON.stringify(sample)}`);
    }
  }

  const marked = fencedBlocks(EXEMPTION_SAMPLE);
  const unmarked = fencedBlocks(EXEMPTION_SAMPLE_UNMARKED);

  if (marked.length !== 1 || marked[0].exemption !== "quoted from package.json; npm runs this in sh") {
    broken.push("the exemption marker was not read off the line before the fence");
  }
  if (unmarked.length !== 1 || unmarked[0].exemption !== null) {
    broken.push("a block with no marker was read as exempt");
  }
  // The control that makes the exemption a decision rather than a blind spot: the
  // same body, unexempted, must fail.
  if (unmarked.length === 1 && judge(unmarked[0].body.join("\n")).length === 0) {
    broken.push("the exempted sample does not fail when it is not exempted, so the exemption proves nothing");
  }

  if (broken.length > 0) {
    console.error("check-shell-invocations: the detector is unsound, so this run proves nothing.");
    for (const line of broken) console.error(`  ${line}`);
    process.exit(2);
  }
}

function markdownUnder(target) {
  let stats;
  try {
    stats = statSync(target);
  } catch (err) {
    console.error(`check-shell-invocations: cannot read ${target}: ${err.message}`);
    process.exit(2);
  }

  if (stats.isFile()) return target.toLowerCase().endsWith(".md") ? [target] : [];

  const found = [];
  for (const entry of readdirSync(target, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = join(target, entry.name);
    if (entry.isDirectory()) found.push(...markdownUnder(full));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) found.push(full);
  }
  return found;
}

const posix = (path) => path.split(sep).join("/");

if (process.argv.length > 2) {
  console.error(
    "check-shell-invocations: this check takes no arguments, so it cannot be pointed at an "
      + `emptier tree. Unrecognised: ${process.argv.slice(2).join(" ")}`,
  );
  process.exit(2);
}

selfCheck();

const files = COVERED.flatMap((entry) => markdownUnder(join(REPO_ROOT, entry)));

if (files.length === 0) {
  console.error(
    `check-shell-invocations: the covered set (${COVERED.join(", ")}) holds no markdown. `
      + "A scan of nothing is not a pass.",
  );
  process.exit(2);
}

const findings = [];
const exempted = [];
let scannedBlocks = 0;

for (const file of files) {
  const path = posix(relative(REPO_ROOT, file));

  for (const block of fencedBlocks(readFileSync(file, "utf8"))) {
    if (!COVERED_LANGUAGES.has(block.language)) continue;

    if (block.exemption !== null) {
      if (block.exemption === "") {
        findings.push({
          path,
          line: block.fenceLine,
          rule: "unreasoned-exemption",
          evidence: "<!-- shell-parse-exempt: -->",
        });
        continue;
      }
      exempted.push({ path, line: block.fenceLine, reason: block.exemption });
      continue;
    }

    scannedBlocks += 1;
    for (const finding of judge(block.body.join("\n"))) {
      findings.push({
        path,
        line: block.fenceLine + finding.line,
        rule: finding.rule,
        evidence: finding.evidence,
      });
    }
  }
}

if (scannedBlocks === 0) {
  console.error(
    "check-shell-invocations: the covered documents hold no fenced "
      + `${[...COVERED_LANGUAGES].join("/")} block that was actually read. A scan of nothing is not a pass.`,
  );
  process.exit(2);
}

// Printed on every run, passing runs included: a block that was skipped is not a
// block that was read and found clean (ADR 0018).
const exemptionReport = () => {
  if (exempted.length === 0) return "no block claimed an exemption";
  return `${exempted.length} block(s) exempted and therefore NOT read:\n`
    + exempted.map(({ path, line, reason }) => `  ${path}:${line}: ${reason}`).join("\n");
};

if (findings.length > 0) {
  console.error(
    "check-shell-invocations: an agent-facing document prescribes a shell block that Windows "
      + "PowerShell 5.1 cannot parse. A parse error discards the whole block, not the one line.\n",
  );
  for (const { path, line, rule, evidence } of findings) {
    console.error(`  ${path}:${line}: [${rule}] ${evidence}`);
  }
  const rules = [...new Set(findings.map((finding) => finding.rule))];
  for (const rule of rules) {
    if (rule === "unreasoned-exemption") {
      console.error(
        "\n[unreasoned-exemption] An exemption must say why, or the next reader cannot audit it: "
          + "<!-- shell-parse-exempt: quoted from package.json; npm runs this in sh -->",
      );
      continue;
    }
    console.error(`\n[${rule}] ${REMEDY[rule]}`);
  }
  console.error(`\n${exemptionReport()}`);
  process.exit(1);
}

console.log(
  `check-shell-invocations: OK -- ${scannedBlocks} fenced ${[...COVERED_LANGUAGES].join("/")} `
    + `block(s) across ${files.length} markdown file(s) in ${COVERED.join(", ")} carry no construct `
    + "this check recognises as a Windows PowerShell 5.1 parse error.",
);
console.log(`check-shell-invocations: ${exemptionReport()}`);
