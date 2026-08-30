import { startTransition, useEffect, useMemo, useState } from 'react';
import type { UpdateFacets, UpdateRecord } from '../lib/updates';
import {
  clearAllUpdateFilters,
  clearUpdateFilter,
  defaultUpdateState,
  deriveUpdateResults,
  hasActiveUpdateFilters,
  hiddenAnchorRecord,
  parseUpdateState,
  serializeUpdateState,
  toggleUpdateFilter,
  UPDATE_FILTER_DIMENSIONS,
  type UpdateFilterKey,
  type UpdateViewState,
} from '../lib/updates-view';

interface Props {
  records: UpdateRecord[];
  facets: UpdateFacets;
}

/**
 * The `/updates` ledger.
 *
 * The default view is the whole ledger, which is what the server renders, so
 * every recorded change and every `#event-…` anchor is present in the static
 * HTML before this component hydrates. Filtering narrows that view and writes
 * itself to the query string; it never fetches, and it can never reveal a record
 * the static page did not already carry.
 *
 * Nothing here animates. The issue asks for an editorial chronology with compact
 * date rails and no auto-playing timeline, so the rails are headings and lists
 * that a screen reader walks in the same order a sighted reader does.
 */
export default function ReleaseUpdates({ records, facets }: Props) {
  const [state, setState] = useState<UpdateViewState>(defaultUpdateState());
  const [enhanced, setEnhanced] = useState(false);
  const [hash, setHash] = useState('');

  const results = useMemo(
    () => deriveUpdateResults(records, state, facets),
    [records, state, facets],
  );

  // Read the shareable view out of the URL once hydrated, so a reload, a back or
  // forward navigation, or a copied link all restore the same ledger view.
  useEffect(() => {
    const restore = () => {
      startTransition(() => {
        setState(parseUpdateState(window.location.search, facets));
        setHash(window.location.hash);
        setEnhanced(true);
      });
    };
    restore();
    window.addEventListener('popstate', restore);
    window.addEventListener('hashchange', restore);
    return () => {
      window.removeEventListener('popstate', restore);
      window.removeEventListener('hashchange', restore);
    };
  }, [facets]);

  function apply(next: UpdateViewState) {
    setState(next);
    if (typeof window === 'undefined') return;
    const query = serializeUpdateState(next, facets);
    // The fragment is preserved: a link to one update that also carries filters
    // must keep pointing at that update while the filters are changed around it.
    window.history.replaceState({}, '', `${window.location.pathname}${query}${window.location.hash}`);
  }

  const filtered = hasActiveUpdateFilters(state);
  const noResults = results.total === 0;

  // A link to one update can carry filters that exclude it. Scrolling to nothing
  // would look like a broken link, so the page says what happened and offers the
  // one action that fixes it.
  const hiddenTarget = hiddenAnchorRecord(hash, records, results.records);

  function facetGroup(key: UpdateFilterKey) {
    const dimension = UPDATE_FILTER_DIMENSIONS.find((entry) => entry.key === key)!;
    const options = facets[dimension.facet];
    if (!options.length) return null;
    const selected = new Set(state.filters[key]);

    return (
      <fieldset className="updates-filter-group" key={key}>
        <legend>{dimension.label}</legend>
        <div className="updates-filter-options">
          {options.map((option) => (
            <label className="updates-filter-option" key={option.value}>
              <input
                type="checkbox"
                name={dimension.param}
                value={option.value}
                checked={selected.has(option.value)}
                onChange={() => apply(toggleUpdateFilter(state, key, option.value))}
              />
              <span className="updates-filter-label">{option.label}</span>
              <span className="updates-filter-count" aria-hidden="true">{option.count}</span>
              <span className="visually-hidden">{option.count} updates</span>
            </label>
          ))}
        </div>
      </fieldset>
    );
  }

  return (
    <section className="release-updates" data-enhanced={enhanced ? 'true' : 'false'}>
      <div className="updates-body">
        <aside className="updates-filters" aria-label="Filters">
          <div className="updates-filters-head">
            <h2>Filters</h2>
            <button
              type="button"
              className="updates-clear-all"
              onClick={() => apply(clearAllUpdateFilters())}
              disabled={!filtered}
            >
              Clear all
            </button>
          </div>
          {UPDATE_FILTER_DIMENSIONS.map((dimension) => facetGroup(dimension.key))}

          <div className="updates-legend">
            <h3>Kinds of change recorded</h3>
            <dl>
              {facets.types.map((type) => (
                <div key={type.value}>
                  <dt>{type.label}</dt>
                  <dd>{type.count}</dd>
                </div>
              ))}
            </dl>
          </div>
        </aside>

        <div className="updates-results">
          <div className="updates-results-head">
            <p className="updates-count" role="status" aria-live="polite">
              {noResults
                ? 'No updates match the current filters'
                : `${results.total} recorded ${results.total === 1 ? 'change' : 'changes'}`}
            </p>
            {results.active.length > 0 && (
              <ul className="updates-active-filters" aria-label="Active filters">
                {results.active.map((filter) => (
                  <li key={`${filter.key}:${filter.value}`}>
                    <button
                      type="button"
                      className="updates-chip"
                      onClick={() => apply(clearUpdateFilter(state, filter.key, filter.value))}
                    >
                      <span>{filter.dimensionLabel}: {filter.label}</span>
                      <span className="visually-hidden">, remove filter</span>
                      <span aria-hidden="true">×</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {hiddenTarget && (
            <p className="updates-hidden-target" role="status">
              The update you linked to — {hiddenTarget.typeLabel}: {hiddenTarget.modelName} — is
              hidden by the current filters.{' '}
              <button
                type="button"
                className="updates-show-target"
                onClick={() => apply(clearAllUpdateFilters())}
              >
                Show it
              </button>
            </p>
          )}

          {noResults ? (
            <div className="updates-empty">
              <p>
                {filtered
                  ? 'No recorded change matches these filters.'
                  : 'No release events are recorded yet. An undated or unsourced change is not published here.'}
              </p>
              {filtered && (
                <button
                  type="button"
                  className="updates-clear-all"
                  onClick={() => apply(clearAllUpdateFilters())}
                >
                  Clear all filters
                </button>
              )}
            </div>
          ) : (
            <ol className="updates-years">
              {results.years.map((year) => (
                <li className="updates-year" key={year.year}>
                  <div className="updates-year-head">
                    <h2 className="updates-year-label">{year.year}</h2>
                    <span className="updates-year-count">
                      {year.count} {year.count === 1 ? 'change' : 'changes'}
                    </span>
                  </div>

                  <ol className="updates-months">
                    {year.months.map((month) => (
                      <li
                        className="updates-month"
                        key={month.key}
                        data-imprecise={month.imprecise ? 'true' : 'false'}
                      >
                        <h3 className="updates-month-label">{month.label}</h3>
                        {month.note && <p className="updates-month-note">{month.note}</p>}

                        <ol className="updates-list">
                          {month.records.map((record) => (
                            <li
                              className="updates-item"
                              key={record.id}
                              id={record.anchorId}
                              data-event-type={record.type}
                            >
                              <div className="updates-item-rail">
                                <time className="updates-item-date" dateTime={record.date}>
                                  {record.dateLabel}
                                </time>
                                <span className="updates-item-type">{record.typeLabel}</span>
                              </div>

                              <div className="updates-item-body">
                                <h4 className="updates-item-model">
                                  <a href={record.modelRoute}>{record.modelName}</a>
                                  <span className="updates-item-creator">{record.creatorName}</span>
                                </h4>

                                <p className="updates-item-note">{record.note}</p>

                                {record.companions.length > 0 && (
                                  <p className="updates-item-companions">
                                    The same announcement also covered{' '}
                                    {record.companions.map((companion, index) => (
                                      <span key={companion.eventId}>
                                        {index > 0 && ', '}
                                        <a href={`#${companion.anchorId}`}>{companion.modelName}</a>
                                      </span>
                                    ))}
                                    . Each is recorded as its own change.
                                  </p>
                                )}

                                <dl className="updates-item-evidence">
                                  <div>
                                    <dt>Source</dt>
                                    <dd>
                                      <ul>
                                        {record.sources.map((source) => (
                                          <li key={source.id}>
                                            <a href={source.url}>{source.title}</a>
                                            {source.publisherName && (
                                              <span className="updates-source-publisher">
                                                {source.publisherName}
                                              </span>
                                            )}
                                          </li>
                                        ))}
                                      </ul>
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>Last checked</dt>
                                    <dd>
                                      <time dateTime={record.verifiedAt}>
                                        {record.verifiedAtLabel}
                                      </time>
                                      <span className="updates-item-hint">
                                        when this record was re-checked, not when the change happened
                                      </span>
                                    </dd>
                                  </div>
                                </dl>

                                <p className="updates-item-permalink">
                                  <a href={`#${record.anchorId}`}>
                                    Link to this update
                                    <span className="visually-hidden">
                                      {': '}{record.typeLabel}: {record.modelName}
                                    </span>
                                  </a>
                                </p>
                              </div>
                            </li>
                          ))}
                        </ol>
                      </li>
                    ))}
                  </ol>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </section>
  );
}
