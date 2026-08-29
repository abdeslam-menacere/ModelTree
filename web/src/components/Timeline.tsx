import { startTransition, useEffect, useMemo, useState } from 'react';
import type { TimelineEntry, TimelineFacets, TimelineOrder, TimelineScale } from '../lib/timeline';
import {
  ORDER_LABELS,
  SCALE_LABELS,
  TIMELINE_ORDERS,
  TIMELINE_SCALES,
} from '../lib/timeline';
import {
  ALL_TIME,
  clearAllTimelineFilters,
  clearTimelineFilter,
  defaultTimelineState,
  deriveTimelineResults,
  hasActiveTimelineFilters,
  parseTimelineState,
  serializeTimelineState,
  timelineRangeOptions,
  toggleTimelineFilter,
  TIMELINE_FILTER_DIMENSIONS,
  type TimelineFilterKey,
  type TimelineViewState,
} from '../lib/timeline-view';

interface Props {
  entries: TimelineEntry[];
  facets: TimelineFacets;
  years: string[];
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export default function Timeline({ entries, facets, years }: Props) {
  const [state, setState] = useState<TimelineViewState>(defaultTimelineState());
  const [enhanced, setEnhanced] = useState(false);
  // Null until hydration, because a static build cannot know the reader's date.
  // The server therefore renders the default range, and a relative preset can
  // only be resolved once this is set, so the two markups cannot disagree.
  const [now, setNow] = useState<string | null>(null);

  const ranges = useMemo(() => timelineRangeOptions(years), [years]);
  const results = useMemo(
    () => deriveTimelineResults(entries, state, facets, ranges, now),
    [entries, state, facets, ranges, now],
  );

  // Read the shareable view out of the URL once hydrated, so a reload, a back or
  // forward navigation, or a copied link all restore the same timeline view.
  useEffect(() => {
    const restore = () => {
      startTransition(() => {
        setNow(todayIso());
        setState(parseTimelineState(window.location.search, facets, ranges));
        setEnhanced(true);
      });
    };
    restore();
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, [facets, ranges]);

  function apply(next: TimelineViewState) {
    setState(next);
    if (typeof window === 'undefined') return;
    const query = serializeTimelineState(next, facets);
    window.history.replaceState({}, '', `${window.location.pathname}${query}${window.location.hash}`);
  }

  const noResults = results.total === 0;
  const filtered = hasActiveTimelineFilters(state);

  function facetGroup(key: TimelineFilterKey) {
    const dimension = TIMELINE_FILTER_DIMENSIONS.find((entry) => entry.key === key)!;
    const options = facets[dimension.facet];
    if (!options.length) return null;
    const selected = new Set(state.filters[key]);
    return (
      <fieldset className="timeline-filter-group" key={key}>
        <legend>{dimension.label}</legend>
        <div className="timeline-filter-options">
          {options.map((option) => (
            <label className="timeline-filter-option" key={option.value}>
              <input
                type="checkbox"
                name={dimension.param}
                value={option.value}
                checked={selected.has(option.value)}
                onChange={() => apply(toggleTimelineFilter(state, key, option.value))}
              />
              <span className="timeline-filter-label">{option.label}</span>
              <span className="timeline-filter-count" aria-hidden="true">{option.count}</span>
              <span className="visually-hidden">{option.count} entries</span>
            </label>
          ))}
        </div>
      </fieldset>
    );
  }

  return (
    <section className="model-timeline" data-enhanced={enhanced ? 'true' : 'false'} data-scale={state.scale}>
      <form className="timeline-toolbar" onSubmit={(event) => event.preventDefault()}>
        <div className="timeline-control">
          <label htmlFor="timeline-scale-select">Scale</label>
          <select
            id="timeline-scale-select"
            value={state.scale}
            onChange={(event) => apply({ ...state, scale: event.target.value as TimelineScale })}
          >
            {TIMELINE_SCALES.map((scale) => (
              <option value={scale} key={scale}>{SCALE_LABELS[scale]}</option>
            ))}
          </select>
        </div>
        <div className="timeline-control">
          <label htmlFor="timeline-range-select">Range</label>
          <select
            id="timeline-range-select"
            value={state.range}
            onChange={(event) => apply({ ...state, range: event.target.value })}
          >
            {ranges.map((option) => (
              <option value={option.value} key={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
        <div className="timeline-control">
          <label htmlFor="timeline-order-select">Order</label>
          <select
            id="timeline-order-select"
            value={state.order}
            onChange={(event) => apply({ ...state, order: event.target.value as TimelineOrder })}
          >
            {TIMELINE_ORDERS.map((order) => (
              <option value={order} key={order}>{ORDER_LABELS[order]}</option>
            ))}
          </select>
        </div>
      </form>

      <div className="timeline-body">
        <aside className="timeline-filters" aria-label="Filters">
          <div className="timeline-filters-head">
            <h2>Filters</h2>
            <button
              type="button"
              className="timeline-clear-all"
              onClick={() => apply(clearAllTimelineFilters(state))}
              disabled={!filtered}
            >
              Clear all
            </button>
          </div>
          {TIMELINE_FILTER_DIMENSIONS.map((dimension) => facetGroup(dimension.key))}
        </aside>

        <div className="timeline-results">
          <div className="timeline-results-head">
            <p className="timeline-count" role="status" aria-live="polite">
              {noResults
                ? 'No entries match the current filters'
                : `${results.total} ${results.total === 1 ? 'entry' : 'entries'}`}
              {!noResults && (
                <span className="timeline-range-label"> · {results.range.label}</span>
              )}
            </p>
            {(results.active.length > 0 || state.range !== ALL_TIME) && (
              <ul className="timeline-active-filters" aria-label="Active filters">
                {state.range !== ALL_TIME && (
                  <li>
                    <button
                      type="button"
                      className="timeline-chip"
                      onClick={() => apply({ ...state, range: ALL_TIME })}
                    >
                      <span>Range: {results.range.label}</span>
                      <span className="visually-hidden">, reset to all time</span>
                      <span aria-hidden="true">×</span>
                    </button>
                  </li>
                )}
                {results.active.map((filter) => (
                  <li key={`${filter.key}:${filter.value}`}>
                    <button
                      type="button"
                      className="timeline-chip"
                      onClick={() => apply(clearTimelineFilter(state, filter.key, filter.value))}
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

          {noResults ? (
            <div className="timeline-empty">
              <p>No entries match {filtered ? 'these filters' : 'the dataset'}.</p>
              {filtered && (
                <div className="timeline-empty-actions">
                  {state.range !== ALL_TIME && (
                    <button type="button" onClick={() => apply({ ...state, range: ALL_TIME })}>
                      Clear range: {results.range.label}
                    </button>
                  )}
                  {results.active.map((filter) => (
                    <button
                      type="button"
                      key={`${filter.key}:${filter.value}`}
                      onClick={() => apply(clearTimelineFilter(state, filter.key, filter.value))}
                    >
                      Clear {filter.dimensionLabel}: {filter.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="timeline-clear-all"
                    onClick={() => apply(clearAllTimelineFilters(state))}
                  >
                    Clear all filters
                  </button>
                </div>
              )}
            </div>
          ) : (
            <ol className="timeline-rail">
              {results.stops.map((stop) => (
                <li className="timeline-stop" key={stop.key} data-imprecise={stop.imprecise ? 'true' : 'false'}>
                  <div className="timeline-stop-head">
                    <h2 className="timeline-stop-label">{stop.label}</h2>
                    <span className="timeline-stop-count">
                      {stop.count} {stop.count === 1 ? 'entry' : 'entries'}
                    </span>
                  </div>
                  {stop.note && <p className="timeline-stop-note">{stop.note}</p>}
                  <ol className="timeline-entries">
                    {stop.entries.map((entry) => (
                      <li className="timeline-entry" key={entry.id} data-kind={entry.kind}>
                        <time className="timeline-entry-date" dateTime={entry.date}>
                          {entry.dateLabel}
                        </time>
                        <a className="timeline-entry-name" href={entry.route}>{entry.modelName}</a>
                        <span className="timeline-entry-creator">{entry.creatorName}</span>
                        <span className="timeline-entry-kind">{entry.kindLabel}</span>
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
