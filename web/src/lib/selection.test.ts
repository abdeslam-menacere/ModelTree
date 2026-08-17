import { describe, expect, it } from 'vitest';
import {
  createModelSelectionUrl,
  readOptionalSelectedModel,
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