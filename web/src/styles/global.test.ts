import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const globalStyles = readFileSync(new URL('./global.css', import.meta.url), 'utf8');

function ruleFor(selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = globalStyles.match(new RegExp(`^${escapedSelector}\\s*\\{([^}]*)\\}`, 'm'));

  expect(rule, `Expected a rule for ${selector}`).not.toBeNull();
  return rule?.[1] ?? '';
}

describe('global viewport sizing', () => {
  it('does not impose a minimum width on page-level elements', () => {
    expect(ruleFor('html')).not.toMatch(/\bmin-(?:inline-size|width)\s*:/);
    expect(ruleFor('body')).not.toMatch(/\bmin-(?:inline-size|width)\s*:/);
  });
});
