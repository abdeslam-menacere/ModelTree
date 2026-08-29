// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import { accessLabel, formatDate, statusLabel } from '../lib/format';
import { organizationFullName, organizationLabel } from '../lib/organization-name';
import LineageModelDrawer, { type DrawerSelection } from './LineageModelDrawer';

const release = dataset.releases.find(({ id }) => id === 'anthropic-claude-opus-5')!;
const family = dataset.families.find(({ id }) => id === release.familyId)!;
const organization = dataset.organizations.find(({ id }) => id === release.organizationId)!;
const selection: DrawerSelection = { organization, family, release };
const source = { title: 'Anthropic model card', url: 'https://example.com/claude' };

function panel() {
  return document.querySelector('.tree-details') as HTMLElement;
}

beforeEach(() => {
  window.history.replaceState({}, '', '/ModelTree/tree/');
});

afterEach(() => {
  cleanup();
});

describe('LineageModelDrawer (anchored panel)', () => {
  it('prompts for a selection and stays non-modal when nothing is chosen', () => {
    render(<LineageModelDrawer basePath="/ModelTree/" />);
    expect(screen.getByRole('heading', { name: 'Choose a model release' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(panel().getAttribute('aria-labelledby')).toBe('model-tree-heading');
  });

  it('shows every required summary field for the selected release', () => {
    render(<LineageModelDrawer selected={selection} source={source} basePath="/ModelTree/" />);
    const surface = panel();

    expect(within(surface).getByRole('heading', { name: release.displayName })).toBeTruthy();
    expect(within(surface).getByText(`${organizationLabel(organization)} / ${family.name}`)).toBeTruthy();
    expect(within(surface).getByText(release.summary)).toBeTruthy();

    const fields: Array<[string, string]> = [
      // Pinned literal (release is day-precision) rather than computed from the
      // production formatter, so the assertion is not tautological.
      ['Released', 'Jul 24, 2026'],
      ['Status', statusLabel(release.status)],
      ['Access', accessLabel(release.accessType)],
      ['Purpose', release.intendedUse],
      ['Verified', formatDate(release.verifiedAt)],
    ];
    for (const [label, value] of fields) {
      const term = within(surface).getByText(label);
      expect(term.tagName).toBe('DT');
      expect(term.nextElementSibling?.textContent).toBe(value);
    }
  });

  it('renders the release date at its stated precision, not always to the day', () => {
    // A month-precision record must not publish a day nobody claimed. `formatDate`
    // would render "Jul 24, 2026" here; the precision-aware formatter must not.
    const monthPrecision = { ...selection, release: { ...release, datePrecision: 'month' as const } };
    render(<LineageModelDrawer selected={monthPrecision} source={source} basePath="/ModelTree/" />);
    const term = within(panel()).getByText('Released');
    expect(term.nextElementSibling?.textContent).toBe('Jul 2026');
  });

  it('generates stable action URLs for view, evidence, and compare', () => {
    render(<LineageModelDrawer selected={selection} source={source} basePath="/ModelTree/" />);
    const surface = panel();

    expect(within(surface).getByRole('link', { name: /View model/ }).getAttribute('href'))
      .toBe(`/ModelTree/models/${release.slug}/`);
    expect(within(surface).getByRole('link', { name: 'See evidence' }).getAttribute('href'))
      .toBe(`/ModelTree/benchmarks/?models=${release.slug}`);
    expect(within(surface).getByRole('link', { name: 'Compare' }).getAttribute('href'))
      .toBe(`/ModelTree/compare/?models=${release.slug}`);
  });

  it('shows a source label linked to the source record when one exists', () => {
    render(<LineageModelDrawer selected={selection} source={source} basePath="/ModelTree/" />);
    const surface = panel();
    const term = within(surface).getByText('Source');
    expect(term.tagName).toBe('DT');
    const link = within(surface).getByRole('link', { name: source.title });
    expect(link.getAttribute('href')).toBe(source.url);
  });

  it('leaves no empty label when the optional source fact is missing', () => {
    render(<LineageModelDrawer selected={selection} basePath="/ModelTree/" />);
    const surface = panel();
    expect(within(surface).queryByText('Source')).toBeNull();
    const emptyDefinitions = Array.from(surface.querySelectorAll('dd')).filter(
      (dd) => (dd.textContent ?? '').trim().length === 0,
    );
    expect(emptyDefinitions).toEqual([]);
  });
});

/**
 * The creator naming rule at this surface -- abdeslam-menacere/ModelTree#479.
 *
 * This drawer was extracted from `ModelTreeExplorer` after #479 was written, and
 * it carried the raw `organization.name` across with it. The assertions above
 * could not catch that: they select Anthropic, whose two recorded name forms are
 * identical, so the breadcrumb reads correctly whether or not the rule is
 * applied. The fixture below is therefore chosen by the property under test.
 */
describe('LineageModelDrawer (creator naming rule)', () => {
  const withDistinctForms = dataset.organizations.find(
    (item) => item.name !== item.shortName
      && dataset.releases.some(({ organizationId }) => organizationId === item.id),
  );

  it('has a creator whose recorded name forms differ, so the assertion below is not vacuous', () => {
    // Without this the rule could be deleted and the test below would still pass.
    expect(withDistinctForms).toBeDefined();
  });

  it('breadcrumbs the creator by its label and never by its fuller recorded name', () => {
    const organizationUnderTest = withDistinctForms!;
    const distinctRelease = dataset.releases.find(
      ({ organizationId }) => organizationId === organizationUnderTest.id,
    )!;
    const distinctFamily = dataset.families.find(({ id }) => id === distinctRelease.familyId)!;

    render(
      <LineageModelDrawer
        selected={{
          organization: organizationUnderTest,
          family: distinctFamily,
          release: distinctRelease,
        }}
        basePath="/ModelTree/"
      />,
    );

    const breadcrumb = panel().querySelector('.tree-breadcrumb');
    expect(breadcrumb?.textContent).toBe(
      `${organizationLabel(organizationUnderTest)} / ${distinctFamily.name}`,
    );
    // The exact regression: before the fix this rendered the fuller form.
    expect(breadcrumb?.textContent).not.toContain(organizationFullName(organizationUnderTest));
  });
});
