import { useEffect, useRef, useState } from 'react';
import type {
  ModelTreeViewFamilyRecord,
  ModelTreeViewOrganization,
  ModelTreeViewRelease,
} from '../lib/model-tree';
import { accessLabel, formatDate, formatReleaseDate, statusLabel } from '../lib/format';
import { createCompareUrl, createEvidenceUrl } from '../lib/evidence-actions';
import { organizationLabel } from '../lib/organization-name';

/**
 * Below this width the details surface is presented as a modal drawer; at or
 * above it, it is the anchored, persistent panel beside the tree. This is the
 * component's own modality threshold and is intentionally narrower than the
 * `@media (max-width: 980px)` breakpoint at which `global.css` collapses
 * `.tree-workspace` to a single column: between 701px and 980px the layout is
 * already stacked while this surface is still the anchored panel, which reads
 * as a full-width panel below the tree rather than a modal.
 */
const MOBILE_QUERY = '(max-width: 700px)';

/**
 * The drawer's slice of a selection, projected rather than whole: this arrives
 * through a serialised island prop, so it carries the recorded fields the panel
 * below renders and no others (abdeslam-menacere/ModelTree#813). Whole records
 * stay assignable to it, so a caller holding one needs no change.
 */
export interface DrawerSelection {
  organization: ModelTreeViewOrganization;
  family: ModelTreeViewFamilyRecord;
  release: ModelTreeViewRelease;
}

export interface DrawerSource {
  title: string;
  url: string;
}

interface Props {
  selected?: DrawerSelection;
  source?: DrawerSource;
  basePath: string;
  /**
   * Bumped by the explorer on every release activation, including re-selecting
   * the release that is already selected. The open effect keys on it so a
   * dismissed modal can be reopened for the same release — selecting the same
   * node leaves `selected` referentially identical, which alone would never
   * re-run the effect.
   */
  selectionNonce?: number;
}

function focusables(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hasAttribute('hidden'));
}

export default function LineageModelDrawer({ selected, source, basePath, selectionNonce }: Props) {
  const [isModal, setIsModal] = useState(false);
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const invokerRef = useRef<HTMLElement | null>(null);
  const normalizedBase = basePath.endsWith('/') ? basePath : `${basePath}/`;
  const releaseId = selected?.release.id;

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia(MOBILE_QUERY);
    const sync = () => setIsModal(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  // A selection while modal opens the drawer and remembers the node that
  // triggered it, so focus can return there on dismissal. Clearing the selection
  // (or leaving modal presentation) closes it.
  useEffect(() => {
    if (!isModal) {
      setOpen(false);
      return;
    }
    if (releaseId) {
      invokerRef.current = (document.activeElement as HTMLElement | null) ?? invokerRef.current;
      setOpen(true);
    } else {
      setOpen(false);
    }
  }, [isModal, releaseId, selectionNonce]);

  function dismiss() {
    setOpen(false);
    const invoker = invokerRef.current;
    if (invoker && typeof invoker.focus === 'function') invoker.focus();
  }

  // Focus trap and keyboard dismissal, active only while the modal drawer is
  // shown. The anchored panel is never modal and never traps focus.
  useEffect(() => {
    if (!(isModal && open)) return undefined;
    const dialog = dialogRef.current;
    if (!dialog) return undefined;

    dialog.querySelector<HTMLElement>('[data-drawer-close]')?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const items = focusables(dialog);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [isModal, open]);

  function details(selection: DrawerSelection) {
    const { organization, family, release } = selection;
    const currentUrl = typeof window !== 'undefined'
      ? window.location.href
      : `https://modeltree.local${normalizedBase}tree/`;

    return (
      <>
        <span className="eyebrow">Verified release</span>
        <p className="tree-breadcrumb">{organizationLabel(organization)} / {family.name}</p>
        <h2 id="model-tree-heading">{release.displayName}</h2>
        <p>{release.summary}</p>
        <dl>
          <div><dt>Released</dt><dd>{formatReleaseDate(release.releaseDate, release.datePrecision)}</dd></div>
          <div><dt>Status</dt><dd>{statusLabel(release.status)}</dd></div>
          <div><dt>Access</dt><dd>{accessLabel(release.accessType)}</dd></div>
          <div><dt>Purpose</dt><dd>{release.intendedUse}</dd></div>
          <div><dt>Verified</dt><dd>{formatDate(release.verifiedAt)}</dd></div>
          {source && (
            <div>
              <dt>Source</dt>
              <dd><a href={source.url}>{source.title}</a></dd>
            </div>
          )}
        </dl>
        <div className="details-actions">
          <a className="primary-action" href={`${normalizedBase}models/${release.slug}/`}>
            View model<span className="visually-hidden"> {release.displayName}</span>
          </a>
          <a className="text-action" href={createEvidenceUrl(basePath, release.slug)}>
            See evidence
          </a>
          <a className="text-action" href={createCompareUrl(currentUrl, basePath, release.slug).href}>
            Compare
          </a>
        </div>
      </>
    );
  }

  const emptyState = (
    <>
      <span className="eyebrow">Release details</span>
      <h2 id="model-tree-heading">Choose a model release</h2>
      <p>Open a creator and family, then select a release to inspect its verified catalog record.</p>
    </>
  );

  if (isModal) {
    if (!(open && selected)) return null;
    return (
      <div className="tree-drawer-overlay">
        <div className="tree-drawer-backdrop" onClick={dismiss} aria-hidden="true" />
        <div
          className="tree-details tree-drawer-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="model-tree-heading"
          ref={dialogRef}
        >
          <button
            type="button"
            className="tree-drawer-close"
            data-drawer-close
            onClick={dismiss}
          >
            <span aria-hidden="true">×</span>
            <span className="visually-hidden">Close release details</span>
          </button>
          {details(selected)}
        </div>
      </div>
    );
  }

  return (
    <aside className="tree-details" aria-labelledby="model-tree-heading">
      <p className="visually-hidden" aria-live="polite" aria-atomic="true">
        {selected ? `${selected.release.displayName} selected` : ''}
      </p>
      {selected ? details(selected) : emptyState}
    </aside>
  );
}
