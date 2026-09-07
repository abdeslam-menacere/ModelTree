// Start-tag scanning for the built HTML that `asset-budget.mjs` measures.
//
// -- The defect this exists for (#1081) --
//
// The critical-path scanner found a route's stylesheets with one pattern:
//
//   /<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g
//
// which demands that `rel` appear BEFORE `href` and that both be DOUBLE quoted.
// Four spellings a browser treats identically were therefore invisible to it:
//
//   <link href="/_astro/a.css" rel="stylesheet">   href first
//   <link rel='stylesheet' href='/_astro/a.css'>   single quotes
//   <link rel=stylesheet href=/_astro/a.css>       unquoted
//   <LINK REL="STYLESHEET" HREF="/_astro/a.css">   uppercase
//
// A miss costs bytes rather than raising an error, so the measurement comes out
// SMALLER and a budget passes when it should fail. It takes the fonts with it:
// `fontsOf` is driven by the stylesheet set, so one missed <link> removes two
// categories from the route total.
//
// The scenario that survives every mitigation is a NEW route. `asset-drift.mjs`
// compares a measurement against a recorded baseline, so it detects change and
// never wrongness; a stylesheet missed at the moment a route's budget is first
// recorded makes that baseline wrong from birth, leaves the drift delta at zero
// forever, and nothing anywhere reports it.
//
// -- Why a tokenizer and not a better pattern --
//
// The root cause is matching whole elements with a pattern, so a wider pattern
// would be the same defect with a later expiry date: `rel` and `href` are two
// attributes of one element and their ORDER carries no meaning, which is not a
// property any single regex over the raw text can express. What follows walks
// the document once and reads each start tag's attributes into a map, so order
// stops existing as a concept and every quoting form is handled where quoting is
// actually decided.
//
// -- Why not jsdom, which is already a devDependency here --
//
// Weighed explicitly rather than skipped, because the issue asked for that. The
// repository has already run this experiment and reverted it:
// `src/components/brand-mark.test.ts` records a DOM parser being tried in a
// node-environment suite and backed out because "that import measurably slowed
// the whole worker pool: two unrelated `userEvent` tests elsewhere began timing
// out at 5000ms in the full run and passed in isolation." `asset-budget.mjs` is
// imported by `tests/build/asset-budgets.test.ts`, which is exactly such a
// suite, so adopting jsdom here would re-run the reverted experiment inside the
// worker pool it was reverted for.
//
// That precedent is a fact about a previous run, so it was re-measured on this
// branch over the real 185-page build (12.6 MiB of HTML). Both arms answered the
// same question -- which stylesheet hrefs does this page carry -- and agreed on
// all 185 pages, which is what makes the timings comparable at all:
//
//   tokenizer     68 ms
//   jsdom       5314 ms   (78x, plus 1440 ms warm / 13272 ms cold just to import)
//
// jsdom is the more correct instrument in general and it is not being called
// wrong. It is answering a much larger question -- build a full DOM, a CSSOM and
// a selector engine -- when the question here is which start tags carry which
// attributes. Its import cost alone exceeds the entire scan by an order of
// magnitude, and that cost is paid on every run of a suite the repository has
// already seen time out under it.
//
// The 185/185 agreement is also the correctness control this module leans on:
// the cheap instrument was checked against the expensive one on every page of a
// real build, rather than only against fixtures written by the same hand that
// wrote the scanner.
//
// The limit of that choice, stated rather than glossed: this is a tokenizer, not
// a parser. It does not build a tree, so it cannot answer anything about nesting
// or implied elements, and it does not resolve character references -- attribute
// values arrive exactly as written (see `readAttributes` below). If a future
// question needs a tree, jsdom is the right answer and this module is the wrong
// one.

/** HTML whitespace, per the spec's definition (not `\s`, which is wider). */
function isSpace(code) {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
}

function isAsciiAlpha(code) {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

/**
 * Elements whose content is raw text rather than markup.
 *
 * A `<link>` spelled inside a JavaScript string literal is not a stylesheet the
 * page loads, and the old pattern counted it because it read the file as one
 * flat string. Skipping these elements' content is the half of the fix that
 * makes the scan strictly *less* credulous, not more.
 */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);

/**
 * Attribute name/value pairs of one start tag, plus where the tag ended.
 *
 * Names are lower-cased; a repeated name keeps its FIRST value, which is what
 * an HTML parser does with a duplicate attribute. A valueless attribute maps to
 * the empty string, so presence and emptiness stay distinguishable from absence.
 *
 * @param {string} html
 * @param {number} start  index just past the tag name
 * @returns {{ attrs: Map<string, string>, end: number }}
 */
function readAttributes(html, start) {
  const attrs = new Map();
  const n = html.length;
  let i = start;

  while (i < n) {
    while (i < n && isSpace(html.charCodeAt(i))) i += 1;
    if (i >= n) break;

    const ch = html[i];
    if (ch === '>') {
      i += 1;
      break;
    }
    // The `/` of a self-closing tag, or a stray one between attributes. Either
    // way it is not part of a name, so it is stepped over rather than read.
    if (ch === '/') {
      i += 1;
      continue;
    }

    let nameEnd = i;
    while (nameEnd < n) {
      const code = html.charCodeAt(nameEnd);
      const char = html[nameEnd];
      if (isSpace(code) || char === '=' || char === '>' || char === '/') break;
      nameEnd += 1;
    }
    const name = html.slice(i, nameEnd).toLowerCase();
    i = nameEnd;

    while (i < n && isSpace(html.charCodeAt(i))) i += 1;

    let value = '';
    if (html[i] === '=') {
      i += 1;
      while (i < n && isSpace(html.charCodeAt(i))) i += 1;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, i + 1);
        value = close < 0 ? html.slice(i + 1) : html.slice(i + 1, close);
        i = close < 0 ? n : close + 1;
      } else {
        let valueEnd = i;
        // An unquoted value ends at whitespace or `>` and at nothing else --
        // notably not at `/`, which is why `href=/a.css/>` yields `/a.css/`.
        // That is what a browser does with it too.
        while (valueEnd < n && !isSpace(html.charCodeAt(valueEnd)) && html[valueEnd] !== '>') {
          valueEnd += 1;
        }
        value = html.slice(i, valueEnd);
        i = valueEnd;
      }
    }

    if (name !== '' && !attrs.has(name)) attrs.set(name, value);
  }

  return { attrs, end: i };
}

/**
 * Index of `</name` at or after `from`, case-insensitively; -1 when absent.
 *
 * Only the candidate name is lower-cased. Lower-casing the whole document here
 * is correct but re-scans it once per raw-text element, and it measured 295 ms
 * across the 185-page build against 68 ms for this form.
 */
function indexOfCloseTag(html, name, from) {
  const n = html.length;
  let i = from;
  while (i < n) {
    const lt = html.indexOf('</', i);
    if (lt < 0) return -1;
    const nameEnd = lt + 2 + name.length;
    if (html.slice(lt + 2, nameEnd).toLowerCase() === name) {
      const after = html[nameEnd];
      if (after === undefined || isSpace(after.charCodeAt(0)) || after === '>' || after === '/') {
        return lt;
      }
    }
    i = lt + 2;
  }
  return -1;
}

/**
 * Every start tag in a document, in order, with its attributes.
 *
 * Comments, doctypes, processing instructions and end tags are skipped, as is
 * the content of a raw-text element. Nothing here builds a tree: a caller gets
 * a flat stream of tags, which is all the byte accounting needs.
 *
 * @param {string} html
 * @returns {Generator<{ name: string, attrs: Map<string, string> }>}
 */
export function* startTags(html) {
  const n = html.length;
  let i = 0;

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) return;

    const next = html[lt + 1];

    if (next === '!') {
      if (html.startsWith('<!--', lt)) {
        const end = html.indexOf('-->', lt + 4);
        i = end < 0 ? n : end + 3;
      } else {
        const end = html.indexOf('>', lt + 2);
        i = end < 0 ? n : end + 1;
      }
      continue;
    }

    if (next === '/' || next === '?') {
      const end = html.indexOf('>', lt + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }

    if (next === undefined || !isAsciiAlpha(html.charCodeAt(lt + 1))) {
      // A bare `<` in text. Not a tag; step past it rather than resynchronising
      // on the next `>`, which would swallow whatever follows.
      i = lt + 1;
      continue;
    }

    let nameEnd = lt + 1;
    while (nameEnd < n) {
      const code = html.charCodeAt(nameEnd);
      if (isSpace(code) || html[nameEnd] === '/' || html[nameEnd] === '>') break;
      nameEnd += 1;
    }
    const name = html.slice(lt + 1, nameEnd).toLowerCase();
    const { attrs, end } = readAttributes(html, nameEnd);

    yield { name, attrs };
    i = end;

    if (RAW_TEXT_ELEMENTS.has(name)) {
      const close = indexOfCloseTag(html, name, i);
      // An unterminated raw-text element skips NOTHING rather than the rest of
      // the document. Both readings are wrong, and this one is wrong in the
      // recoverable direction: over-counting a stray tag is visible, whereas
      // dropping every asset after an unclosed <script> is the silent
      // under-count this issue exists to remove.
      if (close >= 0) i = close;
    }
  }
}

/**
 * Whether a `rel` value marks a render-blocking stylesheet.
 *
 * `rel` is a space-separated, case-insensitive token list, so this is a token
 * test and never a string comparison: `rel="stylesheet"` and
 * `rel="  StyleSheet "` are the same link, while `preload`, `modulepreload`,
 * `icon` and `manifest` share no token with it and stay out. A `rel="preload"`
 * pointing at a `.css` file is a hint to fetch early, not a stylesheet the page
 * renders against, and counting it would charge the route for the same bytes
 * twice once the real link appears.
 *
 * `alternate stylesheet` is excluded for the same reason it is not counted by a
 * browser's first paint: an alternate stylesheet is not applied unless a user
 * selects it. That exclusion arrives WITH token matching rather than being an
 * extra opinion -- the old pattern could not see the tag at all, so this is the
 * one new admission decision token matching creates, and it is decided here
 * rather than left implicit.
 *
 * @param {string | undefined} rel
 * @returns {boolean}
 */
export function isStylesheetRel(rel) {
  if (typeof rel !== 'string') return false;
  const tokens = new Set(rel.toLowerCase().split(/[\t\n\f\r ]+/).filter(Boolean));
  return tokens.has('stylesheet') && !tokens.has('alternate');
}

/**
 * The stylesheet `href` one start tag contributes, or `null` for every tag that
 * is not a render-blocking stylesheet link.
 *
 * This is THE admission rule, and it is a function so that exactly one of it
 * exists. The first version of this change shipped two: this rule, and an inline
 * re-statement of it in the budget scanner's own tag loop. A rule with two
 * copies is pinned by a test in one copy and free in the other -- deleting the
 * `rel` test from the scanner's copy moved no route total and reddened no test,
 * because every fixture route linked a genuine stylesheet and so could not tell
 * the permissive rule from the correct one. That is the same one-rule-two-copies
 * divergence this change exists to remove, so the scanner asks this question
 * rather than answering it a second time.
 *
 * `media` is deliberately NOT consulted. A `media="print"` stylesheet is
 * arguably not on the critical path, but that is a question about how a found
 * stylesheet should be CLASSIFIED, and this issue is about whether it is found
 * at all. Changing classification would move recorded route totals as a side
 * effect of a discovery fix, so it stays as it was and belongs on its own issue.
 *
 * @param {{ name: string, attrs: Map<string, string> }} tag  one `startTags` yield
 * @returns {string | null}
 */
export function stylesheetHrefOf(tag) {
  if (tag.name !== 'link') return null;
  if (!isStylesheetRel(tag.attrs.get('rel'))) return null;
  return tag.attrs.get('href') || null;
}

/**
 * The `href` of every render-blocking stylesheet the document links.
 *
 * @param {string} html
 * @returns {string[]}
 */
export function stylesheetHrefs(html) {
  const out = [];
  for (const tag of startTags(html)) {
    const href = stylesheetHrefOf(tag);
    if (href) out.push(href);
  }
  return out;
}
