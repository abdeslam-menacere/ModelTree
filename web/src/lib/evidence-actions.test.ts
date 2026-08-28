import { describe, expect, it } from 'vitest';
import {
  COMPARE_MODEL_LIMIT,
  createCompareUrl,
  createEvidenceUrl,
} from './evidence-actions';

describe('createEvidenceUrl', () => {
  it('encodes the selected model as the models query state on /benchmarks', () => {
    expect(createEvidenceUrl('/ModelTree/', 'anthropic-claude-opus-5')).toBe(
      '/ModelTree/benchmarks/?models=anthropic-claude-opus-5',
    );
  });

  it('normalises a base without a trailing slash', () => {
    expect(createEvidenceUrl('/ModelTree', 'meta-llama-4-scout')).toBe(
      '/ModelTree/benchmarks/?models=meta-llama-4-scout',
    );
  });

  it('handles a root base', () => {
    expect(createEvidenceUrl('/', 'zenith-flagship')).toBe('/benchmarks/?models=zenith-flagship');
  });
});

describe('createCompareUrl', () => {
  it('starts a fresh comparison when the current URL has no models', () => {
    const result = createCompareUrl('/ModelTree/tree/?model=some-release', '/ModelTree/', 'model-a');
    expect(result.href).toBe('/ModelTree/compare/?models=model-a');
    expect(result.models).toEqual(['model-a']);
    expect(result.atLimit).toBe(false);
  });

  it('appends to an existing comparison set in order', () => {
    const result = createCompareUrl('/ModelTree/compare/?models=model-a,model-b', '/ModelTree/', 'model-c');
    expect(result.href).toBe('/ModelTree/compare/?models=model-a,model-b,model-c');
    expect(result.models).toEqual(['model-a', 'model-b', 'model-c']);
    expect(result.atLimit).toBe(false);
  });

  it('is idempotent when the model is already selected', () => {
    const result = createCompareUrl('/ModelTree/compare/?models=model-a,model-b', '/ModelTree/', 'model-a');
    expect(result.href).toBe('/ModelTree/compare/?models=model-a,model-b');
    expect(result.models).toEqual(['model-a', 'model-b']);
    expect(result.atLimit).toBe(false);
  });

  it('fills the set up to exactly the four-model limit', () => {
    const result = createCompareUrl('/ModelTree/compare/?models=model-a,model-b,model-c', '/ModelTree/', 'model-d');
    expect(result.models).toHaveLength(COMPARE_MODEL_LIMIT);
    expect(result.href).toBe('/ModelTree/compare/?models=model-a,model-b,model-c,model-d');
    expect(result.atLimit).toBe(false);
  });

  it('refuses a new model once the set already holds four', () => {
    const result = createCompareUrl(
      '/ModelTree/compare/?models=model-a,model-b,model-c,model-d',
      '/ModelTree/',
      'model-e',
    );
    expect(result.models).toEqual(['model-a', 'model-b', 'model-c', 'model-d']);
    expect(result.href).toBe('/ModelTree/compare/?models=model-a,model-b,model-c,model-d');
    expect(result.atLimit).toBe(true);
  });

  it('still allows re-selecting a model that is already in a full set', () => {
    const result = createCompareUrl(
      '/ModelTree/compare/?models=model-a,model-b,model-c,model-d',
      '/ModelTree/',
      'model-c',
    );
    expect(result.atLimit).toBe(false);
    expect(result.models).toHaveLength(COMPARE_MODEL_LIMIT);
  });

  it('ignores blank entries and surrounding whitespace in the current models', () => {
    const result = createCompareUrl('/ModelTree/compare/?models=model-a,%20,model-b', '/ModelTree/', 'model-c');
    expect(result.models).toEqual(['model-a', 'model-b', 'model-c']);
  });

  it('accepts an absolute URL and preserves only the path and query in the result', () => {
    const result = createCompareUrl(
      new URL('https://example.com/ModelTree/tree/?model=x#frag'),
      '/ModelTree/',
      'model-a',
    );
    expect(result.href).toBe('/ModelTree/compare/?models=model-a');
  });
});
