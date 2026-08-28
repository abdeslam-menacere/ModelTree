import { startTransition, useEffect, useMemo, useState } from 'react';
import { CalendarDays, CheckCircle2, Cloud } from 'lucide-react';
import { accessLabel, formatNumber, formatReleaseDate, statusLabel } from '../lib/format';
import type { ModelRelease } from '../data/schema';
import type { ProviderReleaseRow } from '../lib/provider-profile';
import {
  createReleaseFilterUrl,
  filterReleaseRows,
  parseReleaseStatusFilter,
  type ReleaseStatusFilter,
} from '../lib/provider-releases';

interface Props {
  rows: ProviderReleaseRow[];
  statuses: ModelRelease['status'][];
}

function countText(count: number) {
  return `${formatNumber(count)} ${count === 1 ? 'release' : 'releases'}`;
}

/**
 * The current/legacy release list on a provider page.
 *
 * The filter is a single selected lifecycle status, or "All", offered only for
 * the statuses this creator actually has a release in. Its selection is written
 * to the URL so a reload, a Back or Forward navigation, and a copied link all
 * restore the same view. The server renders the unfiltered list, so with no
 * JavaScript every release is still present and readable; only the filter
 * buttons need hydration.
 *
 * The buttons are a single-select group: each carries `aria-pressed`, focus is
 * never moved by anything other than the user, and nothing is conveyed by colour
 * alone -- the pressed state is exposed to assistive technology and the count is
 * stated in words.
 */
export default function ProviderReleases({ rows, statuses }: Props) {
  const [filter, setFilter] = useState<ReleaseStatusFilter>('all');

  const options = useMemo<ReleaseStatusFilter[]>(() => ['all', ...statuses], [statuses]);
  const visible = useMemo(() => filterReleaseRows(rows, filter), [rows, filter]);

  useEffect(() => {
    const restore = () => {
      startTransition(() => {
        setFilter(parseReleaseStatusFilter(window.location.search, statuses));
      });
    };
    restore();
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, [statuses.join('\0')]);

  function apply(next: ReleaseStatusFilter) {
    setFilter(next);
    if (typeof window === 'undefined') return;
    window.history.replaceState({}, '', createReleaseFilterUrl(window.location.href, next));
  }

  return (
    <div className="provider-releases">
      <div className="release-filter" role="group" aria-label="Filter releases by lifecycle status">
        {options.map((option) => {
          const selected = option === filter;
          const label = option === 'all' ? 'All' : statusLabel(option);
          return (
            <button
              key={option}
              type="button"
              className="release-filter-option"
              data-selected={selected ? 'true' : 'false'}
              aria-pressed={selected}
              onClick={() => apply(option)}
            >
              {label}
            </button>
          );
        })}
      </div>

      <p className="release-filter-summary" aria-live="polite">
        {filter === 'all'
          ? `Showing all ${countText(visible.length)}.`
          : `Showing ${countText(visible.length)} with status ${statusLabel(filter)}.`}
      </p>

      {visible.length === 0 ? (
        <p className="release-empty">No release with this status is recorded for this creator.</p>
      ) : (
        <ul className="release-list">
          {visible.map(({ release, familyName, route }) => (
            <li className="release-row" key={release.id}>
              <div className="release-headline">
                <a href={route}>{release.displayName}</a>
                <span className="release-status" data-status={release.status}>
                  <CheckCircle2 size={14} aria-hidden="true" /> {statusLabel(release.status)}
                </span>
              </div>
              <p className="release-meta">
                <span>{familyName}</span>
                <span>{release.variant}</span>
                <span>
                  <CalendarDays size={14} aria-hidden="true" />{' '}
                  {formatReleaseDate(release.releaseDate, release.datePrecision)}
                </span>
                <span>
                  <Cloud size={14} aria-hidden="true" /> {accessLabel(release.accessType)}
                </span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
