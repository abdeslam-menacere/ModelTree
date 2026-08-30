import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dataset } from './dataset';

// Binds the `### Data notes` bullets in `web/README.md` to the records they
// describe (abdeslam-menacere/ModelTree#489).
//
// The failure this closes: a bullet claimed Gemini 3.7 Flash "is excluded" for
// want of a day-precision date while `releases.json` had carried
// `google-gemini-3-7-flash` with `releaseDate: "2026-08-13"` for two days. Every
// gate was green throughout, because the gates are diff-scoped -- a change that
// falsifies a sentence in a file it does not touch is structurally invisible to
// them -- and because no gate reads prose. That specific contradiction was
// corrected by hand before this test existed; the mechanism that would have
// caught it is what this file adds.
//
// -- WHAT THIS DOES NOT DO, stated first because it is the load-bearing limit --
//
// It does not read English. Nothing here infers a claim from a sentence, and
// nothing here should ever try: a bullet is checkable exactly when its author
// attached an anchor saying what it asserts, and a bullet with no anchor is
// outside this test's scope by design rather than by oversight. That is why the
// judged set below exists -- the decision "this bullet asserts nothing about a
// record" is made by a person or a reviewing agent and recorded, not guessed by
// a regex at run time.
//
// The consequence, worth naming plainly: an anchor can be wrong about what its
// own bullet says. Anchoring `status = current` beside a sentence about
// parameter counts would pass. This test binds the anchor to the dataset; it is
// review that binds the anchor to the prose. It narrows the gap that produced
// #489 from "prose versus data, unchecked" to "anchor versus prose, reviewed",
// and claiming more than that would be the same overstatement the issue is
// about.
//
// A second limit, from the vocabulary rather than the design: a claim quantified
// over a set ("on every Meta release") is bound by naming each member that
// exists today. Those anchors do not reach a record added tomorrow. Where a
// quantified claim could not be bound honestly at all, that is recorded beside
// the judged set rather than papered over.

const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8').replace(
  /\r\n/g,
  '\n',
);

const SECTION_HEADING = '### Data notes';
const ANCHOR_PATTERN = /<!--\s*claim:\s*([\s\S]*?)\s*-->/g;

/**
 * The bullets that deliberately carry no anchor, with the reason each one is
 * outside the mechanism. This is a judged set, not a computed one: a bullet
 * lands here because someone decided it states no checkable fact about a named
 * record, and the test pins that decision so the next bullet added to the
 * section has to be classified rather than quietly ignored.
 *
 * It doubles as this file's differential control. A parser that silently
 * matched nothing would produce an empty unanchored set, which cannot equal a
 * non-empty pin -- so a dead instrument reddens here instead of reporting a
 * confident green.
 */
const DELIBERATELY_UNANCHORED: ReadonlyArray<{ title: string; because: string }> = [
  {
    title: 'Lifecycle mapping.',
    because:
      'It maps vendor vocabulary ("Retired", "Legacy models", "History") onto schema ' +
      'values. It is the rule records are read under, and names no record.',
  },
  {
    title: 'Conditional fit guidance is seeded, not exhaustive.',
    because:
      'Its record-level claims -- the count and the per-release breakdown -- are ' +
      'explicitly delegated to `model-fit.test.ts`, which reads the live seed. ' +
      'Anchoring them here would create a second place to keep true, which is the ' +
      'defect class this repository calls "documentation asserts a value the code ' +
      'owns". The bullet points at that test on purpose.',
  },
  {
    title: 'DeepSeek dates come from repository publication, not from an announcement.',
    because:
      'It describes where the recorded dates came from and how strong that evidence ' +
      'is, which is a provenance judgement about sources. It states no field value, ' +
      'and the strength of a date is not a thing the dataset records.',
  },
];

// Recorded, not asserted, because the honest response is to report it rather
// than to fix it here (#489 forbids both changing data to make prose true and
// rewriting prose to match data):
//
// "Llama licences are open-weight, not open source" ends "so `osiApproved` is
// `false` on every Meta release". Its eight Llama releases are anchored and all
// hold. The quantifier is not anchored, because it does not hold as written:
// `meta-muse-spark`, `meta-muse-spark-1-1`, `meta-muse-image`, and
// `meta-muse-video` record no `license` object at all, so `osiApproved` is
// absent on them rather than `false`. "No Meta release is OSI-approved" would be
// true; "osiApproved is false on every Meta release" is not, and this repository
// is emphatic elsewhere that an omitted field and a recorded `false` are
// different statements. Left unbound and reported.
//
// "Claude 4.5 lifecycle wording differs between two cited pages" ends "no
// retirement date is asserted for either model". Only one of the two has a
// record here -- `anthropic-claude-haiku-4-5`; `claude-sonnet-4-5-20250929` is
// an API identifier in a vendor deprecations table with no release in this
// dataset. The half that can be named is anchored. The half that cannot is not,
// because there is no id to point at, which is a limit of the dataset and not a
// disagreement with it.

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

interface Bullet {
  readonly title: string;
  readonly anchors: readonly string[];
}

interface Finding {
  readonly bullet: string;
  readonly claim: string;
  readonly problem: string;
  readonly datasetSays: unknown;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      deepEqual(leftKeys, rightKeys) && leftKeys.every((key) => deepEqual(left[key], right[key]))
    );
  }
  return false;
}

/**
 * Walks a dotted path, distinguishing "absent" from "present and holding
 * something falsy". JSON has no `undefined`, so an own-property walk is exact:
 * it is what lets `omits` mean the field is not recorded, rather than the much
 * weaker "the field does not read as truthy".
 */
function resolvePath(
  record: Record<string, unknown>,
  path: string,
): { present: true; value: unknown } | { present: false; missingAt: string } {
  const segments = path.split('.');
  let current: unknown = record;
  const walked: string[] = [];

  for (const segment of segments) {
    walked.push(segment);
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return { present: false, missingAt: walked.join('.') };
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return { present: false, missingAt: walked.join('.') };
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return { present: true, value: current };
}

function dataNotesSection(markdown: string): string {
  const start = markdown.indexOf(SECTION_HEADING);
  if (start < 0) {
    throw new Error(`"${SECTION_HEADING}" is missing; the anchors have nothing to be read from`);
  }
  const rest = markdown.slice(start + SECTION_HEADING.length);
  const next = rest.search(/\n#{2,3} /);
  return next < 0 ? rest : rest.slice(0, next);
}

/**
 * Splits the section into bullets and pulls each one's anchors out. A bullet is
 * identified by its bold lead-in, which every bullet in the section carries and
 * which is what the judged set above is keyed on; a bullet without one is
 * reported rather than skipped, because an unidentifiable bullet cannot be
 * classified and silently dropping it would reopen the hole.
 */
function parseBullets(section: string): { bullets: Bullet[]; malformed: string[] } {
  const lines = section.split('\n');
  const groups: string[][] = [];

  for (const line of lines) {
    if (/^- /.test(line)) {
      groups.push([line]);
    } else if (groups.length > 0 && /^\s+\S/.test(line)) {
      groups[groups.length - 1].push(line);
    }
  }

  const bullets: Bullet[] = [];
  const malformed: string[] = [];

  for (const group of groups) {
    const text = group.join('\n');
    const anchors = [...text.matchAll(ANCHOR_PATTERN)].map((match) => match[1]);
    const prose = text.replace(ANCHOR_PATTERN, ' ').replace(/\s+/g, ' ').trim();
    const title = prose.match(/^-\s+\*\*(.+?)\*\*/)?.[1];
    if (!title) {
      malformed.push(prose.slice(0, 120));
      continue;
    }
    bullets.push({ title, anchors });
  }

  return { bullets, malformed };
}

const KINDS = ['records', 'omits', 'lists', 'absent', 'none-matching'] as const;
type Kind = (typeof KINDS)[number];

const collections = dataset as unknown as Record<string, unknown>;

function collectionNames(): string[] {
  return Object.keys(collections)
    .filter((key) => Array.isArray(collections[key]))
    .sort();
}

/**
 * Checks one anchor against the composed dataset. Returns the reasons it does
 * not hold, each naming what the dataset actually says, or an empty list.
 *
 * The five kinds and what each asserts:
 *
 * - `records`  -- the record exists and holds `field` (a dotted path) deep-equal
 *                 to `value`.
 * - `omits`    -- the record exists and does not record `field` at all.
 * - `lists`    -- the record exists, `field` is an array, and `value` is in it.
 * - `absent`   -- no record in the collection carries that id.
 * - `none-matching` -- no record in the collection matches every field/value
 *                 pair in `where`. This is how an absence is stated about
 *                 records that are not keyed by the id being discussed, such as
 *                 "no shutdown date is asserted", where a shutdown date would be
 *                 a `retired` or `deprecated` release event naming the release.
 *
 * `records`, `omits`, and `lists` presuppose the record exists, so an anchor
 * naming an id the dataset does not carry fails on all three. `absent` is the
 * deliberate opposite and is kept as its own kind rather than folded into
 * `none-matching` so that a reader of the anchor can see the author meant it.
 */
function checkClaim(claim: Record<string, unknown>): string[] | { problems: string[]; actual: unknown } {
  const kind = claim.kind as Kind;
  const entity = claim.entity as string;

  const records = collections[entity];
  if (!Array.isArray(records)) {
    return {
      problems: [`names the collection "${entity}", which the composed dataset does not carry`],
      actual: { availableCollections: collectionNames() },
    };
  }
  const rows = records as Array<Record<string, unknown>>;

  if (kind === 'none-matching') {
    const where = claim.where as Record<string, unknown>;
    const matches = rows.filter((row) =>
      Object.entries(where).every(([field, value]) => {
        const resolved = resolvePath(row, field);
        return resolved.present && deepEqual(resolved.value, value);
      }),
    );
    if (matches.length === 0) return { problems: [], actual: null };
    return {
      problems: [`expected no ${entity} record matching ${JSON.stringify(where)}, but found ${matches.length}`],
      actual: matches.map((row) => row.id ?? row),
    };
  }

  const id = claim.id as string;
  const record = rows.find((row) => row.id === id);

  if (kind === 'absent') {
    if (!record) return { problems: [], actual: null };
    return {
      problems: [`claims ${entity} carries no record "${id}", but one exists`],
      actual: record,
    };
  }

  if (!record) {
    return {
      problems: [`names ${entity} record "${id}", which does not exist`],
      actual: { existingIds: rows.length, sample: rows.slice(0, 3).map((row) => row.id) },
    };
  }

  const field = claim.field as string;
  const resolved = resolvePath(record, field);

  if (kind === 'omits') {
    if (!resolved.present) return { problems: [], actual: null };
    return {
      problems: [`claims ${entity} "${id}" omits "${field}", but it is recorded`],
      actual: resolved.value,
    };
  }

  if (!resolved.present) {
    return {
      problems: [`reads "${field}" on ${entity} "${id}", which records nothing at "${resolved.missingAt}"`],
      actual: undefined,
    };
  }

  if (kind === 'lists') {
    if (!Array.isArray(resolved.value)) {
      return {
        problems: [`expects "${field}" on ${entity} "${id}" to be a list`],
        actual: resolved.value,
      };
    }
    if (resolved.value.some((item) => deepEqual(item, claim.value))) {
      return { problems: [], actual: null };
    }
    return {
      problems: [`expects "${field}" on ${entity} "${id}" to list ${JSON.stringify(claim.value)}`],
      actual: resolved.value,
    };
  }

  if (deepEqual(resolved.value, claim.value)) return { problems: [], actual: null };
  return {
    problems: [
      `expects "${field}" on ${entity} "${id}" to be ${JSON.stringify(claim.value)}`,
    ],
    actual: resolved.value,
  };
}

const REQUIRED_KEYS: Record<Kind, string[]> = {
  records: ['entity', 'id', 'field', 'value'],
  omits: ['entity', 'id', 'field'],
  lists: ['entity', 'id', 'field', 'value'],
  absent: ['entity', 'id'],
  'none-matching': ['entity', 'where'],
};

/**
 * The whole check, as a pure function of markdown text and nothing else. Taking
 * the markdown as an argument rather than reading the file inside is what lets
 * the controls below run the real evaluator over synthetic sections: a negative
 * control that exercised a different code path would prove nothing about this
 * one.
 */
function evaluateDataNotes(markdown: string): Finding[] {
  const { bullets, malformed } = parseBullets(dataNotesSection(markdown));
  const findings: Finding[] = [];

  for (const prose of malformed) {
    findings.push({
      bullet: prose,
      claim: '(none)',
      problem: 'bullet has no bold lead-in, so it cannot be identified or classified',
      datasetSays: null,
    });
  }

  for (const bullet of bullets) {
    for (const anchor of bullet.anchors) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(anchor);
      } catch (error) {
        findings.push({
          bullet: bullet.title,
          claim: anchor,
          problem: `anchor is not valid JSON: ${(error as Error).message}`,
          datasetSays: null,
        });
        continue;
      }

      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        findings.push({
          bullet: bullet.title,
          claim: anchor,
          problem: 'anchor is not a JSON object',
          datasetSays: null,
        });
        continue;
      }

      const claim = parsed as Record<string, unknown>;
      const kind = claim.kind;
      if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) {
        findings.push({
          bullet: bullet.title,
          claim: anchor,
          problem: `anchor kind ${JSON.stringify(kind)} is not one of ${KINDS.join(', ')}`,
          datasetSays: null,
        });
        continue;
      }

      const missing = REQUIRED_KEYS[kind as Kind].filter(
        (key) => !Object.prototype.hasOwnProperty.call(claim, key),
      );
      if (missing.length > 0) {
        findings.push({
          bullet: bullet.title,
          claim: anchor,
          problem: `a "${kind}" anchor needs ${missing.join(', ')}`,
          datasetSays: null,
        });
        continue;
      }

      const result = checkClaim(claim) as { problems: string[]; actual: unknown };
      for (const problem of result.problems) {
        findings.push({
          bullet: bullet.title,
          claim: anchor,
          problem,
          datasetSays: result.actual,
        });
      }
    }
  }

  return findings;
}

function liveBullets(): Bullet[] {
  return parseBullets(dataNotesSection(readme)).bullets;
}

/** Builds a synthetic `### Data notes` section so the controls exercise the real evaluator. */
function fixture(...bullets: string[]): string {
  return ['# Fixture', '', SECTION_HEADING, '', ...bullets, '', '## Something else', ''].join('\n');
}

function anchor(claim: Json): string {
  return `  <!-- claim: ${JSON.stringify(claim)} -->`;
}

describe('README data notes claims', () => {
  it('finds a populated section with anchors to read', () => {
    const bullets = liveBullets();
    expect(bullets.length).toBeGreaterThan(0);

    const anchored = bullets.filter((bullet) => bullet.anchors.length > 0);
    expect(anchored.length).toBeGreaterThan(0);
    expect(bullets.every((bullet) => bullet.title.length > 0)).toBe(true);

    // Every anchor parses and names a kind the evaluator implements. A section
    // whose anchors all failed to parse would still satisfy the counts above,
    // so this is asserted separately.
    const kinds = new Set<string>();
    for (const bullet of anchored) {
      for (const raw of bullet.anchors) {
        const claim = JSON.parse(raw) as { kind: string };
        expect(KINDS).toContain(claim.kind);
        kinds.add(claim.kind);
      }
    }
    expect(kinds.size).toBeGreaterThan(1);
  });

  it('holds every anchored claim against the composed dataset', () => {
    expect(evaluateDataNotes(readme)).toEqual([]);
  });

  it('pins which bullets are deliberately left unanchored', () => {
    const unanchored = liveBullets()
      .filter((bullet) => bullet.anchors.length === 0)
      .map((bullet) => bullet.title);

    // Set equality in both directions. A new prose bullet appears here and must
    // be judged; a pinned bullet that gains anchors must be removed from the
    // pin. Either way the decision is made deliberately rather than defaulting.
    expect(unanchored.sort()).toEqual(DELIBERATELY_UNANCHORED.map(({ title }) => title).sort());
    expect(DELIBERATELY_UNANCHORED.every(({ because }) => because.length > 40)).toBe(true);
  });

  // Acceptance criterion: a bullet that judges, explains, or states policy is
  // allowed to stay unanchored and must pass. The positive control in the same
  // run is the anchored bullet beside it -- if the evaluator were inert, both
  // would report nothing and the pass would mean nothing, so the true anchor
  // proves the instrument is live and the following tests prove it can fail.
  it('passes a prose-only bullet, alongside an anchored one that is checked', () => {
    const proseOnly = '- **A judgement.** This explains a choice and names no record at all.';
    const anchored = [
      '- **A checked claim.** The platform date is recorded.',
      anchor({
        kind: 'records',
        entity: 'releases',
        id: 'google-gemini-3-7-flash',
        field: 'releaseDate',
        value: '2026-08-13',
      }),
    ].join('\n');

    expect(evaluateDataNotes(fixture(proseOnly))).toEqual([]);
    expect(evaluateDataNotes(fixture(proseOnly, anchored))).toEqual([]);

    const { bullets } = parseBullets(dataNotesSection(fixture(proseOnly, anchored)));
    expect(bullets.map(({ title, anchors }) => [title, anchors.length])).toEqual([
      ['A judgement.', 0],
      ['A checked claim.', 1],
    ]);
  });

  it('fails an anchor naming an entity id that does not exist', () => {
    const findings = evaluateDataNotes(
      fixture(
        '- **An invented record.** This names a release the dataset does not carry.',
        anchor({
          kind: 'records',
          entity: 'releases',
          id: 'google-gemini-9-9-flash',
          field: 'releaseDate',
          value: '2026-08-13',
        }),
      ),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0].bullet).toBe('An invented record.');
    expect(findings[0].problem).toBe(
      'names releases record "google-gemini-9-9-flash", which does not exist',
    );
  });

  it('fails an anchored value the dataset contradicts, and reports what it holds', () => {
    const findings = evaluateDataNotes(
      fixture(
        '- **A falsified date.** The platform date is recorded.',
        anchor({
          kind: 'records',
          entity: 'releases',
          id: 'google-gemini-3-7-flash',
          field: 'releaseDate',
          value: '2026-08-14',
        }),
      ),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0].problem).toBe(
      'expects "releaseDate" on releases "google-gemini-3-7-flash" to be "2026-08-14"',
    );
    expect(findings[0].datasetSays).toBe('2026-08-13');
  });

  it('fails each remaining kind when the dataset disagrees', () => {
    const cases: ReadonlyArray<{ label: string; claim: Json; problem: string; says: unknown }> = [
      {
        label: 'absent that exists',
        claim: { kind: 'absent', entity: 'releases', id: 'google-gemini-3-7-flash' },
        problem: 'claims releases carries no record "google-gemini-3-7-flash", but one exists',
        says: undefined,
      },
      {
        label: 'omits a field that is recorded',
        claim: {
          kind: 'omits',
          entity: 'releases',
          id: 'google-gemini-3-7-flash',
          field: 'releaseDate',
        },
        problem: 'claims releases "google-gemini-3-7-flash" omits "releaseDate", but it is recorded',
        says: '2026-08-13',
      },
      {
        label: 'lists a value the array does not hold',
        claim: {
          kind: 'lists',
          entity: 'releases',
          id: 'google-gemini-2-5-pro',
          field: 'siblingIds',
          value: 'meta-llama-4-scout',
        },
        problem: 'expects "siblingIds" on releases "google-gemini-2-5-pro" to list "meta-llama-4-scout"',
        says: ['google-gemini-2-5-flash'],
      },
      {
        label: 'none-matching when a record matches',
        claim: {
          kind: 'none-matching',
          entity: 'releases',
          where: { id: 'google-gemini-3-7-flash', status: 'current' },
        },
        problem:
          'expected no releases record matching {"id":"google-gemini-3-7-flash","status":"current"}, but found 1',
        says: ['google-gemini-3-7-flash'],
      },
      {
        label: 'a dotted path the record does not reach',
        claim: {
          kind: 'records',
          entity: 'releases',
          id: 'xai-grok-4-6',
          field: 'license.osiApproved',
          value: false,
        },
        problem:
          'reads "license.osiApproved" on releases "xai-grok-4-6", which records nothing at "license"',
        says: undefined,
      },
    ];

    for (const { label, claim, problem, says } of cases) {
      const findings = evaluateDataNotes(
        fixture(`- **${label}.** A bullet under test.`, anchor(claim)),
      );
      expect({ label, count: findings.length }).toEqual({ label, count: 1 });
      expect({ label, problem: findings[0].problem }).toEqual({ label, problem });
      if (says !== undefined) {
        expect({ label, says: findings[0].datasetSays }).toEqual({ label, says });
      }
    }
  });

  it('refuses an anchor it cannot read rather than skipping it', () => {
    const cases: ReadonlyArray<{ label: string; raw: string; problem: string }> = [
      {
        label: 'malformed JSON',
        raw: '  <!-- claim: {"kind":"records","entity":"releases" -->',
        problem: 'anchor is not valid JSON',
      },
      {
        label: 'unknown kind',
        raw: '  <!-- claim: {"kind":"implies","entity":"releases","id":"xai-grok-4-6"} -->',
        problem: 'anchor kind "implies" is not one of records, omits, lists, absent, none-matching',
      },
      {
        label: 'missing keys',
        raw: '  <!-- claim: {"kind":"records","entity":"releases","id":"xai-grok-4-6"} -->',
        problem: 'a "records" anchor needs field, value',
      },
      {
        label: 'unknown collection',
        raw: '  <!-- claim: {"kind":"absent","entity":"rumours","id":"anything"} -->',
        problem: 'names the collection "rumours", which the composed dataset does not carry',
      },
      {
        label: 'not an object',
        raw: '  <!-- claim: ["releases","xai-grok-4-6"] -->',
        problem: 'anchor is not a JSON object',
      },
    ];

    for (const { label, raw, problem } of cases) {
      const findings = evaluateDataNotes(fixture(`- **${label}.** A bullet under test.`, raw));
      expect({ label, count: findings.length }).toEqual({ label, count: 1 });
      expect({ label, ok: findings[0].problem.startsWith(problem) }).toEqual({ label, ok: true });
    }
  });

  it('reports an unidentifiable bullet instead of dropping it', () => {
    const findings = evaluateDataNotes(fixture('- A bullet with no bold lead-in at all.'));
    expect(findings).toHaveLength(1);
    expect(findings[0].problem).toBe(
      'bullet has no bold lead-in, so it cannot be identified or classified',
    );
  });

  it('refuses to read a file with no data notes section', () => {
    expect(() => evaluateDataNotes('# Nothing here\n\nJust prose.\n')).toThrow(
      /"### Data notes" is missing/,
    );
  });

  // A comment holding a nested `-->` closes at the inner one, so the rest of it
  // renders as visible prose on GitHub and the anchors after it stop being
  // anchors. This was a real defect in the first draft of the section's own
  // legend, caught by counting delimiters rather than by reading the file, so it
  // is pinned here rather than left to the next person's eyes.
  it('keeps every comment in the section opened and closed exactly once', () => {
    const section = dataNotesSection(readme);
    const tokens = [...section.matchAll(/<!--|-->/g)].map((match) => match[0]);

    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.filter((token) => token === '<!--')).toHaveLength(tokens.length / 2);
    expect(tokens.filter((_, index) => index % 2 === 0).every((token) => token === '<!--')).toBe(
      true,
    );
    expect(tokens.filter((_, index) => index % 2 === 1).every((token) => token === '-->')).toBe(
      true,
    );

    // The control: the shape above must reject the nesting it exists to catch.
    const nested = [...'<!-- a <!-- b --> c -->'.matchAll(/<!--|-->/g)].map((match) => match[0]);
    expect(nested.filter((_, index) => index % 2 === 0).every((token) => token === '<!--')).toBe(
      false,
    );
  });
});
