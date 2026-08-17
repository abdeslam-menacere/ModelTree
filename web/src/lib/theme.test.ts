import { describe, expect, it } from 'vitest';
import {
  PREFERS_DARK_QUERY,
  THEME_ATTRIBUTE,
  THEME_PREFERENCE_ATTRIBUTE,
  THEME_STORAGE_KEY,
  applyTheme,
  resolveTheme,
  resolveThemePreference,
  themeBootstrapScript,
} from './theme';

function createElementStub() {
  const attributes: Record<string, string | undefined> = {};
  return {
    attributes,
    element: {
      setAttribute(name: string, value: string) {
        attributes[name] = value;
      },
    },
  };
}

interface BootstrapOptions {
  search: string;
  stored: string | null;
  prefersDark: boolean;
  storageThrows?: boolean;
}

function runBootstrapScript(
  { search, stored, prefersDark, storageThrows = false }: BootstrapOptions,
) {
  const attributes: Record<string, string> = {};
  const writes: { key: string; value: string }[] = [];
  const mediaQueries: string[] = [];

  const windowStub = {
    location: { search },
    localStorage: {
      getItem(key: string) {
        if (storageThrows) throw new Error('localStorage is unavailable');
        return key === THEME_STORAGE_KEY ? stored : null;
      },
      setItem(key: string, value: string) {
        writes.push({ key, value });
      },
    },
    matchMedia(query: string) {
      mediaQueries.push(query);
      return { matches: query === PREFERS_DARK_QUERY ? prefersDark : false };
    },
  };

  const documentStub = {
    documentElement: {
      setAttribute(name: string, value: string) {
        attributes[name] = value;
      },
    },
  };

  new Function('window', 'document', themeBootstrapScript)(windowStub, documentStub);

  return { attributes, writes, mediaQueries };
}

describe('resolveThemePreference', () => {
  it('prefers a valid query parameter over a conflicting stored preference', () => {
    expect(resolveThemePreference({ search: '?scoutTheme=light', stored: 'dark' })).toBe('light');
  });

  it('ignores an invalid query parameter and falls through to the stored preference', () => {
    expect(resolveThemePreference({ search: '?scoutTheme=neon', stored: 'dark' })).toBe('dark');
  });

  it('uses the stored preference when no query parameter is present', () => {
    expect(resolveThemePreference({ search: '?model=gpt-4-1', stored: 'light' })).toBe('light');
  });

  it('ignores an invalid stored preference and falls back to system', () => {
    expect(resolveThemePreference({ search: '', stored: 'neon' })).toBe('system');
  });

  it('falls back to system when neither source supplies a preference', () => {
    expect(resolveThemePreference({ search: '', stored: null })).toBe('system');
  });
});

describe('resolveTheme', () => {
  it('resolves system both ways from the media preference', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('keeps an explicit preference regardless of the media preference', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});

describe('applyTheme', () => {
  it('writes the resolved theme and the system preference separately when dark is preferred', () => {
    const { attributes, element } = createElementStub();

    const resolved = applyTheme(element, 'system', true);

    expect(attributes[THEME_ATTRIBUTE]).toBe('dark');
    expect(attributes[THEME_PREFERENCE_ATTRIBUTE]).toBe('system');
    expect(resolved).toBe('dark');
  });

  it('writes the resolved theme and the system preference separately when dark is not preferred', () => {
    const { attributes, element } = createElementStub();

    const resolved = applyTheme(element, 'system', false);

    expect(attributes[THEME_ATTRIBUTE]).toBe('light');
    expect(attributes[THEME_PREFERENCE_ATTRIBUTE]).toBe('system');
    expect(resolved).toBe('light');
  });

  it('writes both attributes for an explicit preference that disagrees with the media query', () => {
    const { attributes, element } = createElementStub();

    const resolved = applyTheme(element, 'light', true);

    expect(attributes[THEME_ATTRIBUTE]).toBe('light');
    expect(attributes[THEME_PREFERENCE_ATTRIBUTE]).toBe('light');
    expect(resolved).toBe('light');
  });

  it('writes both attributes for an explicit dark preference', () => {
    const { attributes, element } = createElementStub();

    const resolved = applyTheme(element, 'dark', false);

    expect(attributes[THEME_ATTRIBUTE]).toBe('dark');
    expect(attributes[THEME_PREFERENCE_ATTRIBUTE]).toBe('dark');
    expect(resolved).toBe('dark');
  });
});

describe('themeBootstrapScript', () => {
  it('applies a valid query parameter ahead of a conflicting stored preference', () => {
    const { attributes } = runBootstrapScript({
      search: '?scoutTheme=light',
      stored: 'dark',
      prefersDark: true,
    });

    expect(attributes[THEME_ATTRIBUTE]).toBe('light');
    expect(attributes[THEME_PREFERENCE_ATTRIBUTE]).toBe('light');
  });

  it('never persists the query parameter override', () => {
    const { writes } = runBootstrapScript({
      search: '?scoutTheme=dark',
      stored: 'light',
      prefersDark: false,
    });

    expect(writes).toEqual([]);
  });

  it('ignores an invalid query parameter and applies the stored preference', () => {
    const { attributes } = runBootstrapScript({
      search: '?scoutTheme=neon',
      stored: 'dark',
      prefersDark: false,
    });

    expect(attributes[THEME_ATTRIBUTE]).toBe('dark');
    expect(attributes[THEME_PREFERENCE_ATTRIBUTE]).toBe('dark');
  });

  it('ignores an invalid stored preference and resolves system against the media query', () => {
    const { attributes, mediaQueries } = runBootstrapScript({
      search: '',
      stored: 'neon',
      prefersDark: true,
    });

    expect(attributes[THEME_ATTRIBUTE]).toBe('dark');
    expect(attributes[THEME_PREFERENCE_ATTRIBUTE]).toBe('system');
    expect(mediaQueries).toContain(PREFERS_DARK_QUERY);
  });

  it('resolves the system preference to light when dark is not preferred', () => {
    const { attributes } = runBootstrapScript({
      search: '?scoutTheme=system',
      stored: 'dark',
      prefersDark: false,
    });

    expect(attributes[THEME_ATTRIBUTE]).toBe('light');
    expect(attributes[THEME_PREFERENCE_ATTRIBUTE]).toBe('system');
  });

  it('applies the stored preference when localStorage is readable', () => {
    const { attributes } = runBootstrapScript({
      search: '',
      stored: 'light',
      prefersDark: true,
    });

    expect(attributes[THEME_ATTRIBUTE]).toBe('light');
    expect(attributes[THEME_PREFERENCE_ATTRIBUTE]).toBe('light');
  });

  it('still applies a theme when reading localStorage throws', () => {
    const { attributes } = runBootstrapScript({
      search: '',
      stored: 'light',
      prefersDark: true,
      storageThrows: true,
    });

    expect(attributes[THEME_ATTRIBUTE]).toBe('dark');
    expect(attributes[THEME_PREFERENCE_ATTRIBUTE]).toBe('system');
  });
});

describe('themeBootstrapScript parity with the tested module', () => {
  const searches = [
    '?scoutTheme=light',
    '?scoutTheme=dark',
    '?scoutTheme=system',
    '?scoutTheme=neon',
    '?scoutTheme=',
    '?model=gpt-4-1',
    '',
  ];
  const storedValues = ['light', 'dark', 'system', 'neon', '', null];
  const prefersDarkValues = [true, false];

  for (const search of searches) {
    for (const stored of storedValues) {
      for (const prefersDark of prefersDarkValues) {
        const label = `search=${JSON.stringify(search)} stored=${JSON.stringify(stored)} prefersDark=${prefersDark}`;

        it(`agrees with resolveThemePreference/resolveTheme for ${label}`, () => {
          const { attributes } = runBootstrapScript({ search, stored, prefersDark });
          const preference = resolveThemePreference({ search, stored });

          expect(attributes[THEME_PREFERENCE_ATTRIBUTE]).toBe(preference);
          expect(attributes[THEME_ATTRIBUTE]).toBe(resolveTheme(preference, prefersDark));
        });
      }
    }
  }
});
