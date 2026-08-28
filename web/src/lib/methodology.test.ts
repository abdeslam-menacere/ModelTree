import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  accessType,
  benchmarkResultSchema,
  lifecycleStatus,
  modelCategory,
  sourceSchema,
  usageSourceCategory,
} from '../data/schema';
import {
  FIT_CLASSIFICATIONS,
  FIT_GAP_REASONS,
  findUniversalClaim,
} from '../data/model-fit-rubric';
import { PRIMARY_SOURCE_TYPES } from '../data/validate';
import { accessLabel, categoryLabel, statusLabel } from './format';
import { fitClassificationLabel, fitGapReasonLabel } from './model-fit';
import { usageProvenanceLabel } from './usage-evidence';
import {
  accessTypeGlossary,
  allMethodologyDefinitions,
  BENCHMARK_COMPARISON_FIELDS,
  benchmarkConfigurationFields,
  categoryGlossary,
  deferredToImplementation,
  deriveBenchmarkComparabilityExamples,
  fitClassificationGlossary,
  fitGapReasonGlossary,
  lifecycleStatusGlossary,
  methodologyReferences,
  methodologySections,
  methodologyTableOfContents,
  sourceTypeGlossary,
  unrecordedBenchmarkConfigFields,
  usageProvenanceGlossary,
  type GlossaryEntry,
} from './methodology';
import { dataset } from '../data/dataset';

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function values<T extends string>(entries: GlossaryEntry<T>[]) {
  return entries.map((entry) => entry.value);
}

describe('methodology enum coverage', () => {
  // Each glossary must define exactly the implemented enum values — no missing
  // value (an undocumented badge) and no extra value (a definition for a label
  // that does not exist). Compared in both directions so neither slips through.
  const cases: { name: string; documented: string[]; implemented: readonly string[] }[] = [
    { name: 'lifecycle status', documented: values(lifecycleStatusGlossary), implemented: lifecycleStatus.options },
    { name: 'access type', documented: values(accessTypeGlossary), implemented: accessType.options },
    { name: 'model category', documented: values(categoryGlossary), implemented: modelCategory.options },
    { name: 'source type', documented: values(sourceTypeGlossary), implemented: sourceSchema.shape.type.options },
    { name: 'usage provenance', documented: values(usageProvenanceGlossary), implemented: usageSourceCategory.options },
    { name: 'fit classification', documented: values(fitClassificationGlossary), implemented: FIT_CLASSIFICATIONS },
    { name: 'fit gap reason', documented: values(fitGapReasonGlossary), implemented: FIT_GAP_REASONS },
  ];

  for (const { name, documented, implemented } of cases) {
    it(`documents exactly the implemented ${name} values`, () => {
      expect([...documented].sort()).toEqual([...implemented].sort());
    });
  }
});

describe('methodology label parity', () => {
  // The documented label is the same string the rest of the site renders, so a
  // definition can never describe a badge under a different name than it shows.
  it('reuses the shared lifecycle labels', () => {
    for (const entry of lifecycleStatusGlossary) expect(entry.label).toBe(statusLabel(entry.value));
  });
  it('reuses the shared access labels', () => {
    for (const entry of accessTypeGlossary) expect(entry.label).toBe(accessLabel(entry.value));
  });
  it('reuses the shared category labels', () => {
    for (const entry of categoryGlossary) expect(entry.label).toBe(categoryLabel(entry.value));
  });
  it('reuses the shared usage provenance labels', () => {
    for (const entry of usageProvenanceGlossary) expect(entry.label).toBe(usageProvenanceLabel(entry.value));
  });
  it('reuses the shared fit classification labels', () => {
    for (const entry of fitClassificationGlossary) expect(entry.label).toBe(fitClassificationLabel(entry.value));
  });
  it('reuses the shared fit gap reason labels', () => {
    for (const entry of fitGapReasonGlossary) expect(entry.label).toBe(fitGapReasonLabel(entry.value));
  });
  it('labels source types exactly as SourceList renders them', () => {
    for (const entry of sourceTypeGlossary) expect(entry.label).toBe(entry.value.replaceAll('-', ' '));
  });
});

describe('methodology source priority', () => {
  // The primary/non-primary split is read from the validator's own set, so the
  // page cannot claim a source type is primary when the validator does not.
  it('marks a source type primary exactly when the validator does', () => {
    for (const entry of sourceTypeGlossary) {
      expect(entry.primary).toBe(PRIMARY_SOURCE_TYPES.has(entry.value));
    }
  });

  it('agrees with the validator on which types are primary', () => {
    const documentedPrimary = sourceTypeGlossary.filter((entry) => entry.primary).map((entry) => entry.value).sort();
    expect(documentedPrimary).toEqual([...PRIMARY_SOURCE_TYPES].sort());
  });
});

describe('methodology definitions', () => {
  it('are all non-empty', () => {
    for (const definition of allMethodologyDefinitions) {
      expect(definition.trim().length).toBeGreaterThan(0);
    }
  });

  it('never use universal-winner language', () => {
    // The page documents a product that refuses a universal ranking, so its own
    // prose must clear the same filter the schema enforces on editorial text.
    for (const definition of allMethodologyDefinitions) {
      expect(findUniversalClaim(definition)).toBeUndefined();
    }
  });
});

describe('methodology outline', () => {
  const sectionIds = methodologySections.map((section) => section.id);
  const allIds = methodologySections.flatMap((section) => [section.id, ...section.subsections.map((sub) => sub.id)]);

  it('uses unique kebab-case ids for every heading', () => {
    for (const id of allIds) expect(id).toMatch(KEBAB);
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it('gives every section and subsection a non-empty title', () => {
    for (const section of methodologySections) {
      expect(section.title.trim().length).toBeGreaterThan(0);
      expect(section.summary.trim().length).toBeGreaterThan(0);
      for (const sub of section.subsections) expect(sub.title.trim().length).toBeGreaterThan(0);
    }
  });

  it('links every section from the table of contents and nothing else', () => {
    expect(methodologyTableOfContents.map((link) => link.href)).toEqual(sectionIds.map((id) => `#${id}`));
    for (const link of methodologyTableOfContents) {
      const targetId = link.href.replace(/^#/, '');
      expect(sectionIds).toContain(targetId);
    }
  });

  it('covers the five issue scope areas', () => {
    expect(sectionIds).toEqual(['inclusion', 'entities', 'provenance', 'evidence', 'corrections']);
  });
});

describe('methodology benchmark configuration', () => {
  // Documenting a field the schema does not record would describe a capability
  // that does not exist. Every documented field must be a real key on the
  // benchmark-result schema.
  const schemaKeys = Object.keys(benchmarkResultSchema.shape);

  it('documents only real benchmark-result fields', () => {
    for (const entry of benchmarkConfigurationFields) {
      expect(schemaKeys).toContain(entry.field);
    }
  });

  it('describes what every documented field records', () => {
    for (const entry of benchmarkConfigurationFields) {
      expect(entry.records.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('methodology benchmark comparability examples', () => {
  // AC3: the page must show comparable AND non-comparable cases. These are
  // DERIVED from real benchmark records, not authored, so the verdict must fall
  // out of the recorded configuration rather than being asserted in prose.
  const results = dataset.benchmarkResults;
  const examples = deriveBenchmarkComparabilityExamples(
    results,
    dataset.benchmarks,
    dataset.releases,
  );

  // Independent re-implementation of the comparison axis (the validator's setup
  // key minus the model), used to check the derivation rather than mirror it.
  const axisKey = (result: (typeof results)[number]) =>
    BENCHMARK_COMPARISON_FIELDS.map((field) => String(result[field] ?? '')).join('\u0000');
  const differsOn = (field: (typeof BENCHMARK_COMPARISON_FIELDS)[number]) =>
    results.some((a, i) =>
      results.slice(i + 1).some((b) => String(a[field] ?? '') !== String(b[field] ?? '')),
    );

  it('derives at least one comparable and one non-comparable case', () => {
    expect(examples.some((example) => example.comparable)).toBe(true);
    expect(examples.some((example) => !example.comparable)).toBe(true);
  });

  it('gives every derived example two runs, a basis, and no empty prose', () => {
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      expect(example.runA.trim().length).toBeGreaterThan(0);
      expect(example.runB.trim().length).toBeGreaterThan(0);
      expect(example.basis.trim().length).toBeGreaterThan(0);
    }
  });

  it('backs the comparable case with a real same-axis pair in the dataset', () => {
    const comparable = examples.filter((example) => example.comparable);
    expect(comparable.length).toBeGreaterThan(0);
    for (const example of comparable) {
      expect(example.differingField).toBeNull();
    }
    // The verdict is only honest if the data actually holds two results that
    // share a configuration axis but differ in model.
    const realPairExists = results.some((a, i) =>
      results
        .slice(i + 1)
        .some((b) => a.releaseId !== b.releaseId && axisKey(a) === axisKey(b)),
    );
    expect(realPairExists).toBe(true);
  });

  it('reports only real comparison fields as undisclosed', () => {
    for (const example of examples) {
      for (const field of example.undisclosedFields) {
        expect(BENCHMARK_COMPARISON_FIELDS).toContain(field);
      }
    }
  });

  it('keys every non-comparable case on a real configuration field that truly differs', () => {
    const nonComparable = examples.filter((example) => !example.comparable);
    expect(nonComparable.length).toBeGreaterThan(0);
    for (const example of nonComparable) {
      expect(example.differingField).not.toBeNull();
      expect(BENCHMARK_COMPARISON_FIELDS).toContain(example.differingField);
      // The reported field must be one two real records genuinely differ on.
      expect(differsOn(example.differingField!)).toBe(true);
    }
  });

  it('states no benchmark score, so no external number is presented as fact', () => {
    for (const example of examples) {
      const prose = `${example.runA} ${example.runB} ${example.basis}`;
      expect(prose).not.toMatch(/\b\d+(?:\.\d+)?\s*%/);
    }
  });

  it('mirrors the validator setup key exactly, minus the model, so the axis cannot drift', () => {
    // The comparison axis is defined by validate.ts. If that key changes, this
    // list must too; scan the real source and fail if they diverge.
    const source = readFileSync(new URL('../data/validate.ts', import.meta.url), 'utf8');
    const setupBlock = source.match(/const setup = \[([\s\S]*?)\]\.join\('\|'\)/);
    expect(setupBlock).not.toBeNull();
    const fieldsInKey = [...setupBlock![1].matchAll(/result\.(\w+)/g)].map((match) => match[1]);
    const uniqueFields = [...new Set(fieldsInKey)];
    // The validator keys on the comparison fields PLUS the model (releaseId).
    expect(new Set(uniqueFields)).toEqual(new Set([...BENCHMARK_COMPARISON_FIELDS, 'releaseId']));
  });
});

describe('deriveBenchmarkComparabilityExamples verdict logic', () => {
  // Pins the verdict rule on synthetic records, independent of the real dataset,
  // so a wrong classification (e.g. calling a different-axis pair comparable)
  // cannot hide behind the fact that the real data merely CONTAINS a valid pair.
  type Result = (typeof dataset.benchmarkResults)[number];
  type Bench = (typeof dataset.benchmarks)[number];
  type Rel = (typeof dataset.releases)[number];

  const benches = [
    { id: 'bench-x', name: 'Benchmark X' },
    { id: 'bench-y', name: 'Benchmark Y' },
  ] as unknown as Bench[];
  const rels = [
    { id: 'model-a', displayName: 'Model A' },
    { id: 'model-b', displayName: 'Model B' },
  ] as unknown as Rel[];
  let seq = 0;
  const result = (over: Partial<Result>): Result =>
    ({
      id: `synthetic-${(seq += 1)}`,
      benchmarkId: 'bench-x',
      benchmarkVersion: 'v1',
      releaseId: 'model-a',
      ...over,
    }) as unknown as Result;

  it('classifies a same-axis, different-model pair as comparable', () => {
    const out = deriveBenchmarkComparabilityExamples(
      [result({ releaseId: 'model-a' }), result({ releaseId: 'model-b' })],
      benches,
      rels,
    );
    const comparable = out.filter((example) => example.comparable);
    expect(comparable).toHaveLength(1);
    expect(comparable[0].differingField).toBeNull();
    expect(comparable[0].runA).toContain('Model A');
    expect(comparable[0].runB).toContain('Model B');
  });

  it('does NOT call a different-axis pair comparable', () => {
    // Different model AND different benchmark: not on the same axis.
    const out = deriveBenchmarkComparabilityExamples(
      [
        result({ releaseId: 'model-a', benchmarkId: 'bench-x' }),
        result({ releaseId: 'model-b', benchmarkId: 'bench-y' }),
      ],
      benches,
      rels,
    );
    expect(out.some((example) => example.comparable)).toBe(false);
  });

  it('reports the exact field a non-comparable pair differs on', () => {
    const out = deriveBenchmarkComparabilityExamples(
      [
        result({ releaseId: 'model-a', benchmarkId: 'bench-x' }),
        result({ releaseId: 'model-a', benchmarkId: 'bench-y' }),
      ],
      benches,
      rels,
    );
    const nonComparable = out.filter((example) => !example.comparable);
    expect(nonComparable).toHaveLength(1);
    expect(nonComparable[0].differingField).toBe('benchmarkId');
  });

  it('prefers a same-model non-comparable pair so the contrast is the setup', () => {
    const out = deriveBenchmarkComparabilityExamples(
      [
        result({ releaseId: 'model-a', benchmarkId: 'bench-x', benchmarkVersion: 'v1' }),
        result({ releaseId: 'model-b', benchmarkId: 'bench-x', benchmarkVersion: 'v1' }),
        result({ releaseId: 'model-a', benchmarkId: 'bench-x', benchmarkVersion: 'v2' }),
      ],
      benches,
      rels,
    );
    const nonComparable = out.find((example) => !example.comparable);
    expect(nonComparable).toBeDefined();
    expect(nonComparable!.differingField).toBe('benchmarkVersion');
    expect(nonComparable!.runA).toContain('Model A');
    expect(nonComparable!.runB).toContain('Model A');
  });

  it('flags a shared undisclosed field on the comparable example', () => {
    // Both leave harness unset: comparability rests on it being equal, not shown.
    const out = deriveBenchmarkComparabilityExamples(
      [result({ releaseId: 'model-a' }), result({ releaseId: 'model-b' })],
      benches,
      rels,
    );
    const comparable = out.find((example) => example.comparable);
    expect(comparable).toBeDefined();
    expect(comparable!.undisclosedFields).toContain('harness');
  });

  it('does not flag a field both results disclose', () => {
    const out = deriveBenchmarkComparabilityExamples(
      [
        result({ releaseId: 'model-a', harness: 'lm-eval' } as Partial<Result>),
        result({ releaseId: 'model-b', harness: 'lm-eval' } as Partial<Result>),
      ],
      benches,
      rels,
    );
    const comparable = out.find((example) => example.comparable);
    expect(comparable).toBeDefined();
    expect(comparable!.undisclosedFields).not.toContain('harness');
  });
});

describe('unrecordedBenchmarkConfigFields', () => {
  // The config table must not imply optional fields are recorded when they are
  // not. This derives, from the schema and the data, which optional config
  // fields the dataset holds on no result — so the page's disclosure is true of
  // whatever records ship, not a hand-typed claim that can go stale.
  it('names only optional config fields, never a required one', () => {
    const optional = new Set(unrecordedBenchmarkConfigFields(dataset.benchmarkResults));
    // benchmarkVersion and resultType are required in benchmarkResultSchema.
    expect(optional.has('benchmarkVersion')).toBe(false);
    expect(optional.has('resultType')).toBe(false);
  });

  it('reports a field the dataset records on no result, not one it records', () => {
    const unrecorded = unrecordedBenchmarkConfigFields(dataset.benchmarkResults);
    for (const field of unrecorded) {
      const anyRecords = dataset.benchmarkResults.some((result) => {
        const value = (result as Record<string, unknown>)[field];
        return value !== undefined && value !== '';
      });
      expect(anyRecords).toBe(false);
    }
    // The gap is real in today's data, so the disclosure is not vacuous.
    expect(unrecorded.length).toBeGreaterThan(0);
  });

  it('drops a field once some result records it', () => {
    type Result = (typeof dataset.benchmarkResults)[number];
    const withHarness = dataset.benchmarkResults.map((result, index) =>
      index === 0 ? ({ ...result, harness: 'lm-eval-harness' } as Result) : result,
    );
    expect(unrecordedBenchmarkConfigFields(withHarness)).not.toContain('harness');
  });

  it('reports nothing for an empty result set rather than every field', () => {
    // No records means no evidence of absence to disclose.
    expect(unrecordedBenchmarkConfigFields([])).toEqual([]);
  });
});

describe('methodology deferred work', () => {
  // The page must name unimplemented policy and its owning issue rather than
  // inventing it. Benchmark comparability transformations are issue #22.
  it('defers benchmark comparability to its owning issue', () => {
    const benchmark = deferredToImplementation.find((entry) =>
      entry.area.toLowerCase().includes('benchmark'),
    );
    expect(benchmark).toBeDefined();
    const url = new URL(benchmark!.issue);
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('github.com');
    expect(url.pathname).toBe('/abdeslam-menacere/ModelTree/issues/22');
    expect(benchmark!.note.trim().length).toBeGreaterThan(0);
  });

  it('gives every deferred entry an area, issue url, and note', () => {
    for (const entry of deferredToImplementation) {
      expect(entry.area.trim().length).toBeGreaterThan(0);
      expect(entry.note.trim().length).toBeGreaterThan(0);
      expect(new URL(entry.issue).hostname).toBe('github.com');
    }
  });
});

describe('methodology references', () => {
  it('links the correction path to the repository', () => {
    const correction = new URL(methodologyReferences.correctionPath);
    expect(correction.protocol).toBe('https:');
    expect(correction.hostname).toBe('github.com');
    expect(methodologyReferences.correctionPath.startsWith(methodologyReferences.repository)).toBe(true);
  });

  it('keeps the data-refresh route internal and relative', () => {
    expect(methodologyReferences.dataRefreshRoute).toBe('refresh/');
  });
});

describe('methodology page source', () => {
  const page = readFileSync(new URL('../pages/methodology.astro', import.meta.url), 'utf8');

  it('gives every subsection a matching hardcoded heading anchor', () => {
    // The <h3 id> anchors are hardcoded in the page while the table of contents
    // is data-driven; if the two drift, an in-page link silently 404s. Bind them.
    const anchorIds = new Set(
      [...page.matchAll(/<h3 id="([^"]+)"/g)].map((match) => match[1]),
    );
    for (const section of methodologySections) {
      for (const sub of section.subsections) {
        expect(anchorIds).toContain(sub.id);
      }
    }
  });

  it('renders exactly one top-level heading', () => {
    const h1s = page.match(/<h1[\s>]/g) ?? [];
    expect(h1s).toHaveLength(1);
  });

  it('drives its structure from the methodology lib', () => {
    expect(page).toContain("from '../lib/methodology'");
    expect(page).toContain('methodologySections');
    expect(page).toContain('methodologyTableOfContents');
  });

  it('links the correction path', () => {
    expect(page).toContain('methodologyReferences.correctionPath');
  });

  it('renders derived benchmark comparability examples and still marks deferred policy', () => {
    expect(page).toContain('deriveBenchmarkComparabilityExamples');
    expect(page).toContain('deferredToImplementation');
    // The examples are derived from real records, not authored placeholders.
    expect(page).toContain('derived from real benchmark results');
    expect(page).toContain('Comparable');
    expect(page).toContain('Not comparable');
    // The disclosure caveat must be stated: absence of a difference is not sameness.
    expect(page).toContain('undisclosedFields');
    expect(page).toContain('Absence of a recorded difference');
    // The config table must disclose that optional fields are unrecorded, not
    // claim the schema records every field on every result.
    expect(page).toContain('unrecordedConfigFields');
    expect(page).toContain('currently unrecorded on every result');
    expect(page).toContain('Configuration a benchmark result can record');
    expect(page).not.toContain('Configuration recorded on each benchmark result');
    expect(page).not.toContain('records the configuration below on every benchmark');
  });
});
