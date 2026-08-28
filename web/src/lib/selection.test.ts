import { describe, expect, it } from 'vitest';
import {
  createLineageSelectionUrl,
  createModelSelectionUrl,
  readOptionalSelectedModel,
  readOptionalSelectedProvider,
  readSelectedModel,
} from './selection';

const slugs = ['gpt-4-1-2025-04-14', 'gpt-4-1-mini-2025-04-14'];

describe('model selection URL state', () => {
  it('restores a known model from query state', () => {
    expect(readSelectedModel('?model=gpt-4-1-mini-2025-04-14', slugs, slugs[0]))
      .toBe('gpt-4-1-mini-2025-04-14');
  });

  it('falls back for unknown model query state', () => {
    expect(readSelectedModel('?model=unknown', slugs, slugs[0])).toBe(slugs[0]);
  });

  it('updates model state without discarding other state or the fragment', () => {
    const result = createModelSelectionUrl(
      '/?provider=openai#explorer',
      'gpt-4-1-mini-2025-04-14',
    );

    expect(result).toBe('/?provider=openai&model=gpt-4-1-mini-2025-04-14#explorer');
  });

  it('keeps an absent or invalid optional tree selection empty', () => {
    expect(readOptionalSelectedModel('', slugs)).toBeUndefined();
    expect(readOptionalSelectedModel('?model=unknown', slugs)).toBeUndefined();
    expect(readOptionalSelectedModel(`?model=${slugs[1]}`, slugs)).toBe(slugs[1]);
  });
});

describe('provider and model share the homepage query state', () => {
  const providers = ['openai', 'anthropic'];

  it('restores a known provider and ignores an unknown one', () => {
    expect(readOptionalSelectedProvider('?provider=anthropic', providers)).toBe('anthropic');
    expect(readOptionalSelectedProvider('?provider=not-seeded', providers)).toBeUndefined();
    expect(readOptionalSelectedProvider('', providers)).toBeUndefined();
  });

  it('writes both halves without discarding other state or the fragment', () => {
    const result = createLineageSelectionUrl('/?ref=launch#explorer', 'anthropic', slugs[1]);

    expect(result).toBe(`/?ref=launch&provider=anthropic&model=${slugs[1]}#explorer`);
  });

  it('re-emits the pair in a stable order whatever order it arrived in', () => {
    const canonical = `/?provider=anthropic&model=${slugs[1]}`;

    expect(createLineageSelectionUrl(`/?model=${slugs[0]}`, 'anthropic', slugs[1])).toBe(canonical);
    expect(createLineageSelectionUrl('/?provider=openai', 'anthropic', slugs[1])).toBe(canonical);
  });

  it('replaces a stale pairing rather than appending a second one', () => {
    const result = createLineageSelectionUrl(
      `/?provider=openai&model=${slugs[0]}`,
      'anthropic',
      slugs[1],
    );

    expect(result).toBe(`/?provider=anthropic&model=${slugs[1]}`);
  });
});