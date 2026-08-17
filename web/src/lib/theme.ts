export const THEME_STORAGE_KEY = 'modeltree-theme';
export const THEME_QUERY_PARAMETER = 'scoutTheme';
export const THEME_ATTRIBUTE = 'data-theme';
export const THEME_PREFERENCE_ATTRIBUTE = 'data-theme-preference';
export const PREFERS_DARK_QUERY = '(prefers-color-scheme: dark)';
export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type ResolvedTheme = 'light' | 'dark';

export const SYSTEM_THEME_PREFERENCE = 'system' satisfies ThemePreference;

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value);
}

/** The query parameter overrides storage for one page load only; it is never persisted. */
export function resolveThemePreference(
  { search, stored }: { search?: string | null; stored?: string | null },
): ThemePreference {
  const parameter = new URLSearchParams(search ?? '').get(THEME_QUERY_PARAMETER);
  if (isThemePreference(parameter)) return parameter;
  if (isThemePreference(stored)) return stored;
  return SYSTEM_THEME_PREFERENCE;
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === SYSTEM_THEME_PREFERENCE) return prefersDark ? 'dark' : 'light';
  return preference;
}

export function applyTheme(
  element: { setAttribute(name: string, value: string): void },
  preference: ThemePreference,
  prefersDark: boolean,
): ResolvedTheme {
  const theme = resolveTheme(preference, prefersDark);
  element.setAttribute(THEME_ATTRIBUTE, theme);
  element.setAttribute(THEME_PREFERENCE_ATTRIBUTE, preference);
  return theme;
}
