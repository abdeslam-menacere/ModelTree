import { expect, test, type Page } from '@playwright/test';
import { DESKTOP, NARROW, gotoLineage, openFirstRelease } from './lineage-helpers';

// Issue #14, acceptance criteria 2 and 3: everything reachable and operable by
// keyboard with a visible focus indicator, and selection and expanded state
// exposed programmatically. Also the 2.5.8 target sizes the issue lists under
// scope as "tap targets meet the minimum size".

/** An element's focus ring, as the engine computes it while it holds focus. */
async function outlineOfFocused(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (el === null) return null;
    const style = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      className: String(el.className ?? ''),
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineColor: style.outlineColor,
      matchesFocusVisible: el.matches(':focus-visible'),
    };
  });
}

test.describe('desktop keyboard operation', () => {
  test.use({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });

  test('the scrollable hierarchy is reachable by keyboard and shows a focus ring', async ({ page }) => {
    await gotoLineage(page, '/tree/');

    // `overflow-x: auto` above 980px makes this a scroll container. WCAG 2.1.1
    // means its content has to be reachable without a pointer, which needs a
    // tab stop; and `aria-label` needs a role to hang on, or the name is not
    // exposed at all. Both are asserted against the real accessibility tree
    // rather than against the markup.
    const region = page.getByRole('region', { name: 'Reviewed model ecosystem hierarchy' });
    await expect(region).toBeVisible();

    await region.focus();
    const ring = await outlineOfFocused(page);
    expect(ring?.className).toContain('tree-scroll');
    expect(ring?.outlineStyle, 'a focused scroll region with no outline style').not.toBe('none');
    expect(Number.parseFloat(ring?.outlineWidth ?? '0')).toBeGreaterThanOrEqual(2);
  });

  test('tabbing reaches the tree controls and each stop paints a ring', async ({ page }) => {
    await gotoLineage(page, '/tree/');

    const seen: string[] = [];
    let reachedTree = false;

    // Bounded walk. If the tree cannot be reached from the top of the document
    // by Tab alone, that is the failure -- not a hung test.
    for (let i = 0; i < 60 && !reachedTree; i += 1) {
      await page.keyboard.press('Tab');
      const ring = await outlineOfFocused(page);
      if (ring === null) break;
      seen.push(`${ring.tag}.${ring.className}`);

      if (ring.matchesFocusVisible) {
        expect(
          ring.outlineStyle,
          `no focus ring on a keyboard-focused ${ring.tag}.${ring.className}`,
        ).not.toBe('none');
        expect(
          Number.parseFloat(ring.outlineWidth),
          `zero-width focus ring on ${ring.tag}.${ring.className}`,
        ).toBeGreaterThan(0);
      }

      if (ring.className.includes('tree-scroll') || ring.className.includes('tree-disclosure')) {
        reachedTree = true;
      }
    }

    expect(reachedTree, `tab order never reached the tree; stops were:\n${seen.join('\n')}`).toBe(true);
  });

  test('disclosures and release buttons expose their state, not just their colour', async ({ page }) => {
    await gotoLineage(page, '/tree/');
    await openFirstRelease(page);

    const creator = page.locator('.tree-creator-node').first();
    await expect(creator).toHaveAttribute('aria-expanded', 'true');

    const release = page.locator('.tree-release-node button').first();
    await expect(release).toHaveAttribute('aria-pressed', 'false');

    await release.press('Enter');
    await expect(release).toHaveAttribute('aria-pressed', 'true');

    // AC-4: a selected node must differ by more than hue. The word is
    // `aria-hidden` -- `aria-pressed` is the programmatic signal -- so this
    // checks it is painted, with a real box, rather than merely present in the
    // markup.
    const marker = release.locator('.tree-release-selected');
    await expect(marker).toHaveText('Selected');
    const box = await marker.boundingBox();
    expect(box, 'the selection marker has no painted box').not.toBeNull();
    expect(box?.width ?? 0).toBeGreaterThan(0);
    expect(box?.height ?? 0).toBeGreaterThan(0);
  });
});

test.describe('narrow-viewport keyboard operation', () => {
  test.use({ viewport: { width: NARROW.width, height: NARROW.height } });

  test('a release opens the drawer by keyboard, and Escape returns focus to it', async ({ page }) => {
    await gotoLineage(page, '/tree/');
    await openFirstRelease(page);

    const release = page.locator('.tree-release-node button').first();
    await release.focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');

    // The #11 QA finding: a dialog that computed `position: static` had an
    // inert `z-index`, leaving the backdrop the topmost hit target. Asserted
    // against the engine, which is where jsdom could not answer.
    const stacking = await dialog.evaluate((el) => {
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      const topmost = document.elementFromPoint(box.left + box.width / 2, box.top + 8);
      return { position: style.position, containsTopmost: topmost !== null && el.contains(topmost) };
    });
    expect(stacking.position).not.toBe('static');
    expect(stacking.containsTopmost, 'something is painted over the drawer').toBe(true);

    // The accessible name has to resolve. On mobile `aria-labelledby` once
    // pointed at an element that was not rendered there and the name silently
    // vanished; a resolved name is what proves it does not now.
    const name = await dialog.evaluate((el) => {
      const id = el.getAttribute('aria-labelledby');
      if (id === null) return null;
      return document.getElementById(id)?.textContent?.trim() ?? null;
    });
    expect(name, 'the drawer aria-labelledby does not resolve to rendered text').toBeTruthy();

    const focusInside = await dialog.evaluate((el) => el.contains(document.activeElement));
    expect(focusInside, 'focus was not moved into the modal drawer').toBe(true);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    const returned = await release.evaluate((el) => el === document.activeElement);
    expect(returned, 'focus did not return to the node that opened the drawer').toBe(true);

    // The #11 reopen defect: an effect keyed on unchanged state bailed out, so
    // a dismissed drawer could not be reopened for the same release.
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('interactive targets clear the 24 CSS px minimum', async ({ page }) => {
    await gotoLineage(page, '/tree/');
    await openFirstRelease(page);
    await page.locator('.tree-release-node button').first().click();
    await expect(page.getByRole('dialog')).toBeVisible();

    const measured = await page.evaluate(() => {
      const selectors = [
        '.tree-disclosure',
        '.tree-release-node button',
        '.tree-release-node a',
        '.tree-drawer-close',
        '.primary-action',
        '.text-action',
      ];
      const undersized: { selector: string; width: number; height: number }[] = [];
      let counted = 0;

      for (const selector of selectors) {
        for (const el of Array.from(document.querySelectorAll(selector))) {
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const box = el.getBoundingClientRect();
          if (box.width === 0 && box.height === 0) continue;
          counted += 1;
          if (box.width < 24 || box.height < 24) {
            undersized.push({ selector, width: box.width, height: box.height });
          }
        }
      }

      return { undersized, counted };
    });

    // The control: an empty result means "nothing undersized" only if something
    // was measured at all.
    expect(measured.counted, 'no interactive target was measured').toBeGreaterThan(5);
    expect(measured.undersized, 'targets under the WCAG 2.2 AA 24x24 minimum').toEqual([]);
  });
});
