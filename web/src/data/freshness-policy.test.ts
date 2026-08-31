import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  FRESHNESS_POLICY_VERSION,
  FRESHNESS_THRESHOLD_DAYS,
  RECORD_KIND_CATEGORY,
  type RecordKind,
  categoryOf,
  thresholdDaysFor,
} from './freshness-policy';
import { VOLATILE_STALE_AFTER_DAYS } from '../lib/passport';
import { STALE_AFTER_DAYS } from '../lib/usage-evidence';

const ALL_KINDS: RecordKind[] = [
  'organization',
  'family',
  'release',
  'product',
  'serving-platform',
  'deployment',
  'pricing',
  'benchmark',
  'benchmark-result',
  'release-event',
  'usage-observation',
  'usage-synthesis',
  'model-fit-statement',
  'model-fit-evidence-gap',
  'source',
  'publisher-control',
];

describe('freshness policy', () => {
  it('is versioned with a semver-shaped string', () => {
    expect(FRESHNESS_POLICY_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // The policy is the single source of truth; the two public-badge constants
  // that predate it must not drift away from it. If someone changes one of these
  // numbers, this test names which pair fell out of step.
  it('keeps the public-badge constants equal to the policy thresholds', () => {
    expect(FRESHNESS_THRESHOLD_DAYS.volatile).toBe(VOLATILE_STALE_AFTER_DAYS);
    expect(FRESHNESS_THRESHOLD_DAYS.evidence).toBe(STALE_AFTER_DAYS);
  });

  it('orders thresholds from most volatile to most structural', () => {
    expect(FRESHNESS_THRESHOLD_DAYS.volatile).toBeLessThan(FRESHNESS_THRESHOLD_DAYS.evidence);
    expect(FRESHNESS_THRESHOLD_DAYS.evidence).toBeLessThan(
      FRESHNESS_THRESHOLD_DAYS['release-metadata'],
    );
    expect(FRESHNESS_THRESHOLD_DAYS['release-metadata']).toBeLessThan(
      FRESHNESS_THRESHOLD_DAYS.structural,
    );
  });

  it('assigns every record kind a category and a positive threshold', () => {
    for (const kind of ALL_KINDS) {
      const category = categoryOf(kind);
      expect(RECORD_KIND_CATEGORY[kind]).toBe(category);
      expect(thresholdDaysFor(kind)).toBe(FRESHNESS_THRESHOLD_DAYS[category]);
      expect(thresholdDaysFor(kind)).toBeGreaterThan(0);
    }
  });

  it('maps the fast-moving and slow-moving kinds to the right bands', () => {
    expect(categoryOf('pricing')).toBe('volatile');
    expect(categoryOf('deployment')).toBe('volatile');
    expect(categoryOf('usage-observation')).toBe('evidence');
    expect(categoryOf('model-fit-statement')).toBe('evidence');
    expect(categoryOf('release')).toBe('release-metadata');
    expect(categoryOf('benchmark-result')).toBe('release-metadata');
    expect(categoryOf('organization')).toBe('structural');
    expect(categoryOf('source')).toBe('structural');
  });
});

// The policy's numbers are documented for humans in docs/product/FRESHNESS-POLICY.md.
// The module owns the values; this reads the document and asserts it still states
// the same ones, so the prose cannot quietly drift from the code. The workflow
// scope allowlist (web-ci.yml, pinned by web-ci.test.ts) lists this document, so an
// edit to it alone still runs this test.
describe('freshness policy document', () => {
  const doc = readFileSync(
    new URL('../../../docs/product/FRESHNESS-POLICY.md', import.meta.url),
    'utf8',
  );

  it('states the current policy version', () => {
    expect(doc).toContain(FRESHNESS_POLICY_VERSION);
  });

  it('states each category threshold in days', () => {
    for (const [category, days] of Object.entries(FRESHNESS_THRESHOLD_DAYS)) {
      expect(
        doc.includes(`| \`${category}\` | ${days} |`),
        `the policy document must state ${category} = ${days} days`,
      ).toBe(true);
    }
  });
});
