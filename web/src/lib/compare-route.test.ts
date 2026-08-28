import { describe, expect, it } from 'vitest';
import {
  COMPARE_QUERY_PARAMETER,
  MAX_COMPARISON_MODELS,
  MIN_COMPARISON_MODELS,
  compareRoute,
  compareUrl,
  readComparisonSlugs,
  serializeComparisonSelection,
} from './compare-route';

/**
 * The URL contract is shared by three callers — the comparison page, the Model
 * Passport, and the lineage drawer — so it is tested on its own. A test that
 * only reached it through one of them would let the other two drift.
 */
describe('the compare URL contract', () => {
  it('uses one ordered parameter, not repeated ones', () => {
    expect(COMPARE_QUERY_PARAMETER).toBe('models');
    expect(serializeComparisonSelection(['a', 'b', 'c'])).toBe('?models=a%2Cb%2Cc');
    expect(readComparisonSlugs('?models=a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('round-trips any selection, order included', () => {
    for (const slugs of [['a'], ['b', 'a'], ['a', 'b', 'c', 'd'], ['z', 'y', 'x', 'w']]) {
      expect(readComparisonSlugs(serializeComparisonSelection(slugs))).toEqual(slugs);
    }
  });

  it('yields a bare route for an empty selection, not a dangling parameter', () => {
    expect(serializeComparisonSelection([])).toBe('');
    expect(compareUrl('/ModelTree/', [])).toBe('/ModelTree/compare/');
  });

  it('carries an evidence link\u2019s other parameters through untouched', () => {
    const next = serializeComparisonSelection(['a', 'b'], '?models=a&domain=coding&benchmark=x');
    const params = new URLSearchParams(next);

    expect(params.get('models')).toBe('a,b');
    expect(params.get('domain')).toBe('coding');
    expect(params.get('benchmark')).toBe('x');
  });

  it('does not read the model tree\u2019s singular parameter', () => {
    // `?model=` is the tree's own deep link and means something else. Reading it
    // here would silently compare whatever release the tree had selected.
    expect(readComparisonSlugs('?model=atlas-pro')).toEqual([]);
  });

  it('normalises a base with or without its trailing slash', () => {
    expect(compareRoute('/ModelTree/')).toBe('/ModelTree/compare/');
    expect(compareRoute('/ModelTree')).toBe('/ModelTree/compare/');
    expect(compareRoute('/')).toBe('/compare/');
  });

  it('states the two-to-four bound in one place', () => {
    expect(MIN_COMPARISON_MODELS).toBe(2);
    expect(MAX_COMPARISON_MODELS).toBe(4);
    expect(MIN_COMPARISON_MODELS).toBeLessThan(MAX_COMPARISON_MODELS);
  });
});
