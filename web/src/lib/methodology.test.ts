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
  benchmarkConfigurationFields,
  categoryGlossary,
  deferredToImplementation,
  fitClassificationGlossary,
  fitGapReasonGlossary,
  lifecycleStatusGlossary,
  methodologyReferences,
  methodologySections,
  methodologyTableOfContents,
  sourceTypeGlossary,
  usageProvenanceGlossary,
  type GlossaryEntry,
} from './methodology';

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

  it('marks deferred benchmark policy rather than inventing it', () => {
    expect(page).toContain('deferredToImplementation');
    expect(page).not.toContain('benchmarkComparabilityExamples');
  });
});
