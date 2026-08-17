import {
  PREFERS_DARK_QUERY,
  SYSTEM_THEME_PREFERENCE,
  THEME_ATTRIBUTE,
  THEME_PREFERENCE_ATTRIBUTE,
  THEME_PREFERENCES,
  THEME_QUERY_PARAMETER,
  THEME_STORAGE_KEY,
} from './theme';

/**
 * Pre-paint bootstrap, inlined into <head> so the resolved theme is on <html>
 * before the first paint. It interpolates the constants from `./theme`, but it
 * re-implements the precedence logic inline because it has to run before any module
 * loads — so it can drift from `resolveThemePreference`/`resolveTheme`. The parity
 * matrix in `theme.test.ts` runs both implementations over the same inputs to catch
 * that. It lives in its own module so the picker's client bundle never imports it.
 */
export const themeBootstrapScript = `(() => {
  var preferences = ${JSON.stringify(THEME_PREFERENCES)};
  var isPreference = function (value) { return preferences.indexOf(value) !== -1; };
  var parameter = new URLSearchParams(window.location.search).get(${JSON.stringify(THEME_QUERY_PARAMETER)});
  var stored = null;
  try {
    stored = window.localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
  } catch (error) {
    stored = null;
  }
  var preference = isPreference(parameter)
    ? parameter
    : isPreference(stored)
      ? stored
      : ${JSON.stringify(SYSTEM_THEME_PREFERENCE)};
  var theme = preference === ${JSON.stringify(SYSTEM_THEME_PREFERENCE)}
    ? (window.matchMedia(${JSON.stringify(PREFERS_DARK_QUERY)}).matches ? "dark" : "light")
    : preference;
  document.documentElement.setAttribute(${JSON.stringify(THEME_ATTRIBUTE)}, theme);
  document.documentElement.setAttribute(${JSON.stringify(THEME_PREFERENCE_ATTRIBUTE)}, preference);
})();`;
